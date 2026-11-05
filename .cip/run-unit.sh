#!/bin/sh
# Run each tools test that needs no project data, one process per file: subfolder *.test.mjs and *.test.ts with node.
# Ends with one PASS/FAIL line.
# .cip/project-only-tests.txt names what cannot run here. "name cause" skips a whole file. "name | test | cause" keeps
# the file and names one test that must fail for that cause: any other failure fails the run, and so does a named
# test that passes (the entry is stale).
set -u
cd "$(dirname "$0")/.."
list=.cip/project-only-tests.txt
skip=$(sed -e '/^#/d' -e '/|/d' -e 's/ .*//' "$list")
log=$(mktemp); ran=0; named=0; failed=''
for f in $(find tools -type f \( -name '*.test.mjs' -o -name '*.test.ts' -o -name '*.test.mts' \) -not -path '*/node_modules/*' | sort); do
  t=${f#tools/}
  case " $(echo $skip) " in *" $t "*) continue ;; esac
  ran=$((ran + 1))
  node --experimental-strip-types --no-warnings --test --test-reporter=tap "$f" >"$log" 2>&1; rc=$?
  got=$(sed -n 's/^not ok [0-9]* - //p' "$log" | sort -u)
  want=$(awk -F' [|] ' -v t="$t" '$1 == t { print $2 }' "$list" | sort -u)
  if [ "$got" = "$want" ] && { [ "$rc" = 0 ] || [ -n "$want" ]; }; then
    [ -z "$want" ] || named=$((named + $(echo "$want" | wc -l)))
  else
    failed="$failed $t"; tail -25 "$log"
  fi
done
rm -f "$log"
if [ -n "$failed" ]; then echo "FAIL: $ran files, failed:$failed"; exit 1; fi
echo "PASS: $ran test files, $named named tests failed for their listed cause"
