#!/bin/sh
# Run each top-level tools/test_*.py that needs no project data, one process per file. Ends with one PASS/FAIL line.
set -u
cd "$(dirname "$0")/.."
export PYTHONPATH=tools PYTHONDONTWRITEBYTECODE=1
skip=$(sed -e '/^#/d' -e 's/ .*//' .cip/project-only-tests.txt)
log=$(mktemp); ran=0; failed=''
for f in tools/test_*.py; do
  t=$(basename "$f" .py)
  case " $(echo $skip) " in *" $t "*) continue ;; esac
  ran=$((ran + 1))
  if ! python3 -m unittest "$t" >"$log" 2>&1; then failed="$failed $t"; tail -25 "$log"; fi
done
rm -f "$log"
if [ -n "$failed" ]; then echo "FAIL: $ran files, failed:$failed"; exit 1; fi
echo "PASS: $ran test files"
