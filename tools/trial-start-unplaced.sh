#!/bin/sh
# `setup` step of an agent trial case: reduce a board to its complete schematic start. Footprints and outline stay; parts are unlocked
# except KEEP_REFS (the comma list of `fixed` rule parts); the placement is scrambled from a fixed seed; all tracks and vias go.
# Runs in the route image, so the result is the same on each machine.
#   tools/trial-start-unplaced.sh INPUT.kicad_pcb SEED [KEEP_REFS]     (run with the project as working directory, INPUT relative to it)
set -eu
[ $# -eq 2 ] || [ $# -eq 3 ] || { echo 'usage: trial-start-unplaced.sh INPUT.kicad_pcb SEED [KEEP_REFS]' >&2; exit 2; }
input=$1; seed=$2; keep=${3:-}
here=$(cd "$(dirname "$0")" && pwd -P)
work=.gate/trial-start
rm -rf "$work"; mkdir -p "$work"
"$here/bench-in-route.sh" . sh -c '
  set -e
  input=$1 work=$2 seed=$3 keep=$4
  # The writer copies the whole folder of its input, so the unlocked board has its own folder, outside the output folder.
  free="$work/free/$(basename "$input")"
  mkdir -p "$work/free"
  cp "${input%.kicad_pcb}.kicad_pro" "$work/free/"
  node tools/trial-unlock.ts "$input" "$free" "$keep"
  node tools/placer/place.ts read "$free" -o "$work/prob.json"
  node tools/placer/place.ts scramble "$work/prob.json" -o "$work/scrambled.json" --seed "$seed"
  # The writer measures a move against the problem it reads, so it gets the original problem and the scrambled positions as a candidate.
  node -e "
    const fs = require(\"fs\"), units = JSON.parse(fs.readFileSync(process.argv[1])).units, before = JSON.parse(fs.readFileSync(process.argv[3])).units;
    if (!units.some((unit, index) => unit.x !== before[index].x || unit.y !== before[index].y)) throw new Error(\"trial-start-unplaced: the scramble moved no part\");
    fs.writeFileSync(process.argv[2], JSON.stringify({ candidates: [{ pose: units.map(unit => [unit.x, unit.y, 0]), cost: 0, illegal: [] }] }));
  " "$work/scrambled.json" "$work/pose.json" "$work/prob.json"
  node tools/placer/place.ts write "$free" "$work/prob.json" "$work/pose.json" --outdir "$work/cands"
  # The candidate lies under .gate, so it is not canonical and needs no seal.
  node -e "
    const { execFileSync } = require(\"child_process\"), fs = require(\"fs\"), board = process.argv[1];
    const nets = [...new Set([...fs.readFileSync(board, \"utf8\").matchAll(/^\s*\((?:segment|via)[\s\S]*?\(net (?:\d+ )?(?:\"([^\"]+)\"|([^\")]+))\)/gm)].map(m => m[1] ?? m[2]))];
    if (nets.length) execFileSync(\"node\", [\"tools/pcbtool.ts\", \"unroute\", board, ...nets, \"--no-drc\"], { stdio: \"inherit\" });
  " "$work/cands/cand0/$(basename "$input")"
' sh "$input" "$work" "$seed" "$keep"
cp "$work/cands/cand0/$(basename "$input")" "$input"
rm -rf "$work"
left=$(grep -c -E '^[[:space:]]*\((segment|via|arc)\b' "$input" || true)
[ "$left" -eq 0 ] || { echo "trial-start-unplaced: $left tracks or vias remain in $input" >&2; exit 1; }
