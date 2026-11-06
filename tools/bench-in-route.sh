#!/bin/sh
# Run one command in the pinned route image on this machine, with the project mounted at the same path, so a bench arm can route
# on a Mac (x86_64 under emulation). The image must already be loaded: iot-lab-route:10.0-nightly-4fe1ca2060 (see bench-local.md).
#   tools/bench-in-route.sh PROJECT COMMAND...
# Env: BENCH_TOOLCHAIN (an installed toolchain's bin, with node-linux-x86_64, iotroute-linux-x86_64, iotplace-linux-x86_64),
#      BENCH_CPUS (2), BENCH_MEM (4g), PCB_RUNS_DIR (PROJECT/.gate/cli), KICAD_HAPPY_DIR (~/Documents/GitHub/kicad-happy).
set -eu
[ $# -ge 2 ] || { echo 'usage: bench-in-route.sh PROJECT COMMAND...' >&2; exit 2; }
project=$(cd "$1" && pwd -P); shift
toolchain=${BENCH_TOOLCHAIN:?set BENCH_TOOLCHAIN to an installed toolchain bin folder}
happy=${KICAD_HAPPY_DIR:-$HOME/Documents/GitHub/kicad-happy}
for f in node-linux-x86_64 iotroute-linux-x86_64 iotplace-linux-x86_64; do [ -x "$toolchain/$f" ] || { echo "bench-in-route: no $toolchain/$f" >&2; exit 2; }; done
# The board reader looks for PCB_TOOLCHAIN_ROOT/bin/iotroute-linux-x86_64; PCB_TOOLCHAIN_ROOT is the project here.
mkdir -p "$project/bin"
for f in iotroute-linux-x86_64 iotplace-linux-x86_64; do cmp -s "$toolchain/$f" "$project/bin/$f" || { rm -f "$project/bin/$f"; cp "$toolchain/$f" "$project/bin/$f"; }; done
runs=${PCB_RUNS_DIR:-$project/.gate/cli}
mkdir -p "$runs"; runs=$(cd "$runs" && pwd -P)
case "$runs/" in "$project"/*) extra='' ;; *) extra="-v $runs:$runs" ;; esac   # a runs folder outside the project is mounted too
exec docker run --rm --platform linux/amd64 --network none --cpus "${BENCH_CPUS:-2}" --memory "${BENCH_MEM:-4g}" --user "$(id -u):$(id -g)" \
  -v "$project:$project" $extra -v "$toolchain:/opt/bench/toolchain:ro" -v "$happy:/opt/kicad-happy:ro" -w "$project" \
  -e HOME=/tmp -e IOT_LAB="$project" -e PCB_TOOLCHAIN_ROOT="$project" -e PCB_RUNS_DIR="$runs" \
  -e IOTROUTE_BIN=/opt/bench/toolchain/iotroute-linux-x86_64 -e IOTPLACE_BIN=/opt/bench/toolchain/iotplace-linux-x86_64 \
  -e REMOTE_NO_DAEMON=1 -e PCB_JOBS_LOCAL=1 -e JOBD_URL= -e KICAD_HAPPY_DIR=/opt/kicad-happy -e KICAD_CLI=kicad-cli \
  -e NODE_OPTIONS='--experimental-strip-types --no-warnings' \
  iot-lab-route:10.0-nightly-4fe1ca2060 sh -c 'mkdir -p /tmp/bin && ln -sf /opt/bench/toolchain/node-linux-x86_64 /tmp/bin/node && PATH=/tmp/bin:/usr/local/bin:/usr/bin:/bin exec "$@"' sh "$@"
