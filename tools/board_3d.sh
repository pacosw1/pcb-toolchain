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
# Use a static server bound to the tailnet address rather than every interface.
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
  proj=$(node "$root/tools/board3d/metadata.mjs" project "$gj") || { echo "board_3d $b: FAIL gate.json project"; fail=1; continue; }
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
  node "$root/tools/board3d/metadata.mjs" record "$root" "$out" "$b" "$sha" "$missing" || { echo "board_3d $b: FAIL boards.json"; fail=1; continue; }
done
exit $fail
