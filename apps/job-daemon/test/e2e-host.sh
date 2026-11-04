#!/bin/bash
# Real containers on the real host, from this machine, over an SSH tunnel. Not part of `npm test`.
#   apps/job-daemon/test/e2e-host.sh [user@host]
# Starts a throw-away daemon from a temp dir (127.0.0.1, non-default port, small budget), runs each scenario and on
# exit stops it, removes its containers and the temp dir. It installs nothing. Ends with one PASS/FAIL line.
set -u
HOST=${1:-root@100.93.34.43}
PORT=18793
RDIR=/tmp/jobd-e2e-$$
HERE=$(cd "$(dirname "$0")/.." && pwd)
STAGE=$(mktemp -d)
FAILS=0
TUNNEL=

export JOBD_URL=http://127.0.0.1:$PORT
export JOBD_TOKEN=$(openssl rand -hex 32)
export PCB_TOOLCHAIN_ROOT=$STAGE   # an empty tools/: these jobs run in/*.sh, and each submit would upload the real one
export IOT_LAB=$STAGE

r() { ssh -o BatchMode=yes "$HOST" "$@"; }
pcb() { node --experimental-strip-types --no-warnings "$HERE/src/client.ts" "$@"; }
ok() { echo "ok    $1"; }
bad() { echo "FAIL  $1"; FAILS=$((FAILS + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: got '$2', want '$3'"; fi; }
state() { pcb status "$1" | sed -n 's/^  "state": "\(.*\)",$/\1/p'; }
attempts() { pcb status "$1" | grep -c '"container"'; }
outcome() { pcb status "$1" | sed -n 's/^    "outcome": "\(.*\)",$/\1/p'; }
wait_state() { # id state seconds
  local i
  for ((i = 0; i < $3 * 2; i++)); do [ "$(state "$1")" = "$2" ] && return 0; sleep 0.5; done
  echo "  state is $(state "$1"), wanted $2"; return 1
}
results() { # id dir: 409 until the cleanup is done
  local i
  for ((i = 0; i < 40; i++)); do pcb results "$1" "$2" 2> /dev/null && return 0; sleep 0.5; done
  echo "  no results for $1"; return 1
}
daemon_start() { r "cd $RDIR && JOBD_TOKEN_FILE=$RDIR/token JOBD_DATA_DIR=$RDIR/data JOBD_PORT=$PORT JOBD_INSTANCE=e2e \
  JOBD_CPU_BUDGET=8 JOBD_MEM_BUDGET_GB=8 JOBD_DEFAULT_CPUS=1 JOBD_DEFAULT_MEM_GB=1 JOBD_RETRY_BACKOFF_S=2 JOBD_TICK_MS=500 \
  JOBD_DEFAULT_DISK_GB=1 JOBD_MIN_FREE_GB=${FLOOR:-5} JOBD_DISK_CHECK_S=1 JOBD_PIDS_LIMIT=64 JOBD_CPU_BUSY_MAX_PCT=${BUSY_MAX:-95} \
  JOBD_CGROUP_PARENT=system.slice nohup node --no-warnings src/main.ts >> daemon.log 2>&1 < /dev/null & echo \$! > $RDIR/daemon.pid"; }
daemon_kill9() { r "kill -9 \$(cat $RDIR/daemon.pid)"; }

cleanup() {
  r "kill \$(cat $RDIR/daemon.pid) 2>/dev/null; docker ps -aq --filter label=pcb-job-daemon=e2e | xargs -r docker rm -f >/dev/null; rm -rf $RDIR"
  [ -z "$TUNNEL" ] || kill "$TUNNEL" 2>/dev/null
  rm -rf "$STAGE"
}
trap cleanup EXIT

# The fixture: an empty board folder and small job scripts.
mkdir -p "$STAGE/board" "$STAGE/jobs" "$STAGE/tools"
echo '{}' > "$STAGE/board/gate.json"
printf 'echo hello; echo result > out/hello.txt\n' > "$STAGE/jobs/hello.sh"
printf 'echo failing; exit 3\n' > "$STAGE/jobs/verdict.sh"
printf 'sleep 60\n' > "$STAGE/jobs/hang.sh"
printf 'tail /dev/zero\n' > "$STAGE/jobs/oom.sh"
printf 'for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo tick $i; sleep 1; done\n' > "$STAGE/jobs/ticks.sh"
printf 'kill -STOP $PPID; sleep 60\n' > "$STAGE/jobs/stoptimer.sh"
printf 'rm -f out/job.log; ln -s /etc/shadow out/job.log; ln -s / out/rootlink; mkfifo out/pipe; sleep 4\n' > "$STAGE/jobs/symlog.sh"
printf 'mv out gone 2>/dev/null; rm -rf out 2>/dev/null; ln -s / out 2>/dev/null; if [ -d out ] && [ ! -L out ]; then echo mount > out/mount.txt; fi\n' > "$STAGE/jobs/swapout.sh"
printf 'for i in $(seq 1 200); do sleep 20 & done; wait\n' > "$STAGE/jobs/forks.sh"
printf 'i=0; while :; do dd if=/dev/urandom of=f$i bs=1M count=10 2>/dev/null; i=$((i+1)); done\n' > "$STAGE/jobs/fill.sh"
printf 'cd /tmp; i=0; while :; do dd if=/dev/urandom of=f$i bs=1M count=10 2>/dev/null; i=$((i+1)); done\n' > "$STAGE/jobs/filllayer.sh"
printf 'dd if=/dev/zero of=big bs=1M count=200\n' > "$STAGE/jobs/bigfile.sh"
printf 'mkdir -m 000 locked; mkdir sub; touch sub/f; chmod 000 sub; ln -s %s/canary out/escape; ln -s %s/canary escape; mkdir out/d; ln -s %s/canary out/d/link; echo ok > out/keep.txt\n' "$RDIR" "$RDIR" "$RDIR" > "$STAGE/jobs/trees.sh"
printf 'exec 3<>a 4<>b 5<>c; rm a b c; for fd in 3 4 5; do dd if=/dev/zero bs=1M count=300 2>/dev/null >&$fd; done; echo unlinked; sleep 60\n' > "$STAGE/jobs/unlinked.sh"
printf 'ulimit -n\n' > "$STAGE/jobs/nofile.sh"
dd if=/dev/zero of="$STAGE/zeros" bs=1048576 count=300 2> /dev/null
job() { echo "--in $STAGE/jobs/$1.sh"; }

r "mkdir -p $RDIR" && scp -q -r "$HERE/src" "$HOST:$RDIR/"
printf '%s' "$JOBD_TOKEN" | r "cat > $RDIR/token; chmod 600 $RDIR/token"
daemon_start
ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -N -L "127.0.0.1:$PORT:127.0.0.1:$PORT" "$HOST" &
TUNNEL=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do pcb status > /dev/null 2>&1 && break; sleep 1; done

echo '# bind and auth'
check 'binds 127.0.0.1 only' "$(r "ss -ltn | grep -c ':$PORT '; ss -ltn | grep -c '127.0.0.1:$PORT '" | tr '\n' ' ')" '1 1 '
check 'no token is a 401' "$(curl -s -o /dev/null -w '%{http_code}' "$JOBD_URL/status")" 401

echo '# passed, results back'
pcb run board $(job hello) --results "$STAGE/r1" -- bash in/hello.sh > "$STAGE/r1.log" 2> /dev/null
check 'exit 0' $? 0
check 'log streamed' "$(cat "$STAGE/r1.log")" hello
check 'result file back' "$(cat "$STAGE/r1/out/hello.txt")" result
check 'job record back' "$(grep -c '"state": "passed"' "$STAGE/r1/job.json")" 1

echo '# tool verdict: failed, no retry'
ID=$(pcb submit board $(job verdict) -- bash in/verdict.sh)
wait_state "$ID" failed 20 && ok 'failed'
check 'one attempt' "$(attempts "$ID")" 1
check 'outcome' "$(outcome "$ID")" command

echo '# real timeout: failed, no retry'
ID=$(pcb submit board $(job hang) --timeout 2 -- bash in/hang.sh)
wait_state "$ID" failed 20 && ok 'failed'
check 'one attempt' "$(attempts "$ID")" 1
check 'outcome' "$(outcome "$ID")" timeout

echo '# real out-of-memory at the job limit: failed, no retry'
ID=$(pcb submit board $(job oom) --mem 0.1 -- bash in/oom.sh)
wait_state "$ID" failed 60 && ok 'failed'
check 'one attempt' "$(attempts "$ID")" 1
check 'outcome' "$(outcome "$ID")" oom

echo '# container killed from outside: retrying, then passed'
ID=$(pcb submit board $(job ticks) -- bash in/ticks.sh)
wait_state "$ID" running 20
sleep 2
r "docker kill pcbjob-$ID-1" > /dev/null
wait_state "$ID" retrying 10 && ok 'retrying'
wait_state "$ID" passed 40 && ok 'passed'
check 'two attempts' "$(attempts "$ID")" 2
check 'attempt 1 was infrastructure' "$(pcb status "$ID" | sed -n 's/^      "outcome": "\(.*\)",$/\1/p' | head -1)" infra
results "$ID" "$STAGE/r5"
check 'attempt 1 log kept' "$(head -1 "$STAGE/r5/attempts/1/out/job.log")" 'tick 1'

echo '# cancel a running job'
ID=$(pcb submit board $(job hang) -- bash in/hang.sh)
wait_state "$ID" running 20
pcb cancel "$ID" > /dev/null
wait_state "$ID" cancelled 15 && ok 'cancelled'
check 'container gone' "$(r "docker ps -aq --filter name=pcbjob-$ID | wc -l" | tr -d ' ')" 0

echo '# budget: limits on the container, and the queue'
A=$(pcb submit board $(job hang) --cpus 6 -- bash in/hang.sh)
B=$(pcb submit board $(job hang) --cpus 6 -- bash in/hang.sh)
wait_state "$A" running 20
sleep 2
check 'second job waits' "$(state "$B")" queued
check 'status says why' "$(pcb status | grep -c 'cpu budget: 6 of 8')" 1
check 'docker hard limit' "$(r "docker inspect -f '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.PidsLimit}} {{.HostConfig.CgroupParent}} {{.HostConfig.NetworkMode}}' pcbjob-$A-1")" \
  '6000000000 1073741824 1073741824 64 system.slice none'
check 'oom score' "$(r "cat /proc/\$(docker inspect -f '{{.State.Pid}}' pcbjob-$A-1)/oom_score_adj")" 1000
pcb cancel "$B" > /dev/null
check 'queued job cancels at once' "$(state "$B")" cancelled
pcb cancel "$A" > /dev/null
wait_state "$A" cancelled 15 && ok 'running job cancelled, budget free'

echo '# client dropped: the job goes on, a new client gets the whole log'
ID=$(pcb submit board $(job ticks) -- bash in/ticks.sh)
pcb watch "$ID" > /dev/null 2>&1 &
W=$!
wait_state "$ID" running 20
sleep 2
kill "$W"
wait "$W" 2> /dev/null
check 'still running' "$(state "$ID")" running
pcb watch "$ID" > "$STAGE/w1.log" 2> /dev/null
check 'watch exit' $? 0
check 'all lines, in order' "$(tr -d '\n' < "$STAGE/w1.log")" 'tick 1tick 2tick 3tick 4tick 5tick 6tick 7tick 8tick 9tick 10tick 11tick 12'

echo '# daemon kill -9 while a job runs: the container lives, the client reconnects, the job passes'
ID=$(pcb submit board $(job ticks) -- bash in/ticks.sh)
wait_state "$ID" running 20
pcb watch "$ID" > "$STAGE/w2.log" 2> /dev/null &
W=$!
sleep 2
daemon_kill9
sleep 2
check 'container survives' "$(r "docker inspect -f '{{.State.Status}}' pcbjob-$ID-1")" running
daemon_start
wait "$W"
check 'watch exit' $? 0
check 'state' "$(state "$ID")" passed
check 'one attempt: picked up, not restarted' "$(attempts "$ID")" 1
check 'all lines, in order' "$(tr -d '\n' < "$STAGE/w2.log")" 'tick 1tick 2tick 3tick 4tick 5tick 6tick 7tick 8tick 9tick 10tick 11tick 12'

echo '# the job ends while the daemon is down; a queued job waits for the restart'
ID=$(pcb submit board $(job hello) -- sleep 8)
wait_state "$ID" running 20
Q=$(pcb submit board $(job hello) --cpus 8 -- bash in/hello.sh)
daemon_kill9
sleep 10
daemon_start
sleep 2
wait_state "$ID" passed 20 && ok 'verdict read after the restart'
check 'one attempt' "$(attempts "$ID")" 1
wait_state "$Q" passed 20 && ok 'queued job ran after the restart'

echo '# hostile: a job stops its own timer; the daemon kills it from its own clock'
ID=$(pcb submit board $(job stoptimer) --timeout 2 -- bash in/stoptimer.sh)
wait_state "$ID" running 20
sleep 6
check 'still alive past its timeout: the timer really is stopped' "$(state "$ID")" running
wait_state "$ID" failed 30 && ok 'failed'
check 'outcome' "$(outcome "$ID")" timeout
check 'the daemon did it' "$(pcb status "$ID" | grep -c 'the daemon killed it')" 3

echo '# hostile: job.log becomes a symlink to /etc/shadow'
ID=$(pcb submit board $(job symlog) -- bash in/symlog.sh)
wait_state "$ID" running 20
sleep 2
check 'nothing from the host in the log' "$(curl -s -H "Authorization: Bearer $JOBD_TOKEN" "$JOBD_URL/jobs/$ID/log?attempt=1" | grep -c root)" 0
wait_state "$ID" passed 20 && ok 'passed'
results "$ID" "$STAGE/r9"
check 'no links or FIFOs in the results' "$(find "$STAGE/r9/out" ! -type f ! -type d | wc -l | tr -d ' ')" 0

echo '# hostile: the job tries to replace out with a symlink'
pcb run board $(job swapout) --results "$STAGE/r10" -- bash in/swapout.sh > /dev/null 2>&1
check 'out is still the mount' "$(cat "$STAGE/r10/out/mount.txt")" mount

echo '# hostile: fork bomb stops at the pids limit'
ID=$(pcb submit board $(job forks) --timeout 4 -- bash in/forks.sh)
wait_state "$ID" failed 40 && ok 'failed'
results "$ID" "$STAGE/r11"
check 'the limit was hit' "$(grep -c -m1 'Resource temporarily unavailable' "$STAGE/r11/out/job.log")" 1

echo '# hostile: disk'
ID=$(pcb submit board $(job fill) --disk 0.05 -- bash in/fill.sh)
wait_state "$ID" failed 40 && ok 'many files in /job: failed'
check 'outcome' "$(outcome "$ID")" disk
check 'one attempt' "$(attempts "$ID")" 1
check 'cause named' "$(pcb status "$ID" | grep -c -m1 'over the 0.05 GB disk limit')" 1
ID=$(pcb submit board $(job filllayer) --disk 0.05 -- bash in/filllayer.sh)
wait_state "$ID" failed 40 && ok 'container layer: failed'
check 'outcome' "$(outcome "$ID")" disk
ID=$(pcb submit board $(job bigfile) --disk 0.05 -- bash in/bigfile.sh)
wait_state "$ID" failed 40 && ok 'one big file: failed'
check 'outcome' "$(outcome "$ID")" disk
ID=$(pcb submit board $(job hello) --in "$STAGE/zeros" --disk 0.05 -- bash in/hello.sh)
wait_state "$ID" failed 40 && ok 'tar bomb (300 MB of zeros): failed at extract'
check 'outcome' "$(outcome "$ID")" disk

echo '# a limit Docker would read as none is refused'
pcb submit board $(job hello) --mem 0.0001 -- bash in/hello.sh > /dev/null 2>&1
check 'exit' $? 2

echo '# cleanup: the cleaner container gets past chmod 000 and takes links, not their targets'
r "mkdir $RDIR/canary; echo alive > $RDIR/canary/file"
ID=$(pcb submit board $(job trees) -- bash in/trees.sh)
wait_state "$ID" passed 20 && ok 'passed'
results "$ID" "$STAGE/r12"
A=$RDIR/data/jobs/$ID/attempts/1
check 'work removed' "$(r "ls -A $A")" out
check 'links gone from out' "$(r "find $A/out -type l | wc -l" | tr -d ' ')" 0
check 'target untouched' "$(r "cat $RDIR/canary/file")" alive
check 'result kept' "$(cat "$STAGE/r12/out/keep.txt")" ok
check 'no cleaner left' "$(r "docker ps -aq --filter label=pcb-job-cleaner=e2e | wc -l" | tr -d ' ')" 0

echo '# open files are capped'
pcb run board $(job nofile) --results "$STAGE/r13" -- bash in/nofile.sh > "$STAGE/r13.log" 2> /dev/null
check 'ulimit -n' "$(cat "$STAGE/r13.log")" 1024

echo '# the real CPU reading holds a job; the reason is on record and the queue bound ends the wait'
r "kill \$(cat $RDIR/daemon.pid)"
BUSY_MAX=0 daemon_start
sleep 2
pcb run board $(job hello) --queue-wait 9 --results "$STAGE/r14" -- bash in/hello.sh > /dev/null 2> "$STAGE/r14.log"
check 'exit 75' $? 75
check 'held on a real reading' "$(grep -c -E 'failed: queued for (9|10) s: host cpu: [0-9]+ % busy, job adds 3 %, limit 0 %' "$STAGE/r14.log")" 1
check 'reason shown while it waits' "$(grep -c -m1 -E '\] queued for [0-9]+ s: host cpu' "$STAGE/r14.log")" 1
check 'reason in the journal' "$(r "grep -c -m1 'queued for [0-9]* s: host cpu' $RDIR/daemon.log")" 1
ID=$(pcb list | tail -1 | cut -d' ' -f1)
check 'never started' "$(attempts "$ID")" 0
check 'outcome' "$(outcome "$ID")" queue
r "kill \$(cat $RDIR/daemon.pid)"
daemon_start
sleep 2

echo '# unlinked files, which du cannot see: the host disk floor kills the job'
AVAIL=$(r "df -k --output=avail $RDIR/data | tail -1")
FLOOR=$(echo "$AVAIL" | awk '{printf "%.2f", $1 / 1048576 - 0.4}')
r "kill \$(cat $RDIR/daemon.pid)"
FLOOR=$FLOOR daemon_start
sleep 2
ID=$(pcb submit board $(job unlinked) --disk 0.35 --mem 2 --timeout 40 -- bash in/unlinked.sh)
wait_state "$ID" failed 30 && ok 'failed'
check 'outcome' "$(outcome "$ID")" disk
check 'cause named' "$(pcb status "$ID" | grep -c -m1 'host disk at')" 1
check 'one attempt' "$(attempts "$ID")" 1
for _ in 1 2 3 4 5 6 7 8 9 10; do [ "$(r "docker ps -aq --filter label=pcb-job-daemon=e2e | wc -l" | tr -d ' ')" = 0 ] && break; sleep 1; done

echo '# nothing left behind by finished jobs'
check 'no containers' "$(r "docker ps -aq --filter label=pcb-job-daemon=e2e | wc -l" | tr -d ' ')" 0

if [ "$FAILS" -eq 0 ]; then echo 'PASS: e2e-host'; else echo "FAIL: e2e-host, $FAILS checks"; exit 1; fi
