#!/bin/sh
# 3D view of boards for the Mac and the phone (W16, 2026-10-11; audit #741 fixes, CIP 830).
#   sh tools/board_3d.sh BOARD [BOARD...]      (board names as in tools/gate.mjs --list)
# For each board: OUT/<B>-top.png and OUT/<B>-iso.png (kicad-cli pcb render, 3D models through ${IOT_LAB}) and
# OUT/<B>.glb (kicad-cli pcb export glb, then gltf-transform meshopt: 48 MB -> 4 MB for BASE-PWR-B).
# Every producer's exit status is checked; outputs are written to fresh temporary names and published (renamed)
# only when all of a board's steps passed, so a failed run never shows old bytes as new. OUT/boards.json lists each
# board with the sha256 of the board file the files were made from and its gate note. The gate note is "gate at
# target" / "gate NOT at target: ..." only when <board>/gate-metrics.json is complete (schema 2, this board, the core
# metrics present) and its pcb_sha256 equals the board file now; else "gate UNVERIFIED: <reason>".
# The page tools/board3d/index.html (model-viewer: drag, pinch, AR Quick Look on iPhone) is copied to OUT.
# Serve on the tailnet address only (not 0.0.0.0, which listens on every interface):
#   python3 -m http.server 8788 --bind "$(/Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4)" -d OUT
# OUT defaults to /tmp/board-3d (outputs are not tracked: sources only). One line per board: PASS or FAIL + cause.
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
export IOT_LAB="$root"
out=${BOARD3D_OUT:-/tmp/board-3d}
mkdir -p "$out" || exit 1
cp "$root/tools/board3d/index.html" "$out/index.html" || exit 1
fail=0
for b in "$@"; do
  gj="$root/hardware-design/boards/$b/gate.json"
  [ -f "$gj" ] || { echo "board_3d $b: FAIL no $gj"; fail=1; continue; }
  # The board file as tools/gate.mjs finds it: <board>/<gate.json project>.kicad_pcb.
  proj=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['project'])" "$gj") || { echo "board_3d $b: FAIL gate.json project"; fail=1; continue; }
  pcb="$root/hardware-design/boards/$b/$proj.kicad_pcb"
  [ -f "$pcb" ] || { echo "board_3d $b: FAIL no board file $pcb"; fail=1; continue; }
  sha=$(shasum -a 256 "$pcb" | cut -d' ' -f1)
  tmp=$(mktemp -d "$out/.$b.XXXXXX") || exit 1
  log="$tmp/log"
  step() { "$@" >>"$log" 2>&1 || { echo "board_3d $b: FAIL $1 $2 exit $? (see $out/$b.fail.log)"; cp "$log" "$out/$b.fail.log"; rm -rf "$tmp"; fail=1; return 1; }; }
  step kicad-cli pcb render --side top --quality high --width 2000 --height 1600 -o "$tmp/top.png" "$pcb" || continue
  step kicad-cli pcb render --side top --perspective --rotate '-40,0,30' --quality high --width 2000 --height 1600 \
    -o "$tmp/iso.png" "$pcb" || continue
  step kicad-cli pcb export glb --subst-models --include-tracks --include-pads --include-silkscreen \
    --include-soldermask -o "$tmp/raw.glb" "$pcb" || continue
  missing=$(grep -c 'File not found' "$log")
  step npx -y @gltf-transform/cli optimize "$tmp/raw.glb" "$tmp/opt.glb" --compress meshopt --texture-compress false || continue
  for f in top.png iso.png opt.glb; do
    [ -s "$tmp/$f" ] || { echo "board_3d $b: FAIL $f empty"; rm -rf "$tmp"; fail=1; continue 2; }
  done
  mv "$tmp/top.png" "$out/$b-top.png" && mv "$tmp/iso.png" "$out/$b-iso.png" && mv "$tmp/opt.glb" "$out/$b.glb" \
    || { echo "board_3d $b: FAIL publish"; rm -rf "$tmp"; fail=1; continue; }
  rm -rf "$tmp" "$out/$b.fail.log"
  python3 - "$root" "$out" "$b" "$sha" <<'PY' || { echo "board_3d $b: FAIL boards.json"; fail=1; continue; }
import json, os, sys
root, out, b, sha = sys.argv[1:5]
CORE = ('erc_errors', 'drc_errors', 'drc_parity', 'drc_unconnected')
def note():
    p = os.path.join(root, 'hardware-design/boards', b, 'gate-metrics.json')
    try:
        m = json.load(open(p))
    except (OSError, ValueError) as e:
        return f'gate UNVERIFIED: no readable gate-metrics.json ({type(e).__name__})'
    met = m.get('metrics') if isinstance(m, dict) else None
    if m.get('schema_version') != 2 or m.get('board') != b or not isinstance(met, dict):
        return 'gate UNVERIFIED: gate-metrics.json is not schema 2 for this board'
    absent = [k for k in CORE if not isinstance(met.get(k), (int, float))]
    if absent:
        return 'gate UNVERIFIED: metrics missing ' + ', '.join(absent)
    if m.get('pcb_sha256') != sha:
        return 'gate UNVERIFIED: gate-metrics.json is for another version of the board file (stale)'
    opened = {k: v for k, v in met.items() if isinstance(v, (int, float)) and v > 0 and 'warning' not in k}
    return 'gate at target' if not opened else 'gate NOT at target: ' + ', '.join(f'{k} {v}' for k, v in opened.items())
path = os.path.join(out, 'boards.json')
try:
    have = {x['name']: x for x in json.load(open(path))}
except (OSError, ValueError, KeyError, TypeError):
    have = {}
have[b] = dict(name=b, pcb_sha256=sha, note=note())
tmp = path + '.tmp'
json.dump(list(have.values()), open(tmp, 'w'), indent=1)
os.replace(tmp, path)
print(f"board_3d {b}: PASS {os.path.getsize(os.path.join(out, b + '.glb'))} bytes GLB, ", end='')
PY
  echo "$missing 3D models not found; $(python3 -c "import json,sys;print([x['note'] for x in json.load(open(sys.argv[1])) if x['name']==sys.argv[2]][0])" "$out/boards.json" "$b")"
done
exit $fail
