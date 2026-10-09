#!/bin/sh
# Exploratory export or locally verified release candidate. Never orders or uploads.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
board=${1:?usage: fab-workflow.sh BOARD [explore|release]}
mode=${2:-explore}
case "$mode" in explore|release) ;; *) echo 'invalid export mode' >&2; exit 2;; esac
case "$board" in
  CELLULAR) maker=make-cell-fab.sh; fab=hardware-design/boards/CELLULAR/cad/fab; check=rf_lines.py; config=hardware-design/boards/CELLULAR/rf-lines.json;;
  AC-24V) maker=make-ac24-fab.sh; fab=hardware-design/boards/AC-24V/cad/fab; check=check-ac24-pcb.py; config=;;
  ENV-SENSE) maker=make-env-fab.sh; fab=hardware-design/boards/ENV-SENSE/cad/fab; check=check-env-pcb.py; config=;;
  FIELD-24V-BUS) maker=make-field-24v-bus-fab.sh; fab=hardware-design/boards/FIELD-24V-BUS/cad/fab; check=; config=;;
  BASE-PWR-B) maker=make-base-pwr-b-fab.sh; fab=hardware-design/boards/BASE-PWR/cad/BASE-PWR-B/fab; check=; config=;;
  *) echo 'unsupported board' >&2; exit 2;;
esac
PY=${KICAD_PY:-/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3}
GNC=${GERBERCHECK_PY:-$HOME/.cache/iot-lab/gerbercheck/venv/bin/python}
checks=0
if [ -n "$check" ]; then
  pcb=$(node -e 'const fs=require("fs"),p=require("path"),b=process.argv[1],d=p.join("hardware-design/boards",b);console.log(p.join(d,JSON.parse(fs.readFileSync(p.join(d,"gate.json"))).project)+".kicad_pcb")' "$board")
  if [ -n "$config" ]; then "$PY" "tools/$check" "$pcb" "$config" || checks=$?;
  else "$PY" "tools/$check" "$pcb" || checks=$?; fi
fi
node tools/gate.mjs "$board" --write || checks=$?
if [ "$checks" -ne 0 ] && [ "$mode" = release ]; then
  echo 'release blocked before export: board checks failed' >&2; exit "$checks"
fi
if [ "$mode" = release ]; then
  evidence=$(node tools/check-release-gate.mjs "$board")
  # Staging under the destination parent keeps the final rename on one filesystem.
  parent=$(dirname "$fab")
  stage=$(mktemp -d "$parent/.release-XXXXXXXX")
  trap 'rm -rf "$stage"' EXIT HUP INT TERM
  FAB_OUT="$stage/fab" RENDER_OUT="$stage/renders" sh "tools/$maker"
  GNC_ZIP="$stage/fab/$board-gerber.zip" "$GNC" tools/gerber_netcheck.py "$board"
  node tools/check-release-gate.mjs "$board" "$evidence" "$stage/fab/gate-evidence.json"
  printf 'Locally verified fabrication candidate; no ordering authorization.\n' > "$stage/fab/VERIFIED"
  rm "$stage/fab/EXPLORATORY"
  # Never replace a previous candidate: callers must choose a new name.
  destination=${FAB_RELEASE_OUT:-$parent/release-$(date -u +%Y%m%dT%H%M%SZ)}
  [ ! -e "$destination" ] || { echo 'release destination already exists' >&2; exit 1; }
  mv "$stage" "$destination"
  trap - EXIT HUP INT TERM
  echo "verified candidate: $destination"
else
  sh "tools/$maker"
  GNC_ZIP="$fab/$board-gerber.zip" "$GNC" tools/gerber_netcheck.py "$board" || checks=$?
  echo "exploratory export: $fab (not release qualified)"
  exit "$checks"
fi
