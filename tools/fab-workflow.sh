#!/bin/sh
# Exploratory export or locally verified release candidate. Never orders or uploads.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
board=${1:?usage: fab-workflow.sh BOARD [explore|release]}
mode=${2:-explore}
case "$mode" in explore|release) ;; *) echo 'invalid export mode' >&2; exit 2;; esac
# The board recipe is the "release" key of its gate.json (tools/release-recipe.mjs).
recipe=$(node tools/release-recipe.mjs "$board" shell) || exit 2
eval "$recipe"
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
  node tools/release-recipe.mjs "$board" run pre "$stage"
fi
checks=0
if [ -n "$check" ]; then
  echo "START: $board board-specific layout check"
  pcb=$(node -e 'const fs=require("fs"),p=require("path"),b=process.argv[1],d=p.join("hardware-design/boards",b);console.log(p.join(d,JSON.parse(fs.readFileSync(p.join(d,"gate.json"))).project)+".kicad_pcb")' "$board")
  if [ -n "$check_json" ] && [ "$mode" = release ]; then "$PY" "$check" "$pcb" --json "$stage/$check_json" || checks=$?;
  elif [ -n "$config" ]; then "$PY" "$check" "$pcb" "$config" || checks=$?;
  else "$PY" "$check" "$pcb" || checks=$?; fi
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
  python3 tools/pcb_timing.py --events "$stage/stages.jsonl" --stage export --category export -- env FAB_OUT="$stage/fab" RENDER_OUT="$stage/renders" sh "$maker"
  python3 tools/pcb_timing.py --events "$stage/stages.jsonl" --stage fab-zip --category export -- python3 tools/check-fab-zip.py "$stage/fab/$board-gerber.zip" "$stage/fab/gerber" > "$stage/fab-zip.json"
  echo "START: $board Gerber connectivity reconstruction"
  net_status=0
  python3 tools/pcb_timing.py --events "$stage/stages.jsonl" --stage gerber-netcheck --category validation -- env GNC_ZIP="$stage/fab/$board-gerber.zip" "$GNC" tools/gerber_netcheck.py "$board" > "$stage/gerber-netcheck.log" 2>&1 || net_status=$?
  cat "$stage/gerber-netcheck.log"
  [ "$net_status" -eq 0 ] || exit "$net_status"
  node tools/release-recipe.mjs "$board" run post "$stage"
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
  sh "$maker"
  GNC_ZIP="$fab/$board-gerber.zip" "$GNC" tools/gerber_netcheck.py "$board" || checks=$?
  echo "exploratory export: $fab (not release qualified)"
  exit "$checks"
fi
