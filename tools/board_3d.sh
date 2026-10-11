#!/bin/sh
# 3D view of boards for the Mac and the phone (W16, 2026-10-11).
#   sh tools/board_3d.sh BOARD [BOARD...]      (board names as in tools/gate.mjs --list)
# For each board: OUT/<B>-top.png and OUT/<B>-iso.png (kicad-cli pcb render, 3D models through ${IOT_LAB}) and
# OUT/<B>.glb (kicad-cli pcb export glb, then gltf-transform meshopt: 48 MB -> 4 MB for BASE-PWR-B).
# OUT/boards.json lists the boards with their gate line (<board>/gate-metrics.json: open = metrics above 0).
# The page tools/board3d/index.html (model-viewer: drag, pinch, AR Quick Look on iPhone) is copied to OUT.
# Serve: python3 -m http.server 8788 --bind 0.0.0.0 -d OUT  ->  http://<mac>.<tailnet>.ts.net:8788/
# OUT defaults to /tmp/board-3d (outputs are not tracked: sources only).
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
export IOT_LAB="$root"
out=${BOARD3D_OUT:-/tmp/board-3d}
mkdir -p "$out"
cp "$root/tools/board3d/index.html" "$out/index.html"
for b in "$@"; do
  # The board file as tools/gate.mjs finds it: <board>/<gate.json project>.kicad_pcb.
  proj=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['project'])" "$root/hardware-design/boards/$b/gate.json")
  pcb="hardware-design/boards/$b/$proj.kicad_pcb"
  [ -f "$root/$pcb" ] || { echo "board_3d $b: FAIL no board file $pcb"; exit 1; }
  kicad-cli pcb render --side top --quality high --width 2000 --height 1600 -o "$out/$b-top.png" "$root/$pcb" >/dev/null 2>&1
  kicad-cli pcb render --side top --perspective --rotate '-40,0,30' --quality high --width 2000 --height 1600 \
    -o "$out/$b-iso.png" "$root/$pcb" >/dev/null 2>&1
  missing=$(kicad-cli pcb export glb --force --subst-models --include-tracks --include-pads --include-silkscreen \
    --include-soldermask -o "$out/$b.raw.glb" "$root/$pcb" 2>&1 | grep -c 'File not found' || true)
  npx -y @gltf-transform/cli optimize "$out/$b.raw.glb" "$out/$b.glb" --compress meshopt --texture-compress false >/dev/null 2>&1
  rm -f "$out/$b.raw.glb"
  echo "board_3d $b: PASS $(wc -c < "$out/$b.glb" | tr -d ' ') bytes GLB, $missing 3D models not found"
done
python3 - "$root" "$out" "$@" <<'PY'
import json, os, sys
root, out, boards = sys.argv[1], sys.argv[2], sys.argv[3:]
path = os.path.join(out, 'boards.json')
have = {b['name']: b for b in (json.load(open(path)) if os.path.exists(path) else [])}
for b in boards:
    m = json.load(open(os.path.join(root, 'hardware-design/boards', b, 'gate-metrics.json')))
    m = m.get('metrics', m)
    opened = {k: v for k, v in m.items() if isinstance(v, (int, float)) and v > 0 and 'warning' not in k}
    have[b] = dict(name=b, note='gate at target' if not opened else 'gate NOT at target: ' +
                   ', '.join(f'{k} {v}' for k, v in opened.items()))
json.dump(list(have.values()), open(path, 'w'), indent=1)
PY
