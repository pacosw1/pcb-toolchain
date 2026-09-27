#!/bin/bash
# Placer search on the Hetzner box (the image has no numpy and no pip). Run from the Mac:
#   REMOTE_MEM=8g REMOTE_CPUS=30 tools/remote.sh <board-dir> --in prob.json --in numpy-*-cp313-*manylinux*x86_64.whl \
#       -- bash tools/placer/remote_run.sh run in/prob.json -o out/res.json --workers 30 ...
# The wheel (PyPI numpy for CPython 3.13, x86_64) is unpacked into py/ in the job folder (not in out/).
set -eu
mkdir -p py
python3 -m zipfile -e in/numpy-*.whl py/ >/dev/null
PYTHONPATH=$PWD/py exec python3 tools/placer/cli.py "$@"
