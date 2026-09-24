#!/usr/bin/env bash
# Operator-only provisioning. The web app cannot invoke this script.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root to provision the optional host service.' >&2; exit 1; }
app_gid="${JOSI_VOICE_APP_GID:-1000}"
[[ "$app_gid" =~ ^[0-9]{1,9}$ ]] || { echo 'JOSI_VOICE_APP_GID must be a numeric group ID.' >&2; exit 1; }
getent group "$app_gid" >/dev/null || { echo 'The app group must exist on the host.' >&2; exit 1; }
getent group docker >/dev/null || { echo 'Install Docker Engine with its docker group first.' >&2; exit 1; }
command -v python3 >/dev/null
command -v systemctl >/dev/null
/usr/bin/docker compose version >/dev/null
source_dir="$(cd "$(dirname "$0")/../services/voice-box" && pwd)"
id josi-voice-helper >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin josi-voice-helper
install -d -m 0755 /opt/josi-voice-box
install -d -o josi-voice-helper -g "$app_gid" -m 0700 /var/lib/josi-voice-box
for file in host_helper.py settings.py bounded_http.py unix_http.py; do
  install -o root -g root -m 0644 "$source_dir/$file" "/opt/josi-voice-box/$file"
done
# Do not replace an operator-approved catalog with a development checkout.
if [[ ! -e /opt/josi-voice-box/catalog.json ]]; then
  install -o root -g root -m 0644 "$source_dir/catalog.json" /opt/josi-voice-box/catalog.json
fi
unit_file=$(mktemp)
trap 'rm -f "$unit_file"' EXIT
cat > "$unit_file" <<EOF
[Unit]
Description=Josi CE optional Voice Box host helper
After=docker.service
Requires=docker.service

[Service]
User=josi-voice-helper
Group=$app_gid
SupplementaryGroups=docker
ExecStart=/usr/bin/python3 /opt/josi-voice-box/host_helper.py --state /var/lib/josi-voice-box --socket /run/josi-voice-box/helper.sock
Restart=on-failure
RuntimeDirectory=josi-voice-box
RuntimeDirectoryMode=0750
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/josi-voice-box /run/josi-voice-box
RestrictAddressFamilies=AF_UNIX

[Install]
WantedBy=multi-user.target
EOF
install -o root -g root -m 0644 "$unit_file" /etc/systemd/system/josi-voice-box.service
systemctl daemon-reload
systemctl enable --now josi-voice-box.service
echo 'Helper enabled. Mount /run/josi-voice-box into the Josi web service with docker-compose.voice-box.yml.'
echo 'No Voice Box image was published, installed or started by this provisioning script.'
