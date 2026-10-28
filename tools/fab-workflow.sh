#!/bin/sh
# Exploratory export or locally verified release candidate. Never orders or uploads.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
board=${1:?usage: fab-workflow.sh BOARD [explore|release]}
mode=${2:-explore}
case "$mode" in explore|release) ;; *) echo 'invalid export mode' >&2; exit 2;; esac
case "$board" in
  BASE-PWR) maker=make-base-pwr-fab.sh; fab=hardware-design/boards/BASE-PWR/cad/fab; check=; config=;;
  CELLULAR) maker=make-cell-fab.sh; fab=hardware-design/boards/CELLULAR/cad/fab; check=rf_lines.py; config=hardware-design/boards/CELLULAR/rf-lines.json;;
  AC-24V) maker=make-ac24-fab.sh; fab=hardware-design/boards/AC-24V/cad/fab; check=check-ac24-pcb.py; config=;;
  ENV-SENSE) maker=make-env-fab.sh; fab=hardware-design/boards/ENV-SENSE/cad/fab; check=check-env-pcb.py; config=;;
  FIELD-24V-BUS) maker=make-field-24v-bus-fab.sh; fab=hardware-design/boards/FIELD-24V-BUS/cad/fab; check=; config=;;
  BASE-PWR-B) maker=make-base-pwr-b-fab.sh; fab=hardware-design/boards/BASE-PWR/cad/BASE-PWR-B/fab; check=; config=;;
  BASE-PWR-C) maker=make-base-pwr-c-fab.sh; fab=hardware-design/boards/BASE-PWR/cad/BASE-PWR-C/fab; check=; config=;;
  AC-24V-C) maker=make-ac24-c-fab.sh; fab=hardware-design/boards/AC-24V/cad/AC-24V-C/fab; check=check-ac24-c-pcb.py; config=;;
  H7-CORE) maker=make-h7-core-fab.sh; fab=hardware-design/boards/H7-CORE/cad/fab; check=; config=;;
  *) echo 'unsupported board' >&2; exit 2;;
esac
PY=${KICAD_PYTHON:-${KICAD_PY:-/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3}}
GNC=${GERBERCHECK_PY:-$HOME/.cache/iot-lab/gerbercheck/venv/bin/python}
export KICAD_PYTHON="$PY"
stage=
if [ "$mode" = release ]; then
  parent=$(dirname "$fab")
  destination=${FAB_RELEASE_OUT:-$parent/release-$(date -u +%Y%m%dT%H%M%SZ)}
  [ ! -e "$destination" ] || { echo 'FAIL: release destination already exists' >&2; exit 2; }
  mkdir -p "$parent"
  if [ -n "${FAB_WORK_DIR:-}" ]; then
    [ ! -e "$FAB_WORK_DIR" ] || { echo 'FAIL: release work directory already exists' >&2; exit 2; }
    mkdir "$FAB_WORK_DIR"
    stage=$FAB_WORK_DIR
  else stage=$(mktemp -d "$parent/.release-XXXXXXXX"); fi
  # Keep failed evidence in the owned run directory. Never erase the diagnosis.
  trap 'code=$?; if [ "$code" -ne 0 ]; then printf "FAIL: release stopped; evidence=%s\n" "$stage" >&2; fi' EXIT
  node --input-type=module -e 'import {releaseInputs} from "./tools/lib/release-evidence.mjs"; console.log(JSON.stringify(releaseInputs(process.cwd(),process.argv[1])))' "$board" > "$stage/release-inputs.json"
  echo 'START: Gerber runtime preflight'
  "$GNC" -c 'import json,sys; from importlib.metadata import version; import gerbonara,shapely,numpy; print(json.dumps({"python":sys.version,"packages":{name:version(name) for name in ("gerbonara","shapely","numpy","click")}}))' > "$stage/gerber-runtime.json"
  echo 'PASS: Gerber runtime preflight'
  if [ "$board" = ENV-SENSE ]; then
    echo 'START: ENV-SENSE schematic semantics'
    python3 tools/check-env-schematic.py > "$stage/env-schematic.log"
    echo 'PASS: ENV-SENSE schematic semantics'
  fi
fi
checks=0
if [ -n "$check" ]; then
  echo "START: $board board-specific layout check"
  pcb=$(node -e 'const fs=require("fs"),p=require("path"),b=process.argv[1],d=p.join("hardware-design/boards",b);console.log(p.join(d,JSON.parse(fs.readFileSync(p.join(d,"gate.json"))).project)+".kicad_pcb")' "$board")
  if [ "$board" = ENV-SENSE ] && [ "$mode" = release ]; then "$PY" "tools/$check" "$pcb" --json "$stage/env-pcb.json" || checks=$?;
  elif [ -n "$config" ]; then "$PY" "tools/$check" "$pcb" "$config" || checks=$?;
  else "$PY" "tools/$check" "$pcb" || checks=$?; fi
fi
if [ "$checks" -ne 0 ] && [ "$mode" = release ]; then
  echo 'FAIL: board-specific checks failed before shared gate' >&2; exit "$checks"
fi
echo "START: $board shared board gate"
if [ "$mode" = release ]; then node tools/gate.mjs "$board" --evidence-dir "$stage/gate" --fresh || checks=$?;
else node tools/gate.mjs "$board" || checks=$?; fi
if [ "$checks" -ne 0 ] && [ "$mode" = release ]; then
  echo 'FAIL: release blocked before export: board checks failed' >&2; exit "$checks"
fi
if [ "$mode" = release ]; then
  evidence=$(node tools/check-release-gate.mjs "$board" --gate-dir "$stage/gate")
  echo "START: $board staged fabrication export"
  python3 tools/pcb_timing.py --events "$stage/stages.jsonl" --stage export --category export -- env FAB_OUT="$stage/fab" RENDER_OUT="$stage/renders" sh "tools/$maker"
  python3 tools/pcb_timing.py --events "$stage/stages.jsonl" --stage fab-zip --category export -- python3 tools/check-fab-zip.py "$stage/fab/$board-gerber.zip" "$stage/fab/gerber" > "$stage/fab-zip.json"
  echo "START: $board Gerber connectivity reconstruction"
  net_status=0
  python3 tools/pcb_timing.py --events "$stage/stages.jsonl" --stage gerber-netcheck --category validation -- env GNC_ZIP="$stage/fab/$board-gerber.zip" "$GNC" tools/gerber_netcheck.py "$board" > "$stage/gerber-netcheck.log" 2>&1 || net_status=$?
  cat "$stage/gerber-netcheck.log"
  [ "$net_status" -eq 0 ] || exit "$net_status"
  if [ "$board" = BASE-PWR ]; then
    echo 'START: BASE-PWR board-specific staged audit'
    node tools/check-base-pwr-pcb.mjs --fab-dir "$stage/fab" --render-dir "$stage/audit" --gate-dir "$stage/gate" > "$stage/base-pwr-audit.log"
    echo 'PASS: BASE-PWR board-specific staged audit'
  fi
  node tools/check-release-gate.mjs "$board" "$evidence" "$stage/fab/gate-evidence.json" --gate-dir "$stage/gate"
  printf 'Locally verified fabrication candidate; no ordering authorization.\n' > "$stage/fab/VERIFIED"
  rm "$stage/fab/EXPLORATORY"
  node tools/check-release-fab.mjs "$board" "$stage" "$stage/release-inputs.json"
  # A second contender must not cause mv to nest into an existing candidate.
  [ ! -e "$destination" ] || { echo 'FAIL: release destination already exists' >&2; exit 2; }
  python3 tools/publish-release.py "$stage" "$destination"
  trap - EXIT
  echo "PASS: CAD/fabrication candidate verified; packet/stock/assembly readiness is separate; evidence=$destination"
else
  sh "tools/$maker"
  GNC_ZIP="$fab/$board-gerber.zip" "$GNC" tools/gerber_netcheck.py "$board" || checks=$?
  echo "exploratory export: $fab (not release qualified)"
  exit "$checks"
fi
