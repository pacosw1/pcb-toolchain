#!/bin/sh
# Run only on the dedicated Hetzner scratch workspace; never writes canonical CAD.
# Usage: tools/tracemaker_bench.sh prepare|route|iotroute|verify /var/tmp/tracemaker-1378...
set -eu
exec node "$(dirname "$0")/router/benchmarks/1378-baseline.mjs" "$@"
