#!/usr/bin/env bash
# Run one heavy job (Freerouting, pcbtool suggest, a search) on the Hetzner box in a container.
#
#   tools/remote.sh <board-dir> [--in FILE]... [--results DIR] -- <command...>
#
# 1. A new job folder gets tools/ and the design files of <board-dir> (same paths as in the repo).
#    Each --in FILE (any local file, e.g. a scratch board copy) goes to in/<basename>.
# 2. The command runs in the job folder, in the iot-lab-route:10.0-nightly-4fe1ca2060 container (python3 has pcbnew; kicad-cli-nightly serves the board API).
# 3. The command must write its files to out/ (relative). stdout+stderr also go to out/job.log.
# 4. Only out/ comes back, to --results DIR (default $TMPDIR/iot-lab-remote/<job-id>).
#    The Mac board files are never written. Final gates stay on the Mac.
# The exit code is the exit code of the command; a transport error also gives non-zero.
# Exit 75: the job waited REMOTE_QUEUE_WAIT in the daemon's queue and never ran; stderr has the reason. There is no SSH
# retry of it: that path runs on the same box without the budget, so it would go around what held the job.
#
# Env: REMOTE_HOST (user@host, required; the project sets it in .pcb-toolchain.env), REMOTE_CPUS (24), REMOTE_MEM (32g), REMOTE_TIMEOUT (s, 300; exit 124 = timed out: fix placement, do not wait longer),
#      REMOTE_QUEUE_WAIT (s, 3600; the daemon path only. Longest wait for a place; REMOTE_TIMEOUT starts when the job runs),
#      REMOTE_KEEP=1 keeps the remote job folder after success (a failed job folder is always kept).
# Image: tools/remote-route.Dockerfile, built on the box in /srv/iot-lab-route/image. iot-lab-route:10.0-nightly-4fe1ca2060 (tools/remote-route-nightly.Dockerfile) adds the pinned nightly for iotroute board-json.
set -euo pipefail

HOST=${REMOTE_HOST:-}
BASE=/srv/iot-lab-route/jobs
IMAGE=${REMOTE_IMAGE:-iot-lab-route:10.0-nightly-4fe1ca2060}
REPO=$(cd "$(dirname "$0")/.." && pwd)

usage() { echo "usage: tools/remote.sh <board-dir> [--in FILE]... [--results DIR] -- <command...>" >&2; exit 2; }
[ $# -ge 3 ] || usage
BOARD=${1%/}; shift
RESULTS=
INPUTS=()
while [ $# -ge 2 ]; do
  case $1 in
    --results) RESULTS=$2; shift 2 ;;
    --in) [ -f "$2" ] || { echo "remote: no input file $2" >&2; exit 2; }; INPUTS+=("$2"); shift 2 ;;
    *) break ;;
  esac
done
[ "${1:-}" = -- ] || usage
shift
[ $# -ge 1 ] || usage
case $BOARD in /*) BOARD=${BOARD#"$REPO"/} ;; esac
[ -d "$REPO/$BOARD" ] || { echo "remote: no board dir $REPO/$BOARD" >&2; exit 2; }

JOB=$(date +%Y%m%d-%H%M%S)-$$-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')
RDIR=$BASE/$JOB
RESULTS=${RESULTS:-${TMPDIR:-/tmp}/iot-lab-remote/$JOB}
mkdir -p "$RESULTS"
T0=$(date +%s)

# True when the daemon answers with this token within 3 s. Sets CLIENT.
daemon_ready() {
  [ "${REMOTE_NO_DAEMON:-0}" != 1 ] || return 1
  [ -n "${JOBD_URL:-}" ] || JOBD_URL=$(sed -n 's/^JOBD_URL=//p' "$REPO/.pcb-toolchain.env" 2>/dev/null | tail -1)
  [ -n "$JOBD_URL" ] || return 1
  export JOBD_URL JOBD_TOKEN_FILE=${JOBD_TOKEN_FILE:-$HOME/.config/pcb-job/token}
  CLIENT=
  for c in "$REPO/tools/pcb-job/client.ts" "$REPO/apps/job-daemon/src/client.ts"; do
    if [ -f "$c" ]; then CLIENT=$c; break; fi
  done
  [ -n "$CLIENT" ] && [ -r "$JOBD_TOKEN_FILE" ] || return 1
  curl -fsS -m 3 -o /dev/null -H "Authorization: Bearer $(cat "$JOBD_TOKEN_FILE")" "$JOBD_URL/status"
}

# 32g -> 32, 512m -> 0.5: the daemon takes GB.
mem_gb() {
  case $1 in
    *[gG]) echo "${1%?}" ;;
    *[mM]) awk -v m="${1%?}" 'BEGIN { print m / 1024 }' ;;
    *) echo "$1" ;;
  esac
}

if daemon_ready 2>/dev/null; then
  echo "remote: job goes to the daemon $JOBD_URL  results $RESULTS" >&2
  RAW=$(mktemp -d)
  ARGS=("$BOARD")
  for f in ${INPUTS[@]+"${INPUTS[@]}"}; do ARGS+=(--in "$f"); done
  ARGS+=(--cpus "${REMOTE_CPUS:-24}" --mem "$(mem_gb "${REMOTE_MEM:-32g}")" --timeout "${REMOTE_TIMEOUT:-300}" --queue-wait "${REMOTE_QUEUE_WAIT:-3600}" --fit budget --results "$RAW")
  [ -z "${REMOTE_IMAGE:-}" ] || ARGS+=(--image "$REMOTE_IMAGE")
  set +e
  IOT_LAB=$REPO PCB_TOOLCHAIN_ROOT=$REPO node --no-warnings --experimental-strip-types "$CLIENT" run "${ARGS[@]}" -- "$@"
  RC=$?
  set -e
  # Callers read their files from the results folder itself, as on the SSH path: only out/ comes back.
  if [ -d "$RAW/out" ]; then cp -R "$RAW/out/." "$RESULTS/"; fi
  rm -rf "$RAW"
  [ "$RC" != 75 ] || echo "remote: the job never started: it reached the queue bound (the line above has the reason)" >&2
  echo "remote: daemon job  exit $RC  wall $(( $(date +%s) - T0 )) s  results $RESULTS" >&2
  exit $RC
fi

[ -n "$HOST" ] || { echo "remote: no job daemon answered and REMOTE_HOST is not set (project .pcb-toolchain.env)" >&2; exit 2; }
echo "remote: job $JOB  remote $HOST:$RDIR  results $RESULTS" >&2

# One shared SSH connection for all steps of this job.
SSH="ssh -o BatchMode=yes -o ControlMaster=auto -o ControlPath=/tmp/iotr-$$ -o ControlPersist=30"
export RSYNC_RSH=$SSH
$SSH "$HOST" "mkdir -p $RDIR/out $RDIR/in $RDIR/$BOARD"
rsync -a --exclude __pycache__ "$REPO/tools" "$HOST:$RDIR/"
[ ${#INPUTS[@]} -eq 0 ] || rsync -a "${INPUTS[@]}" "$HOST:$RDIR/in/"
# Design files only: no renders, fab outputs, reports or 3D models.
rsync -a --exclude __pycache__ --exclude '.*' --exclude '*.3dshapes' --exclude render --exclude fab --exclude reports \
  --include '*/' --include '*.kicad_pcb' --include '*.kicad_sch' --include '*.kicad_pro' --include '*.kicad_dru' \
  --include '*.kicad_sym' --include '*.kicad_mod' --include '*.json' --include 'fp-lib-table' --include 'sym-lib-table' \
  --exclude '*' --prune-empty-dirs "$REPO/$BOARD/" "$HOST:$RDIR/$BOARD/"

CMD=$(printf '%q ' "$@")
set +e
$SSH "$HOST" "chown -R 1000:1000 $RDIR && docker run --rm --name iot-lab-route-$JOB \
  --cpus ${REMOTE_CPUS:-24} --memory ${REMOTE_MEM:-32g} -v $RDIR:/job -w /job -e TMPDIR=/job/out/tmp \
  $IMAGE bash -c 'mkdir -p out/tmp && timeout -k 10 ${REMOTE_TIMEOUT:-300} \"\$@\" 2>&1 | tee out/job.log; exit \${PIPESTATUS[0]}' _ $CMD"
RC=$?
rsync -a "$HOST:$RDIR/out/" "$RESULTS/"
SYNC=$?
set -e
if [ $RC -eq 0 ] && [ $SYNC -eq 0 ] && [ "${REMOTE_KEEP:-0}" != 1 ]; then
  $SSH "$HOST" "rm -rf $RDIR"
fi
$SSH -O exit "$HOST" 2>/dev/null || true
echo "remote: job $JOB  exit $RC  wall $(( $(date +%s) - T0 )) s  results $RESULTS" >&2
[ $SYNC -eq 0 ] || { echo "remote: result copy failed (rsync $SYNC)" >&2; [ $RC -ne 0 ] || RC=1; }
exit $RC
