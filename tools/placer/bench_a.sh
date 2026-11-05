#!/bin/bash
# Proof benchmark A (proxy correlation), driver on the Mac; search and Freerouting run on Hetzner only.
#   IOTPLACE_LINUX=bin/iotplace-linux-x86_64 tools/placer/bench_a.sh BOARD_DIR NAME BOARD PROB OUT [RUNS]
# BOARD  copy with the scored nets stripped; PROB = place.ts read of BOARD.
# 15 placements: base (as is), d1-d4 (default search, 4 seeds), hp (w_cong=0), cg (w_wl=0), c3 (w_cong=3),
# and 7 legal random ones (scramble sigma 5/10/20 mm and uniform, then a search with w_wl=0 w_cong=0).
# Each is written against PROB and routed RUNS times (default 5). Last: bench.ts collect prints the table
# with the proxy cost (default params) and the Spearman correlation vs the median unrouted.
set -eu
BD=$1; N=$2; B=$3; PROB=$4; OUT=$5; RUNS=${6:-5}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
IOTPLACE_LINUX=${IOTPLACE_LINUX:?set IOTPLACE_LINUX to the Linux iotplace binary}
[ "$(basename "$IOTPLACE_LINUX")" = iotplace-linux-x86_64 ] || { echo "IOTPLACE_LINUX must be named iotplace-linux-x86_64" >&2; exit 2; }
NODE="node --no-warnings --experimental-strip-types"
PLACE="$NODE tools/placer/place.ts"
mkdir -p "$OUT"
cd "$REPO"
search() {  # $1 tag, $2 problem, rest: extra run args
  local t=$1 q=$2; shift 2
  REMOTE_MEM=8g REMOTE_CPUS=8 tools/remote.sh "$BD" --in "$q" --in "$IOTPLACE_LINUX" --results "$OUT/$t-search" -- \
    bash tools/placer/remote_run.sh run "in/$(basename "$q")" -o out/res.json --workers 8 --epochs 12 \
    --steps 12000 --top 1 "$@" > "$OUT/$t-search.log" 2>&1 || true
  [ -f "$OUT/$t-search/res.json" ] && $PLACE write "$B" "$PROB" "$OUT/$t-search/res.json" \
    --outdir "$OUT/$t" 2>&1 | grep '^cand' || echo "search $t failed, see $OUT/$t-search.log" >&2
}
scr() {  # $1 tag, $2 seed, $3 sigma or '' (uniform)
  $PLACE scramble "$PROB" -o "$OUT/$1-prob.json" --seed "$2" ${3:+--sigma $3} | tail -1
}
scr s5a 11 5; scr s5b 12 5; scr s10 13 10; scr s20 14 20; scr u1 15 ''; scr u2 16 ''; scr u3 17 ''
R0='--param w_wl=0 w_cong=0'
set -- d1 "$PROB --seed 1" d2 "$PROB --seed 2" d3 "$PROB --seed 3" d4 "$PROB --seed 4" \
  hp "$PROB --seed 1 --param w_cong=0" cg "$PROB --seed 1 --param w_wl=0" c3 "$PROB --seed 1 --param w_cong=3" \
  s5a "$OUT/s5a-prob.json $R0" s5b "$OUT/s5b-prob.json $R0" s10 "$OUT/s10-prob.json $R0" \
  s20 "$OUT/s20-prob.json $R0" u1 "$OUT/u1-prob.json $R0" u2 "$OUT/u2-prob.json $R0" u3 "$OUT/u3-prob.json $R0"
TAGS=base
k=0
while [ $# -gt 0 ]; do
  # shellcheck disable=SC2086
  search "$1" $2 &
  TAGS="$TAGS $1"; shift 2; k=$((k + 1))
  [ $((k % 3)) -eq 0 ] && wait  # 3 searches x 8 CPUs at a time
done
wait
mkdir -p "$OUT/base/cand0"
cp "$(dirname "$B")/$N".kicad_{pcb,pro,dru} "$OUT/base/cand0/"
route() {  # $1 tag, $2 run
  local d=$OUT/$1/cand0
  [ -f "$d/$N.kicad_pcb" ] || return 0
  REMOTE_MEM=8g REMOTE_CPUS=4 tools/remote.sh "$BD" --in "$d/$N.kicad_pcb" --in "$d/$N.kicad_pro" \
    --in "$d/$N.kicad_dru" --in "$IOTPLACE_LINUX" --results "$OUT/$1-r$2" -- bash tools/placer/fr_job.sh "$N" > "$OUT/$1-r$2.log" 2>&1 || true
}
k=0
for t in $TAGS; do for r in $(seq 1 "$RUNS"); do
  route "$t" "$r" &
  k=$((k + 1)); [ $((k % 6)) -eq 0 ] && wait  # 6 jobs x 4 CPUs at a time
done; done
wait
# shellcheck disable=SC2086
$NODE tools/placer/bench.ts collect "$PROB" "$OUT" $TAGS
