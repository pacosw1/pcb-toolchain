#!/bin/sh
# Installs the PCB Studio web viewer as a launchd user agent (com.pcbstudio.web) and loads it.
# Usage: sh apps/studio/deploy/install-web-viewer.sh
# Overrides: PCBSTUDIO_APP_DIR (app dir with node_modules and out-web), PCBSTUDIO_PROJECT (project to open).
# Re-running is safe: the agent is booted out first, then loaded again. The token file is not touched.
set -eu

LABEL=com.pcbstudio.web
APP_DIR="${PCBSTUDIO_APP_DIR:-/Users/pacosw/code/pcb-toolchain/apps/studio/app}"
PROJECT="${PCBSTUDIO_PROJECT:-/Users/pacosw/code/iot-lab/.claude/worktrees/key-light}"
LOG="$HOME/Library/Logs/pcbstudio-web.log"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
TEMPLATE="$(cd "$(dirname "$0")" && pwd)/com.pcbstudio.web.plist"
DOMAIN="gui/$(id -u)"

NODE=$(command -v node || true)
case "$NODE" in
  /*) ;;
  *) echo "FAIL: node not found on PATH; need an absolute node path" >&2; exit 1 ;;
esac
[ -f "$APP_DIR/out-web/index.html" ] || { echo "FAIL: no web build at $APP_DIR/out-web (run npm run build:web)" >&2; exit 1; }
[ -d "$APP_DIR/node_modules" ] || { echo "FAIL: $APP_DIR/node_modules missing (npm install)" >&2; exit 1; }
[ -d "$PROJECT" ] || { echo "FAIL: project $PROJECT is missing (worktree removed?); not changing it" >&2; exit 1; }

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
sed -e "s|@NODE@|$NODE|g" -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@PROJECT@|$PROJECT|g" \
    -e "s|@HOME@|$HOME|g" -e "s|@LOG@|$LOG|g" "$TEMPLATE" > "$DEST.tmp"
plutil -lint "$DEST.tmp" >/dev/null || { rm -f "$DEST.tmp"; echo "FAIL: generated plist is invalid" >&2; exit 1; }
mv "$DEST.tmp" "$DEST"

# Stop the agent if loaded, then any viewer started by hand (it would hold port 8787).
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
for pid in $(pgrep -f 'engineMain.ts web' || true); do kill -TERM "$pid" 2>/dev/null || true; done
sleep 2

launchctl bootstrap "$DOMAIN" "$DEST"

# Wait for the viewer to answer; 401 without the token is the expected healthy answer.
code=000
for _ in 1 2 3 4 5 6 7 8 9 10; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:8787/ || true)
  [ "$code" = 401 ] && break
  sleep 1
done
if [ "$code" = 401 ]; then
  echo "PASS: $LABEL loaded from $DEST; viewer answers 401 on 127.0.0.1:8787; log $LOG"
else
  echo "FAIL: viewer did not answer 401 on 127.0.0.1:8787 (got $code); see $LOG" >&2
  exit 1
fi
