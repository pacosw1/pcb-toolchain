#!/bin/bash
# One router score job, run on the Hetzner box by tools/remote.sh (never on the Mac):
#   REMOTE_MEM=8g REMOTE_CPUS=8 tools/remote.sh <board-dir> --in N.kicad_pcb --in N.kicad_pro --in N.kicad_dru \
#       [--in NETS.txt] -- bash tools/placer/fr_job.sh N [NETS.txt]
# GNDVIAS=1: tools/gnd_pad_vias.py first (a via next to each SMD pad of net $GNDNET, default GND, to the inner
# plane; Freerouting leaves them open).
# Freerouting (tools/freeroute.py, F.Cu + B.Cu, timeout $TO, default 00:03:30), then kicad-cli DRC on the result.
# Prints "UNROUTED <all open connections> SUBSET <open connections of the NETS.txt nets> ERRORS <n>".
set -u
N=$1; NETS=${2:-}
mkdir -p out/b
cp in/$N.kicad_pcb in/$N.kicad_pro in/$N.kicad_dru out/b/
[ "${GNDVIAS:-}" = 1 ] && python3 tools/gnd_pad_vias.py out/b/$N.kicad_pcb out/b/$N.kicad_pcb --net "${GNDNET:-GND}" > out/gv.log 2>&1
python3 tools/freeroute.py out/b/$N.kicad_pcb out/$N-r.kicad_pcb --no-live --timeout ${TO:-00:03:30} > out/fr.log 2>&1
echo FR_RC $?
cp in/$N.kicad_pro out/$N-r.kicad_pro; cp in/$N.kicad_dru out/$N-r.kicad_dru
kicad-cli pcb drc --format json -o out/drc.json out/$N-r.kicad_pcb > /dev/null 2>&1
python3 tools/placer/validate.py count out/drc.json ${NETS:+--nets in/$NETS}
