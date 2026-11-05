#!/bin/bash
# Placer search on the Hetzner box. Run from the Mac:
#   REMOTE_MEM=8g REMOTE_CPUS=30 tools/remote.sh <board-dir> --in prob.json --in bin/iotplace-linux-x86_64 \
#       -- bash tools/placer/remote_run.sh run in/prob.json -o out/res.json --workers 30 ...
# A problem with a reviewed engineering contract runs on Python: pass a numpy wheel (PyPI numpy for CPython 3.13,
# x86_64) with --in instead of the binary; it is unpacked into py/ in the job folder (not in out/).
set -eu
if [ -f in/iotplace-linux-x86_64 ]; then
  chmod +x in/iotplace-linux-x86_64
  exec in/iotplace-linux-x86_64 "$@"
fi
mkdir -p py
python3 -m zipfile -e in/numpy-*.whl py/ >/dev/null
PYTHONPATH=$PWD/py exec python3 tools/placer/cli.py "$@"
