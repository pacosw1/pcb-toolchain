#!/bin/sh
# Route-feature benchmark (2026-10-09, user decision: each feature of tools/route-features.json measured with and without).
#   sh tools/route_bench.sh [BOARD ...]       default: AC-24V ENV-SENSE CELLULAR AIO
# Env: BENCH_WORK (default <repo>/.bench, not tracked), BENCH_REPS (2), BENCH_CONFIGS (default: base, each flag alone, all),
#      BENCH_AIO_PASSES (100).
# For each board: one placement (the board build script at the committed spread; the same input for every run), then the
# routing stage of the board flow for each config and repeat, with ROUTE_FEATURES set (all=0 = the current flow):
#   AC-24V tools/ac24_route.py, ENV-SENSE tools/env_route.py, CELLULAR tools/cell_route.py (includes its stitching),
#   AIO tools/aio_route.py + tools/stitch_all.py (the aio_rp_repair loop of the pipeline is not run).
# Each result goes through the real gate: a scratch copy of the board folder hardware-design/boards/_bench_<BOARD>
# (removed at the end) and node tools/gate.mjs _bench_<BOARD> --write. One line per run in $BENCH_WORK/results.jsonl
# (tools/route_bench_report.py makes the report table). No tracked board file is changed.
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
PY=${KICAD_PY:-/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3}
W=${BENCH_WORK:-$root/.bench}
REPS=${BENCH_REPS:-2}
CONFIGS=${BENCH_CONFIGS:-"base triage_opens rule_compiler via_off_small_pads pin_escape_check via_halo all"}
BOARDS=${*:-"AC-24V ENV-SENSE CELLULAR AIO"}
mkdir -p "$W"

place() {   # $1 board, $2 output placed board
  case $1 in
    AC-24V) $PY tools/build-ac24-pcb.py --out "$2" --spread 2.0 ;;
    ENV-SENSE) $PY tools/build-env-pcb.py --out "$2" --spread 1.0 ;;
    CELLULAR) $PY tools/build-cell-pcb.py --out "$2" --spread 1.0 ;;
    AIO) AIO_SPREAD=2.0 AIO_REGION_SPREAD=lr=1,lm=1,ul=1,pi=1.3,rtd=1 $PY tools/build-aio-pcb.py --out "$2" \
           --placement hardware-design/boards/AIO/placement.json ;;
  esac
}

route() {   # $1 board, $2 placed, $3 outdir; prints the routed board path
  case $1 in
    AC-24V) $PY tools/ac24_route.py "$2" "$3" --neck-um 2000 >&2; echo "$3/AC-24V.kicad_pcb" ;;
    ENV-SENSE) $PY tools/env_route.py "$2" "$3" >&2; echo "$3/ENV-SENSE.kicad_pcb" ;;
    CELLULAR) $PY tools/cell_route.py "$2" "$3" >&2; echo "$3/CELLULAR.kicad_pcb" ;;
    AIO) VC=${VIA_COSTS:-300}
         $PY tools/aio_route.py "$2" "$3" --passes "${BENCH_AIO_PASSES:-100}" --route-extra "--set multi-start=16 \
           --set router.scoring.via_costs=$VC --set router.scoring.default_undesired_direction_trace_cost=1.0" >&2
         $PY tools/stitch_all.py "$3/aio.kicad_pcb" --planes hardware-design/boards/AIO/reference-planes.json \
           --via 0.45,0.2 --through-pours SLOT_3V3,AVDD >&2
         echo "$3/aio.kicad_pcb" ;;
  esac
}

for B in $BOARDS; do
  bw="$W/$B"
  mkdir -p "$bw"
  if [ ! -f "$bw/placed.kicad_pcb" ]; then
    place "$B" "$bw/placed.kicad_pcb" > "$bw/place.log" 2>&1 || { echo "$B: placement FAIL (see $bw/place.log)"; continue; }
  fi
  g="hardware-design/boards/_bench_$B"
  proj=$(python3 -c "import json;print(json.load(open('hardware-design/boards/$B/gate.json'))['project'])")
  for c in $CONFIGS; do
    case $c in base) F="all=0" ;; all) F="all=1" ;; *) F="all=0,$c=1" ;; esac
    for r in $(seq 1 "$REPS"); do
      d="$bw/$c-$r"
      rm -rf "$d"; mkdir -p "$d"
      rm -f "hardware-design/boards/$B/.gate/halo-nets.json"   # no learning across runs
      s=$(date +%s)
      out=$(ROUTE_BOARD=$B ROUTE_FEATURES=$F route "$B" "$bw/placed.kicad_pcb" "$d/route" 2> "$d/route.log")
      rc=$?
      secs=$(( $(date +%s) - s ))
      rm -rf "$g"; mkdir -p "$g"
      (cd "hardware-design/boards/$B" && tar cf - --exclude cad/fab --exclude reports --exclude .gate .) | (cd "$g" && tar xf -)
      if [ -f "$out" ]; then
        cp "$out" "$g/$proj.kicad_pcb"
        node tools/gate.mjs "_bench_$B" --write > "$d/gate.log" 2>&1
        cp "$g/gate-metrics.json" "$d/gate-metrics.json" 2>/dev/null
        cp "$out" "$d/routed.kicad_pcb"
        cp -R "$g/.gate" "$d/gate-out" 2>/dev/null
      fi
      $PY tools/route_bench_report.py collect "$B" "$c" "$r" "$secs" "$rc" "$d" >> "$W/results.jsonl"
      echo "$B $c $r: rc $rc ${secs}s $(tail -1 "$W/results.jsonl" | cut -c1-200)"
    done
  done
  rm -rf "$g"
done
python3 tools/route_bench_report.py report "$W/results.jsonl" > "$W/report-table.md"
echo "table: $W/report-table.md"
