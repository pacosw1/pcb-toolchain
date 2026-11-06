#!/bin/sh
# Bench step for a compaction arm: scramble the board's placement, run compact-cli.ts (search, write, route per step) inside a fixed
# budget, and leave a project copy whose board is the best real-outline (k = 1) step's placement, unrouted, for `tools/pcb route`.
#   tools/bench-compact-trial.sh PROJECT WORK INPUT SEED BUDGET_S [compact-cli.ts options...]
# The arm's options (for example --retain-candidates 3 --route-top 3) go after BUDGET_S. Exit 0 with WORK/proj/INPUT written; exit 1
# when compaction ends without a real-outline placement (the trial is then a failure with no sealed route).
set -eu
[ $# -ge 5 ] || { echo 'usage: bench-compact-trial.sh PROJECT WORK INPUT SEED BUDGET_S [compact-cli.ts options...]' >&2; exit 2; }
project=$(cd "$1" && pwd -P); work=$2; input=$3; seed=$4; budget=$5; shift 5
here=$(cd "$(dirname "$0")" && pwd -P)
mkdir -p "$work"; work=$(cd "$work" && pwd -P)
rm -rf "$work/proj"; mkdir -p "$work/proj"
for d in hardware-design tools bin; do
  [ -e "$project/$d" ] || continue
  cp -cR "$project/$d" "$work/proj/" 2>/dev/null || cp -R "$project/$d" "$work/proj/"
done
# Compaction writes into .gate (never part of a candidate snapshot). The final write uses prob.json, the problem as read.
place=$work/proj/.gate/bench-compact
mkdir -p "$place"
board_dir=$(dirname "$input")
"$here/bench-in-route.sh" "$work/proj" sh -c '
  set -e
  input=$1 place=$2 seed=$3 budget=$4 board_dir=$5; shift 5
  node tools/placer/place.ts read "$input" -o "$place/prob.json"
  node tools/placer/place.ts scramble "$place/prob.json" -o "$place/scrambled.json" --seed "$seed"
  size=$(node -e "const b=JSON.parse(require(\"fs\").readFileSync(process.argv[1])).board.outline;const xs=b.map(p=>p[0]),ys=b.map(p=>p[1]);console.log((Math.max(...xs)-Math.min(...xs)).toFixed(3),(Math.max(...ys)-Math.min(...ys)).toFixed(3))" "$place/prob.json")
  code=0
  node tools/placer/compact-cli.ts "$place/scrambled.json" "$input" --board-dir "$board_dir" --outdir "$place/run" --size $size \
    --budget "$budget" --seed "$seed" "$@" || code=$?
  node -e "
    const fs=require(\"fs\"); const run=JSON.parse(fs.readFileSync(process.argv[1]));
    const best=run.best; if(!best||!best.pose||Math.abs(best.k-1)>1e-9){console.error(\"no real-outline placement (verdict \"+run.verdict+\")\");process.exit(1)}
    fs.writeFileSync(process.argv[2], JSON.stringify({candidates:[{pose:best.pose,cost:0,illegal:[]}]}));
    console.log(\"best step\", run.best_step, \"k\", best.k, \"unrouted\", best.unrouted, \"passed\", best.passed, \"verdict\", run.verdict, \"exit\", process.argv[3]);
  " "$place/run/run.json" "$place/best.json" "$code"
  node tools/placer/place.ts write "$input" "$place/prob.json" "$place/best.json" --outdir "$place/cands"
' sh "$input" "$place" "$seed" "$budget" "$board_dir" "$@" > "$place/compact.log" 2>&1 || { tail -5 "$place/compact.log" >&2; exit 1; }
candidate="$place/cands/cand0/$(basename "$input")"
[ -f "$candidate" ] || { echo "bench-compact-trial: no candidate written" >&2; exit 1; }
cp "$candidate" "$work/proj/$input"
grep '^best step' "$place/compact.log" || true
echo "placed: $work/proj/$input"
