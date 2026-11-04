#!/bin/bash
# Proof benchmark B (known-good recovery), driver on the Mac; search and Freerouting run on Hetzner only.
#   tools/placer/bench_b.sh BOARD_DIR NAME O_BOARD PROB SCR NETS OUT [RUNS]
# BOARD_DIR  repo board folder for tools/remote.sh (read only)
# O_BOARD    copy of the routed board with the signal tracks removed (validate.py strip --keep=<zone nets>)
# PROB       cli.py read of O_BOARD; SCR = cli.py scramble of PROB; NETS = comma list of the signal nets
# Steps: S = legal random placement (search SCR with w_wl=0 w_cong=0); P = placer search from SCR;
# both written against PROB (the writer moves from the original places); then RUNS (default 5)
# Freerouting jobs each for O, S and P. Prints one line per board: UNROUTED / SUBSET per run.
# GNDVIAS=1 GNDNET=FIELD_GND: plane vias for the pads of that net before each Freerouting run.
set -eu
BD=$1; N=$2; OB=$3; PROB=$4; SCR=$5; NETS=$6; OUT=$7; RUNS=${8:-5}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
PY=/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3
WHEEL=${WHEEL:?set WHEEL to the numpy cp313 manylinux wheel}
mkdir -p "$OUT"
cd "$REPO"
search() {  # $1 tag, rest: extra run args
  local t=$1; shift
  REMOTE_MEM=8g REMOTE_CPUS=16 tools/remote.sh "$BD" --in "$SCR" --in "$WHEEL" --results "$OUT/$t-search" -- \
    bash tools/placer/remote_run.sh run "in/$(basename "$SCR")" -o out/res.json --workers 16 --epochs 12 \
    --steps 12000 --seed 3 --top 1 "$@" > "$OUT/$t-search.log" 2>&1 || true
  [ -f "$OUT/$t-search/res.json" ] || { echo "search $t failed, see $OUT/$t-search.log" >&2; exit 3; }
  "$PY" tools/placer/cli.py write "$OB" "$PROB" "$OUT/$t-search/res.json" --outdir "$OUT/$t" 2>&1 | grep '^cand'
}
search S --param w_wl=0 w_cong=0 &
search P &
wait
mkdir -p "$OUT/O/cand0"
cp "$(dirname "$OB")"/*.kicad_{pcb,pro,dru} "$OUT/O/cand0/"
route() {  # $1 board tag, $2 run
  local d=$OUT/$1/cand0
  REMOTE_MEM=8g REMOTE_CPUS=4 tools/remote.sh "$BD" --in "$d/$N.kicad_pcb" --in "$d/$N.kicad_pro" \
    --in "$d/$N.kicad_dru" --in "$NETS" --results "$OUT/$1-r$2" -- \
    env GNDVIAS="${GNDVIAS:-}" GNDNET="${GNDNET:-GND}" bash tools/placer/fr_job.sh "$N" "$(basename "$NETS")" \
    > "$OUT/$1-r$2.log" 2>&1 || true
}
for t in O S P; do for r in $(seq 1 "$RUNS"); do route $t $r & done; wait; done  # 5 jobs x 4 CPUs at a time
for t in O S P; do
  echo "$N $t $(for r in $(seq 1 "$RUNS"); do grep -h '^UNROUTED' "$OUT/$t-r$r.log" | tail -1 | tr '\n' ';'; done)"
done
