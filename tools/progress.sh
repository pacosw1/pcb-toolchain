#!/bin/zsh
# Board progress view. Run in a side terminal:
#   tools/progress.sh          one snapshot
#   tools/progress.sh --watch  refresh every 120 s
# Each snapshot runs DRC with parity on a copy of each board folder (the board files are not changed)
# and adds one line per board to hardware-design/reports/progress-log.csv, so the trend is visible.
ROOT=${0:A:h:h}
BOARDS=(BACKUP-POWER BASE-PWR INPUT-4D2A)
LOG=$ROOT/hardware-design/reports/progress-log.csv

snapshot() {
  local now=$(date +%H:%M:%S) tmp=$(mktemp -d) pcb r u e p dirty ago last
  print "== board progress $now =="
  printf "%-13s %6s %6s %6s %5s  %-8s %s\n" BOARD UNCONN ERRORS PARITY DIRTY LAST_AGO LAST_COMMIT
  for b in $BOARDS; do
    pcb=$(ls $ROOT/hardware-design/boards/$b/cad/*/$b.kicad_pcb 2>/dev/null | head -1)
    [[ -z $pcb ]] && { print "$b: board file not found"; continue; }
    cp -R ${pcb:h} $tmp/$b
    kicad-cli pcb drc --schematic-parity --refill-zones --format json -o $tmp/$b.json $tmp/$b/${pcb:t} >/dev/null 2>&1
    r=$(python3 -c "import json;d=json.load(open('$tmp/$b.json'));v=d['violations'];print(len(d['unconnected_items']),sum(x['severity']=='error' for x in v),len(d['schematic_parity']))" 2>/dev/null || echo "? ? ?")
    read u e p <<< "$r"
    dirty=$(git -C $ROOT status --porcelain -- ${pcb} | wc -l | tr -d ' ')
    ago=$(git -C $ROOT log -1 --format=%cr -- hardware-design/boards/$b | sed 's/ minutes\{0,1\}/m/;s/ hours\{0,1\}/h/;s/ ago//')
    last=$(git -C $ROOT log -1 --format='%h %s' -- hardware-design/boards/$b | cut -c1-60)
    printf "%-13s %6s %6s %6s %5s  %-8s %s\n" $b $u $e $p $dirty $ago "$last"
    [[ -f $LOG ]] || print "time,board,unconnected,errors,parity" > $LOG
    print "$(date +%F\ %T),$b,$u,$e,$p" >> $LOG
  done
  rm -rf $tmp
  print "\nFreerouting runs active: $(pgrep -f freerouting-2.1.0 | wc -l | tr -d ' ')"
  print "Trend (unconnected, last 6 snapshots per board):"
  for b in $BOARDS; do
    print "  $b: $(grep ",$b," $LOG | tail -6 | cut -d, -f3 | tr '\n' ' ')"
  done
}

if [[ $1 == --watch ]]; then
  while true; do clear; snapshot; sleep 120; done
else
  snapshot
fi
