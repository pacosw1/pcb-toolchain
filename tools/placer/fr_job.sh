#!/bin/bash
# One router score job, run on the Hetzner box by tools/remote.sh (never on the Mac):
#   REMOTE_MEM=8g REMOTE_CPUS=8 tools/remote.sh <board-dir> --in N.kicad_pcb --in N.kicad_pro --in N.kicad_dru \
#       [--in NETS.txt] --in bin/iotplace-linux-x86_64 --in bin/iotroute-linux-x86_64 -- bash tools/placer/fr_job.sh N [NETS.txt]
# GNDVIAS=1: the job's plane vias first (a via next to each SMD pad of net $GNDNET, default GND, to the inner plane).
# iotroute fastroute (F.Cu + B.Cu, timeout $TO, default 00:03:30), then kicad-cli DRC on the result.
# Prints "UNROUTED <all open connections> SUBSET <open connections of the NETS.txt nets> ERRORS <n>".
set -u
N=$1; NETS=${2:-}
mkdir -p out/b
cp in/$N.kicad_pcb in/$N.kicad_pro in/$N.kicad_dru out/b/
chmod +x in/iotroute-linux-x86_64 || exit 1
PLANES=
[ "${GNDVIAS:-}" = 1 ] && PLANES=${GNDNET:-GND}
IFS=: read -r HH MM SS <<< "${TO:-00:03:30}"
in/iotroute-linux-x86_64 fastroute out/b/$N.kicad_pcb out/job --layers F.Cu,B.Cu --skip-net '' --plane-nets "$PLANES" --max-time $((10#$HH * 3600 + 10#$MM * 60 + 10#$SS)) > out/fr.log 2>&1
echo FR_RC $?
cp out/job/routed.kicad_pcb out/$N-r.kicad_pcb
cp in/$N.kicad_pro out/$N-r.kicad_pro; cp in/$N.kicad_dru out/$N-r.kicad_dru
kicad-cli pcb drc --format json -o out/drc.json out/$N-r.kicad_pcb > /dev/null 2>&1
chmod +x in/iotplace-linux-x86_64 || exit 1
if [ -n "$NETS" ]; then
  in/iotplace-linux-x86_64 count out/drc.json --nets "in/$NETS"
else
  in/iotplace-linux-x86_64 count out/drc.json
fi
