#!/bin/bash
# Placer search on the Hetzner box. Run from the Mac:
#   REMOTE_MEM=8g REMOTE_CPUS=30 tools/remote.sh <board-dir> --in prob.json --in bin/iotplace-linux-x86_64 \
#       -- bash tools/placer/remote_run.sh run in/prob.json -o out/res.json --workers 30 ...
# A problem with a reviewed engineering contract also takes --engineering-frozen-model-sha256 HEX: the digest of the file the
# producer verified against the original sources (tools/placer/place.ts). The job has no sources to check.
set -eu
chmod +x in/iotplace-linux-x86_64
exec in/iotplace-linux-x86_64 "$@"
