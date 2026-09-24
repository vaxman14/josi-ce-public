#!/usr/bin/env python3
"""LAN-only browser controller for a Josi CE appliance installation."""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import shutil
import ssl
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(os.environ["JOSI_INSTALL_ROOT"]).resolve()
STATE = ROOT / "installer-state"
TOKEN_FILE = STATE / "bootstrap-token"
HTML = Path(os.environ.get("JOSI_INSTALLER_HTML", "/opt/josi-installer/index.html")).read_bytes()
PORT = int(os.environ.get("JOSI_INSTALLER_PORT", "8080"))
VERSION = os.environ.get("JOSI_VERSION", "0.1.0")
PROJECT = os.environ.get("JOSI_PROJECT_NAME", "josi-ce")
SESSIONS: dict[str, float] = {}
SESSION_TTL = 15 * 60
LOCK = threading.Lock()
START_LOCK = threading.Lock()
PAIR_LOCK = threading.Lock()
PROGRESS: dict[str, object] = {
    "state": "ready", "message": "Ready to configure Josi", "log": [], "percent": 0, "step": 0, "totalSteps": 5
}


def run(args: list[str], *, check: bool = True, timeout: int = 600) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=ROOT, text=True, capture_output=True, check=check, timeout=timeout)


def verify_public_origin(origin: str, timeout: int = 90) -> None:
    """Prove the browser-facing origin before committing a network change."""
    health = f"{origin.rstrip('/')}/health"
    deadline = time.monotonic() + timeout
    last_error = "public origin did not become reachable"
    while time.monotonic() < deadline:
        try:
            request = urllib.request.Request(health, headers={"User-Agent": "josi-ce-installer-readiness/1"})
            with urllib.request.urlopen(request, timeout=5) as response:
                payload = json.loads(response.read(4096))
                if response.status == 200 and payload.get("ok") is True:
                    return
                last_error = f"public origin health returned HTTP {response.status}"
        except (OSError, ValueError, json.JSONDecodeError, urllib.error.URLError):
            last_error = "public origin DNS, TLS, or routing is not ready"
        time.sleep(1)
    raise RuntimeError(f"{last_error}; the previous network configuration was restored")


def detected_addresses() -> list[str]:
    result = run(["docker", "run", "--rm", "--network", "host", "alpine:3.22", "sh", "-c",
                  "ip -4 route get 1.1.1.1 2>/dev/null"], check=False, timeout=30)
    found: set[str] = set()
    if result.returncode == 0:
        words = result.stdout.split()
        candidates = [words[index + 1] for index, word in enumerate(words[:-1]) if word == "src"]
        for value in candidates:
            try:
                ip = ipaddress.ip_address(value)
            except ValueError:
                continue
            if ip.version == 4 and ip.is_private and not ip.is_loopback and not ip.is_link_local:
                found.add(value)
    return sorted(found)


def occupied_ports() -> dict[int, str]:
    listeners = run(["docker", "run", "--rm", "--network", "host", "alpine:3.22", "netstat", "-lnt"],
                    check=False, timeout=30)
    occupied: dict[int, str] = {}
    for line in listeners.stdout.splitlines():
        fields = line.split()
        if len(fields) < 4 or fields[0] not in {"tcp", "tcp6"}:
            continue
        match = re.search(r":(\d+)$", fields[3])
        if match:
            occupied[int(match.group(1))] = "host service"
    result = run(["docker", "ps", "--format", "{{.Names}}\t{{.Ports}}"], check=False, timeout=15)
    for line in result.stdout.splitlines():
        name, _, ports = line.partition("\t")
        for match in re.finditer(r"(?:0\.0\.0\.0|\[::\]):(\d+)->", ports):
            occupied[int(match.group(1))] = name
    return occupied


DISCOVERY_CACHE: tuple[float, list[str], dict[int, str]] | None = None


def discovery() -> tuple[list[str], dict[int, str]]:
    global DISCOVERY_CACHE
    if DISCOVERY_CACHE is None or DISCOVERY_CACHE[0] < time.time() - 30:
        DISCOVERY_CACHE = (time.time(), detected_addresses(), occupied_ports())
    return DISCOVERY_CACHE[1], DISCOVERY_CACHE[2]


def validate(payload: dict[str, object]) -> dict[str, object]:
    mode = str(payload.get("mode", ""))
    if mode not in {"lan", "domain", "proxy"}:
        raise ValueError("Choose LAN, automatic HTTPS, or existing reverse proxy.")
    http_port = int(payload.get("httpPort", 80))
    https_port = int(payload.get("httpsPort", 443))
    web_port = int(payload.get("webPort", 8081))
    for label, port in (("HTTP", http_port), ("HTTPS", https_port), ("internal web", web_port)):
        if not 1 <= port <= 65535:
            raise ValueError(f"{label} port must be between 1 and 65535.")
    if mode == "lan":
        address = str(payload.get("lanAddress", "")).strip()
        try:
            ip = ipaddress.ip_address(address)
        except ValueError as exc:
            raise ValueError("Enter a valid LAN IPv4 address.") from exc
        if not ip.is_private or ip.is_loopback or ip.is_link_local:
            raise ValueError("LAN address must be a private, non-loopback address.")
        app_url = f"http://{address}" + (f":{http_port}" if http_port != 80 else "")
        domain = ""
    elif mode == "domain":
        domain = str(payload.get("domain", "")).strip().lower().rstrip(".")
        if not re.fullmatch(r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}", domain):
            raise ValueError("Enter a valid fully qualified domain name.")
        app_url = f"https://{domain}" + (f":{https_port}" if https_port != 443 else "")
    else:
        raw = str(payload.get("publicUrl", "")).strip()
        parsed = urlparse(raw)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("Existing proxy URL must be a public HTTPS URL without credentials.")
        if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
            raise ValueError("Existing proxy URL cannot contain a path, query, or fragment.")
        domain = parsed.hostname.lower()
        if not re.fullmatch(r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}", domain):
            raise ValueError("Existing proxy URL must contain a valid public domain.")
        try:
            proxy_port = parsed.port
        except ValueError as exc:
            raise ValueError("Existing proxy URL contains an invalid port.") from exc
        app_url = f"https://{domain}" + (f":{proxy_port}" if proxy_port and proxy_port != 443 else "")
    used = occupied_ports()
    needed = [web_port] if mode == "proxy" else [http_port, https_port]
    conflicts = [{"port": p, "container": used[p]} for p in needed if p in used and not used[p].startswith(PROJECT)]
    workspace_enabled = payload.get("workspaceEnabled") is True
    workspace_path = str(payload.get("workspacePath", "")).strip()
    workspace_mode = str(payload.get("workspaceMode", "ro"))
    if workspace_mode not in {"ro", "rw"}:
        raise ValueError("Developer workspace access must be read-only or read/write.")
    if workspace_enabled:
        if not workspace_path.startswith("/") or "\x00" in workspace_path:
            raise ValueError("Choose an absolute host folder for the developer workspace.")
        resolved = str(Path(workspace_path).resolve())
        forbidden = (
            "/", "/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/proc", "/root",
            "/run", "/sbin", "/sys", "/usr", "/var/lib/containerd", "/var/lib/docker", "/var/log",
            "/var/run",
        )
        if resolved in forbidden or any(resolved.startswith(f"{path}/") for path in forbidden if path != "/"):
            raise ValueError("That system folder cannot be used as a developer workspace.")
        lowered = resolved.lower()
        sensitive_parts = {
            ".aws", ".docker", ".gnupg", ".kube", ".ssh", "credentials", "secrets",
        }
        if any(part in lowered.split("/") for part in sensitive_parts):
            raise ValueError("Credential and secret folders cannot be used as a developer workspace.")
        if resolved == str(ROOT) or str(ROOT).startswith(f"{resolved}/") or resolved.startswith(f"{ROOT}/"):
            raise ValueError("The Josi installation folder cannot also be the developer workspace.")
        probe = ["docker", "run", "--rm", "--mount",
                 f"type=bind,source={resolved},target=/workspace-probe"
                 + (",readonly" if workspace_mode == "ro" else ""), "alpine:3.22", "sh", "-c"]
        command = "test -d /workspace-probe && test -r /workspace-probe"
        if workspace_mode == "rw":
            command += " && p=/workspace-probe/.josi-write-probe-$$ && : > \"$p\" && rm -f \"$p\""
        tested = run(probe + [command], check=False, timeout=30)
        if tested.returncode != 0:
            capability = "read and write" if workspace_mode == "rw" else "read"
            raise ValueError(f"Docker could not {capability} that host folder.")
        workspace_path = resolved
    else:
        workspace_path = ""
    return {"mode": mode, "appUrl": app_url, "domain": domain, "httpPort": http_port,
            "httpsPort": https_port, "webPort": web_port, "conflicts": conflicts,
            "workspaceEnabled": workspace_enabled, "workspacePath": workspace_path,
            "workspaceMode": workspace_mode}


def write_env(plan: dict[str, object], setup_token_sha256: str = "") -> None:
    target = ROOT / ".env"
    values: dict[str, str] = {}
    if target.exists():
        for line in target.read_text().splitlines():
            if line and not line.lstrip().startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                values[key] = value
        backup = ROOT / f".env.pre-browser-{int(time.time())}"
        shutil.copy2(target, backup)
    values.update({
        "JOSI_TAG": values.get("JOSI_TAG", VERSION) if os.environ.get("JOSI_EXISTING_INSTALL") == "1" else VERSION,
        "JOSI_DOMAIN": str(plan["domain"] if plan["mode"] == "domain" else ""),
        "JOSI_APP_URL": str(plan["appUrl"]),
        "JOSI_HTTP_PORT": str(plan["httpPort"]),
        "JOSI_HTTPS_PORT": str(plan["httpsPort"]),
        "JOSI_WEB_PORT": str(plan["webPort"]),
        "JOSI_ACCESS_MODE": str(plan["mode"]),
        "JOSI_INSTALLER_CONFIGURED": "1",
        "JOSI_SETUP_TOKEN_SHA256": setup_token_sha256,
        "JOSI_WORKSPACE_ENABLED": "1" if plan.get("workspaceEnabled") else "0",
        "JOSI_WORKSPACE_HOST_PATH": str(plan.get("workspacePath", "")),
        "JOSI_WORKSPACE_MODE": str(plan.get("workspaceMode", "ro")),
    })
    lines = [f"{key}={value}" for key, value in sorted(values.items())]
    fd, temp_name = tempfile.mkstemp(prefix=".env.", dir=ROOT, text=True)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write("\n".join(lines) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_name, 0o600)
        os.replace(temp_name, target)
        os.chown(target, int(os.environ["JOSI_INSTALL_UID"]), int(os.environ["JOSI_INSTALL_GID"]))
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def progress(message: str, percent: int, step: int) -> None:
    PROGRESS["message"] = message
    PROGRESS["percent"] = percent
    PROGRESS["step"] = step
    log = PROGRESS.setdefault("log", [])
    assert isinstance(log, list)
    log.append({"at": int(time.time()), "message": message})
    del log[:-30]


def provision_voice_helper() -> None:
    uid = os.environ["JOSI_INSTALL_UID"]
    gid = os.environ["JOSI_INSTALL_GID"]
    app_gid = os.environ["JOSI_APP_GID"]
    docker_gid = os.environ["JOSI_DOCKER_GID"]
    image = os.environ["JOSI_INSTALLER_IMAGE"]
    for path, mode in ((ROOT / "voice-helper-state", 0o700), (ROOT / "voice-helper-socket", 0o750)):
        path.mkdir(exist_ok=True)
        os.chmod(path, mode)
        os.chown(path, int(uid), int(gid))
    suffix = hashlib.sha256(str(ROOT).encode()).hexdigest()[:12]
    name = f"josi-ce-voice-helper-{suffix}"
    run(["docker", "rm", "-f", name], check=False, timeout=30)
    run(["docker", "run", "-d", "--name", name, "--restart", "unless-stopped", "--read-only",
         "--network", "none", "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
         "--user", f"{uid}:{gid}", "--group-add", docker_gid, "--group-add", app_gid,
         "--tmpfs", "/tmp:size=16m,mode=1777", "-v", "/var/run/docker.sock:/var/run/docker.sock",
         "-v", f"{ROOT}/voice-helper-state:{ROOT}/voice-helper-state",
         "-v", f"{ROOT}/voice-helper-socket:{ROOT}/voice-helper-socket", "--entrypoint", "python3", image,
         "/opt/josi-voice-box/host_helper.py", "--state", f"{ROOT}/voice-helper-state",
         "--socket", f"{ROOT}/voice-helper-socket/helper.sock", "--runtime-uid", uid,
         "--runtime-gid", gid, "--socket-gid", app_gid], timeout=60)

def provision_storage_helper() -> None:
    uid, gid = os.environ["JOSI_INSTALL_UID"], os.environ["JOSI_INSTALL_GID"]
    app_gid, docker_gid, image = os.environ["JOSI_APP_GID"], os.environ["JOSI_DOCKER_GID"], os.environ["JOSI_INSTALLER_IMAGE"]
    for path, mode in ((ROOT / "storage-helper-state", 0o700), (ROOT / "storage-helper-socket", 0o750)):
        path.mkdir(exist_ok=True); os.chmod(path, mode); os.chown(path, int(uid), int(gid))
    name = f"josi-ce-storage-helper-{hashlib.sha256(str(ROOT).encode()).hexdigest()[:12]}"
    run(["docker","rm","-f",name],check=False,timeout=30)
    run(["docker","run","-d","--name",name,"--restart","unless-stopped","--read-only","--network","none",
         "--security-opt","no-new-privileges","--cap-drop","ALL","--user",f"{uid}:{gid}","--group-add",docker_gid,"--group-add",app_gid,
         "--tmpfs","/tmp:size=16m,mode=1777","-v","/var/run/docker.sock:/var/run/docker.sock","-v",f"{ROOT}:{ROOT}",
         "--entrypoint","python3",image,"/opt/josi-installer/storage_helper.py","--root",str(ROOT),"--state",f"{ROOT}/storage-helper-state",
         "--socket",f"{ROOT}/storage-helper-socket/helper.sock","--image",image,"--socket-gid",app_gid],timeout=60)

def provision_maintenance_helper() -> None:
    uid, gid = os.environ["JOSI_INSTALL_UID"], os.environ["JOSI_INSTALL_GID"]
    app_gid, docker_gid, image = os.environ["JOSI_APP_GID"], os.environ["JOSI_DOCKER_GID"], os.environ["JOSI_INSTALLER_IMAGE"]
    path = ROOT / "maintenance-helper-socket"; path.mkdir(exist_ok=True); os.chmod(path, 0o750); os.chown(path, int(uid), int(gid))
    name = f"josi-ce-maintenance-helper-{hashlib.sha256(str(ROOT).encode()).hexdigest()[:12]}"
    run(["docker","rm","-f",name],check=False,timeout=30)
    run(["docker","run","-d","--name",name,"--restart","unless-stopped","--read-only","--network","none",
         "--security-opt","no-new-privileges","--cap-drop","ALL","--user",f"{uid}:{gid}","--group-add",docker_gid,"--group-add",app_gid,
         "--tmpfs","/tmp:size=16m,mode=1777","-v","/var/run/docker.sock:/var/run/docker.sock","-v",f"{ROOT}:{ROOT}",
         "--entrypoint","python3",image,"/opt/josi-installer/maintenance_helper.py","--root",str(ROOT),
         "--socket",f"{ROOT}/maintenance-helper-socket/helper.sock","--image",image,"--uid",uid,"--gid",gid,
         "--docker-gid",docker_gid,"--socket-gid",app_gid],timeout=60)


def address_metadata(action: str, snapshot=None):
    # Execute with the existing runtime's file-backed DB credential. Only the
    # narrowly selected public metadata travels over stdout/stdin.
    prefix = ["docker", "compose", "-f", str(ROOT / "docker-compose.yml"),
              "--project-directory", str(ROOT), "--project-name", PROJECT,
              "exec", "-T", "web", "node", "--input-type=module", "-e"]
    code = "import {connectFromEnv,loadMasterKey} from '@josi-ce/core'; import {snapshotPublicAddress,restorePublicAddress,verifyPublicAddress,restoreRemotePublicAddress} from './apps/api/dist/setup/publicAddress.js'; const {db,close}=await connectFromEnv(); try {"
    if action == "snapshot":
        code += "console.log(JSON.stringify(await snapshotPublicAddress(db)));"
    elif action == "restore":
        code += "let s='';for await(const c of process.stdin)s+=c;const previous=JSON.parse(s);try{await restoreRemotePublicAddress(db,loadMasterKey(),previous);}finally{await restorePublicAddress(db,previous);}"
    else:
        code += "let s='';for await(const c of process.stdin)s+=c;await verifyPublicAddress(db,loadMasterKey(),process.env.APP_URL,s?JSON.parse(s):null);"
    code += "}finally{await close();}"
    result = subprocess.run(prefix + [code], cwd=ROOT, input=json.dumps(snapshot) if snapshot else None,
                            text=True,capture_output=True,check=True,timeout=30)
    return json.loads(result.stdout) if action == "snapshot" else None


def install(plan: dict[str, object]) -> None:
    with LOCK:
        PROGRESS.update({"state": "installing", "message": "Saving configuration", "log": [],
                         "percent": 8, "step": 1, "totalSteps": 5})
        snapshots = {path: path.read_bytes() if path.exists() else None for path in (
            ROOT / '.env', ROOT / 'docker-compose.workspace.yml', ROOT / 'docker-compose.noproxy.yml')}
        metadata = None
        try:
            if os.environ.get("JOSI_EXISTING_INSTALL") == "1":
                metadata = address_metadata("snapshot")
            setup_token = secrets.token_urlsafe(32)
            setup_token_sha256 = hashlib.sha256(setup_token.encode()).hexdigest()
            write_env(plan, setup_token_sha256)
            write_workspace_override(plan)
            progress("Preparing the isolated Voice Box controller", 22, 2)
            if os.environ.get("JOSI_EXISTING_INSTALL") != "1":
                provision_voice_helper()
                provision_storage_helper()
                provision_maintenance_helper()
            compose = ["docker", "compose", "-f", str(ROOT / "docker-compose.yml")]
            if (ROOT / "docker-compose.workspace.yml").exists():
                compose += ["-f", str(ROOT / "docker-compose.workspace.yml")]
            if plan["mode"] == "proxy":
                compose += ["-f", str(ROOT / "docker-compose.noproxy.yml")]
            compose += ["--project-directory", str(ROOT), "--project-name", PROJECT]
            progress("Pulling pinned Josi images", 45, 3)
            if os.environ.get("JOSI_EXISTING_INSTALL") != "1":
                run(compose + ["pull"], timeout=1800)
            progress("Starting Josi services", 72, 4)
            up = compose + ["up", "-d", "--wait", "--wait-timeout", "300"]
            if plan["mode"] == "proxy":
                up += ["--scale", "caddy=0"]
            run(up, timeout=600)
            progress("Verifying the browser-facing Josi address", 94, 5)
            verify_public_origin(str(plan["appUrl"]))
            address_metadata("verify", metadata)
            PROGRESS.update({"state": "complete", "message": "Installation complete", "percent": 100,
                             "appUrl": f"{plan['appUrl']}/#setup={setup_token}"})
            # Give the browser enough time to receive the handoff, then remove
            # Docker authority from the running installation by exiting.
            threading.Timer(45, lambda: os._exit(0)).start()
        except Exception as exc:
            # Network changes can make the old browser origin disappear before
            # the new one is healthy. Restore the reviewed files and recreate
            # the previous stack before reporting failure.
            rollback_ok = False
            try:
                for path, data in snapshots.items():
                    if data is None: path.unlink(missing_ok=True)
                    else: path.write_bytes(data)
                rollback = ["docker", "compose", "-f", str(ROOT / "docker-compose.yml")]
                if (ROOT / "docker-compose.workspace.yml").exists(): rollback += ["-f", str(ROOT / "docker-compose.workspace.yml")]
                previous_proxy = (ROOT / ".env").exists() and "JOSI_ACCESS_MODE=proxy" in (ROOT / ".env").read_text(errors="replace")
                if previous_proxy:
                    rollback += ["-f", str(ROOT / "docker-compose.noproxy.yml")]
                rollback += ["--project-directory", str(ROOT), "--project-name", PROJECT, "up", "-d", "--wait", "--wait-timeout", "300"]
                if previous_proxy:
                    rollback += ["--scale", "caddy=0"]
                run(rollback, timeout=600)
                if metadata is not None:
                    address_metadata("restore", metadata)
                rollback_ok = True
            except Exception:
                rollback_ok = False
            progress("Installation failed. Review the sanitized error below.",
                     int(PROGRESS.get("percent", 0)), int(PROGRESS.get("step", 0)))
            message = ("The change failed; the previous configuration and runtime were restored."
                       if rollback_ok else
                       "The change failed. Configuration files were restored, but runtime recovery failed. "
                       "Use the local installer to recover the previous stack; do not retry an address change yet.")
            PROGRESS.update({"state": "failed", "error": message, "rollbackComplete": rollback_ok})



def write_workspace_override(plan: dict[str, object]) -> None:
    target = ROOT / "docker-compose.workspace.yml"
    if not plan.get("workspaceEnabled"):
        target.unlink(missing_ok=True)
        return
    source = str(plan["workspacePath"])
    read_only = "true" if plan.get("workspaceMode") == "ro" else "false"
    content = (
        "services:\n"
        "  web:\n"
        "    volumes:\n"
        "      - type: bind\n"
        f"        source: {json.dumps(source)}\n"
        "        target: /workspace\n"
        f"        read_only: {read_only}\n"
        "  worker:\n"
        "    volumes:\n"
        "      - type: bind\n"
        f"        source: {json.dumps(source)}\n"
        "        target: /workspace\n"
        f"        read_only: {read_only}\n"
    )
    fd, temp_name = tempfile.mkstemp(prefix="docker-compose.workspace.", dir=ROOT, text=True)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_name, 0o600)
        os.replace(temp_name, target)
        os.chown(target, int(os.environ["JOSI_INSTALL_UID"]), int(os.environ["JOSI_INSTALL_GID"]))
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


class Handler(BaseHTTPRequestHandler):
    server_version = "JosiInstaller/1"

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"installer: {self.address_string()} {fmt % args}", flush=True)

    def send_json(self, value: object, status: int = 200, *, cookie: str | None = None) -> None:
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authenticated(self) -> bool:
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        value = cookie.get("josi_installer_session")
        if not value:
            return False
        expiry = SESSIONS.get(value.value, 0)
        if expiry <= time.time():
            SESSIONS.pop(value.value, None)
            return False
        SESSIONS[value.value] = time.time() + SESSION_TTL
        return True

    def body(self) -> dict[str, object]:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 32768:
            raise ValueError("Request is too large.")
        value = json.loads(self.rfile.read(length) or b"{}")
        if not isinstance(value, dict):
            raise ValueError("Request must be an object.")
        return value

    def do_GET(self) -> None:
        if self.path == "/":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
            self.send_header("Content-Length", str(len(HTML)))
            self.end_headers()
            self.wfile.write(HTML)
        elif self.path == "/health":
            self.send_json({"ok": True, "version": VERSION})
        elif self.path == "/api/status":
            if not self.authenticated():
                self.send_json({"authenticated": False}, 401)
                return
            addresses, ports = discovery()
            self.send_json({"authenticated": True, "version": VERSION, "addresses": addresses,
                            "occupiedPorts": ports, "existing": os.environ.get("JOSI_EXISTING_INSTALL") == "1",
                            "progress": PROGRESS})
        else:
            self.send_error(404)

    def do_POST(self) -> None:
        if self.headers.get("X-Josi-Installer") != "1":
            self.send_json({"error": "Missing request guard."}, 403)
            return
        try:
            payload = self.body()
            if self.path == "/api/pair":
                supplied = str(payload.get("code", "")).strip()
                with PAIR_LOCK:
                    if not TOKEN_FILE.exists():
                        self.send_json({"error": "This setup code has already been used. Restart the installer to create a new session."}, 409)
                        return
                    expected = TOKEN_FILE.read_text().strip()
                    if not hmac.compare_digest(supplied, expected):
                        time.sleep(0.35)
                        self.send_json({"error": "Setup code is incorrect."}, 403)
                        return
                    token = secrets.token_urlsafe(32)
                    SESSIONS[token] = time.time() + SESSION_TTL
                    # The code authenticates exactly one browser session. A later
                    # maintenance run creates a new code if this controller exits.
                    TOKEN_FILE.unlink(missing_ok=True)
                self.send_json({"ok": True}, cookie=f"josi_installer_session={token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age={SESSION_TTL}")
                return
            if not self.authenticated():
                self.send_json({"error": "Installer session expired."}, 401)
                return
            if self.path == "/api/plan":
                self.send_json(validate(payload))
            elif self.path == "/api/install":
                plan = validate(payload)
                if plan["conflicts"]:
                    self.send_json({"error": "Resolve occupied ports before installing.", "conflicts": plan["conflicts"]}, 409)
                    return
                with START_LOCK:
                    if PROGRESS.get("state") == "installing":
                        self.send_json({"error": "Installation is already running."}, 409)
                        return
                    PROGRESS.update({"state": "installing", "message": "Preparing installation", "log": [],
                                     "percent": 3, "step": 1, "totalSteps": 5})
                    threading.Thread(target=install, args=(plan,), daemon=True).start()
                self.send_json({"ok": True}, 202)
            else:
                self.send_json({"error": "Not found."}, 404)
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json({"error": str(exc)}, 400)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(STATE / "tls.crt", STATE / "tls.key")
    server.socket = context.wrap_socket(server.socket, server_side=True)
    def expire():
        if PROGRESS.get("state") == "installing":
            threading.Timer(30, expire).start()
        else:
            TOKEN_FILE.unlink(missing_ok=True)
            server.shutdown()
    threading.Timer(SESSION_TTL, expire).start()
    server.serve_forever()
