# OCR worker. Built only when the `ocr` profile is selected, so an installation
# that never enables OCR never pulls Tesseract's language data.
#
# Phase 9 fills in the queue consumer. The image exists now so the profile can
# be proven inert, and so enabling it later is a compose flag rather than a
# rebuild of the distribution.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng poppler-utils tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app
USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "-e", "console.log('josi-ce ocr worker: not implemented until Phase 9'); process.exit(0)"]
