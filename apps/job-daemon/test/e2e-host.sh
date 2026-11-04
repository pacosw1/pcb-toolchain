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
export PCB_TOOLCHAIN_ROOT=$HERE/../..
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
daemon_start() { r "cd $RDIR && JOBD_TOKEN_FILE=$RDIR/token JOBD_DATA_DIR=$RDIR/data JOBD_PORT=$PORT JOBD_INSTANCE=e2e \
  JOBD_CPU_BUDGET=8 JOBD_MEM_BUDGET_GB=8 JOBD_DEFAULT_CPUS=1 JOBD_DEFAULT_MEM_GB=1 JOBD_RETRY_BACKOFF_S=2 JOBD_TICK_MS=500 \
  JOBD_CGROUP_PARENT=system.slice nohup node --no-warnings src/main.ts >> daemon.log 2>&1 < /dev/null & echo \$! > $RDIR/daemon.pid"; }
daemon_kill9() { r "kill -9 \$(cat $RDIR/daemon.pid)"; }

cleanup() {
  r "kill \$(cat $RDIR/daemon.pid) 2>/dev/null; docker ps -aq --filter label=pcb-job-daemon=e2e | xargs -r docker rm -f >/dev/null; rm -rf $RDIR"
  [ -z "$TUNNEL" ] || kill "$TUNNEL" 2>/dev/null
  rm -rf "$STAGE"
}
trap cleanup EXIT

# The fixture: an empty board folder and small job scripts.
mkdir -p "$STAGE/board" "$STAGE/jobs"
echo '{}' > "$STAGE/board/gate.json"
printf 'echo hello; echo result > out/hello.txt\n' > "$STAGE/jobs/hello.sh"
printf 'echo failing; exit 3\n' > "$STAGE/jobs/verdict.sh"
printf 'sleep 60\n' > "$STAGE/jobs/hang.sh"
printf 'tail /dev/zero\n' > "$STAGE/jobs/oom.sh"
printf 'for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo tick $i; sleep 1; done\n' > "$STAGE/jobs/ticks.sh"
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
pcb results "$ID" "$STAGE/r5" 2> /dev/null
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
check 'docker hard limit' "$(r "docker inspect -f '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.CgroupParent}} {{.HostConfig.NetworkMode}}' pcbjob-$A-1")" \
  '6000000000 1073741824 1073741824 system.slice none'
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

echo '# nothing left behind by finished jobs'
check 'no containers' "$(r "docker ps -aq --filter label=pcb-job-daemon=e2e | wc -l" | tr -d ' ')" 0

if [ "$FAILS" -eq 0 ]; then echo 'PASS: e2e-host'; else echo "FAIL: e2e-host, $FAILS checks"; exit 1; fi
