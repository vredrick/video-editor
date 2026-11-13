#!/usr/bin/env bash
# VideoHub on a fresh RunPod pod (see README.md here and docs/LINUX.md): system packages live outside /workspace, so every
# new pod needs them again. Safe to run twice. Ends with a version check.
set -euo pipefail
APP=/workspace/videohub/app
source "$APP/runpod/env.sh"
if ! command -v ffmpeg >/dev/null; then
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg fonts-dejavu-core >/dev/null
fi
# Chromium's own libraries (the browser itself is on the volume, in /workspace/webrender/browsers)
(cd /workspace/webrender && npx --yes playwright install-deps chromium >/dev/null 2>&1) || echo "warning: playwright install-deps failed"
# npm packages live on the volume (app/node_modules): only the first pod installs them
[ -d "$APP/node_modules/puppeteer-core" ] || (cd "$APP" && npm install --omit=dev --no-audit --no-fund --force)
echo "node $(node -v)"; ffmpeg -version | head -1
node -e "import('$APP/server/util.js').then(u => console.log('browser', u.TOOLS.chrome || 'MISSING'))" 2>/dev/null
node "$APP/server/cli.js" hub_workspace 2>/dev/null | head -2
