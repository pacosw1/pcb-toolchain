#!/bin/sh
# TraceMaker benchmark (2026-10-08). Usage: tools/tracemaker_bench.sh BOARD [TAG] [extra tracemaker route options...]
# Run it in a scratch worktree (git worktree add --detach /tmp/tm-bench HEAD), never in the main tree: it overwrites
# the board's .kicad_pcb in the cwd tree with the routed copy, then runs the gate (no --write).
# Steps: strip all tracks/vias (keep zones) -> tracemaker route -> refill zones -> metrics -> gate.
# Env: TM=path to tracemaker (default ~/opt/tracemaker/build/macos-metal/src/app/tracemaker), OUT=work dir.
# Layer rules: BASE-PWR no tracks on In1.Cu (solid GND); AIO no tracks on In1/In2 (islands, planes).
set -e
cd "$(dirname "$0")/.."
BOARD=$1; TAG=${2:-run1}; shift; shift || true
TM=${TM:-$HOME/opt/tracemaker/build/macos-metal/src/app/tracemaker}
PY=${KICAD_PYTHON:-/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3}
CLI=${KICAD_CLI:-/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli}
D=hardware-design/boards/$BOARD/cad/$BOARD
P=$D/$BOARD.kicad_pcb
OUT=${OUT:-/tmp/tmb}/$BOARD-$TAG
case $BOARD in BASE-PWR) NT=${NT:-In1.Cu};; AIO) NT=${NT:-In1.Cu,In2.Cu};; *) NT=In1.Cu;; esac
rm -rf "$OUT"; mkdir -p "$OUT"
cp "$P" "$OUT/orig.kicad_pcb"
# metrics + strip helper
cat > "$OUT/m.py" <<'PYE'
import sys, json, pcbnew
mode, src = sys.argv[1], sys.argv[2]
b = pcbnew.LoadBoard(src)
if mode == 'strip':
    n = 0
    for t in list(b.GetTracks()):
        b.Remove(t); n += 1
    pcbnew.SaveBoard(sys.argv[3], b); print('stripped', n)
else:
    tr = [t for t in b.GetTracks() if t.GetClass() != 'PCB_VIA']
    vias = [t for t in b.GetTracks() if t.GetClass() == 'PCB_VIA']
    ln = sum(pcbnew.ToMM(t.GetLength()) for t in tr)
    byl = {}
    for t in tr:
        byl[t.GetLayerName()] = byl.get(t.GetLayerName(), 0) + pcbnew.ToMM(t.GetLength())
    print(json.dumps({'tracks': len(tr), 'vias': len(vias), 'track_len_mm': round(ln, 1),
                      'by_layer_mm': {k: round(v, 1) for k, v in byl.items()}}))
PYE
$PY "$OUT/m.py" strip "$OUT/orig.kicad_pcb" "$OUT/in.kicad_pcb"
cp "$D/$BOARD.kicad_pro" "$OUT/in.kicad_pro"; cp "$D/$BOARD.kicad_dru" "$OUT/in.kicad_dru"
S=$(date +%s)
"$TM" route "$OUT/in.kicad_pcb" -o "$OUT/routed.kicad_pcb" --time ${TM_TIME:-300} --threads ${TM_THREADS:-8} \
  --no-tracks-on $NT --soft-zones --diff-pairs "$@" > "$OUT/tracemaker.log" 2>&1 || true
E=$(date +%s); echo "tracemaker_wall_s $((E-S))" | tee "$OUT/time.txt"
grep -i -E "gpu|metal|connect|unrouted|routed|via" "$OUT/tracemaker.log" | tail -12
cp "$OUT/in.kicad_pro" "$OUT/routed.kicad_pro"; cp "$OUT/in.kicad_dru" "$OUT/routed.kicad_dru"
# Same post-route step as our pipelines: ground stitching vias for RP-001 (STITCH=0 to skip).
if [ "${STITCH:-1}" = 1 ]; then
  case $BOARD in AIO) SV="--via 0.45,0.2 --through-pours SLOT_3V3,AVDD";; *) SV="";; esac
  $PY tools/stitch_all.py "$OUT/routed.kicad_pcb" --planes hardware-design/boards/$BOARD/reference-planes.json $SV \
    > "$OUT/stitch.log" 2>&1 || true
  tail -3 "$OUT/stitch.log"
fi
"$CLI" pcb drc --refill-zones --save-board --format json -o "$OUT/drc-refill.json" "$OUT/routed.kicad_pcb" >/dev/null 2>&1 || true
$PY "$OUT/m.py" metrics "$OUT/routed.kicad_pcb" | tee "$OUT/metrics.json"
echo "committed:"; $PY "$OUT/m.py" metrics "$OUT/orig.kicad_pcb"
cp "$OUT/routed.kicad_pcb" "$P"
node tools/gate.mjs "$BOARD" 2>&1 | tee "$OUT/gate.txt" | tail -40
cp "$OUT/orig.kicad_pcb" "$P"
