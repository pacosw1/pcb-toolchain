#!/usr/bin/env bash
# Run one heavy job (Freerouting, pcbtool suggest, a search) on the Hetzner box in a container.
#
#   tools/remote.sh <board-dir> [--in FILE]... [--results DIR] -- <command...>
#
# 1. A new job folder gets tools/ and the design files of <board-dir> (same paths as in the repo).
#    Each --in FILE (any local file, e.g. a scratch board copy) goes to in/<basename>.
# 2. The command runs in the job folder, in the iot-lab-route:10.0 container (python3 has pcbnew).
# 3. The command must write its files to out/ (relative). stdout+stderr also go to out/job.log.
# 4. Only out/ comes back, to --results DIR (default $TMPDIR/iot-lab-remote/<job-id>).
#    The Mac board files are never written. Final gates stay on the Mac.
# The exit code is the exit code of the command; a transport error also gives non-zero.
#
# Env: REMOTE_HOST (root@100.64.0.2), REMOTE_CPUS (24), REMOTE_MEM (32g), REMOTE_TIMEOUT (s, 300; exit 124 = timed out: fix placement, do not wait longer),
#      REMOTE_KEEP=1 keeps the remote job folder after success (a failed job folder is always kept).
# Image: tools/remote-route.Dockerfile, built on the box in /srv/iot-lab-route/image.
set -euo pipefail

HOST=${REMOTE_HOST:-root@100.64.0.2}
BASE=/srv/iot-lab-route/jobs
IMAGE=iot-lab-route:10.0
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
echo "remote: job $JOB  remote $HOST:$RDIR  results $RESULTS" >&2
T0=$(date +%s)

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
