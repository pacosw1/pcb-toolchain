#!/bin/sh
# Bench step for a placer arm: scramble the board's placement, run the placer, and leave a project copy whose board is the placed
# candidate, ready for `tools/pcb route` (the next step). The source project is only read; the copy is an APFS/reflink clone.
#   tools/bench-placer-trial.sh PROJECT WORK INPUT SEED [place.ts run options...]
# INPUT is the board path inside PROJECT (suite {input}). Env: PLACER_READ_ARGS (extra `place.ts read` flags), PLACER_SIGMA
# (scramble sigma, default: iotplace's), PLACER_DOMAINS=1 (read with --domain-regions BOARD_DIR/domain-regions.json when that file
# exists; boards without one read as usual), plus what tools/bench-in-route.sh needs. Exit 0 with WORK/proj/INPUT written, else nonzero.
set -eu
[ $# -ge 4 ] || { echo 'usage: bench-placer-trial.sh PROJECT WORK INPUT SEED [place.ts run options...]' >&2; exit 2; }
project=$(cd "$1" && pwd -P); work=$2; input=$3; seed=$4; shift 4
here=$(cd "$(dirname "$0")" && pwd -P)
mkdir -p "$work"; work=$(cd "$work" && pwd -P)
rm -rf "$work/proj"; mkdir -p "$work/proj"
for d in hardware-design tools bin; do   # .gate stays out: the clone gets its own
  [ -e "$project/$d" ] || continue
  cp -cR "$project/$d" "$work/proj/" 2>/dev/null || cp -R "$project/$d" "$work/proj/"
done
# The write step takes prob.json, the problem as read: the scrambled copy has other unit origins, and writing with it moves every
# part twice (a placement the search found legal comes out with courtyard and edge errors).
place=$work/proj/.gate/bench-place   # inside the mounted copy; .gate is never part of a candidate snapshot
mkdir -p "$place"
sigma=${PLACER_SIGMA:+--sigma $PLACER_SIGMA}
read_args=${PLACER_READ_ARGS:-}
regions=$(echo "$input" | cut -d/ -f1-3)/domain-regions.json
if [ "${PLACER_DOMAINS:-}" = 1 ] && [ -f "$work/proj/$regions" ]; then read_args="$read_args --domain-regions $regions"; fi
# shellcheck disable=SC2086
"$here/bench-in-route.sh" "$work/proj" sh -c '
  set -e
  input=$1 place=$2 seed=$3 sigma=$4 read_args=$5; shift 5
  node tools/placer/place.ts read "$input" -o "$place/prob.json" $read_args
  node tools/placer/place.ts scramble "$place/prob.json" -o "$place/scrambled.json" --seed "$seed" $sigma
  node tools/placer/place.ts run "$place/scrambled.json" -o "$place/result.json" --seed "$seed" "$@"
  node tools/placer/place.ts write "$input" "$place/prob.json" "$place/result.json" --outdir "$place/cands"
' sh "$input" "$place" "$seed" "$sigma" "$read_args" "$@" > "$place/placer.log" 2>&1 || { tail -5 "$place/placer.log" >&2; exit 1; }
candidate="$place/cands/cand0/$(basename "$input")"
[ -f "$candidate" ] || { echo "bench-placer-trial: the placer wrote no candidate" >&2; exit 1; }
cp "$candidate" "$work/proj/$input"
echo "placed: $work/proj/$input"
