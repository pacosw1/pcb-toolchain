# Scoped reference-feedback reuse (#1412)

**Draft: not adopted.** The first prototype reduced routing work and improved
the named route-quality metrics, but failed strict preservation of unrelated
copper. A local exact-number fix passes unit tests; corrected native validation
has been requested and has not yet run. The option remains off by default.

## Why the existing reuse path was not used

`Run::ref_gate` previously called a new full attempt without a seed after a
reference-cost update. The public `run --reuse` adapter needs a completed board
receipt, source hashes, DRC and pose comparison; those final receipts do not
exist mid-feedback, and public reuse also skips this feedback loop. A search
checkpoint is not reusable after its model/cost binding changes.

The prototype builds the existing copper-seed schema from the current internal
route. It admits only the exact named reference-cost raise/hardening, checks all
other model values as raw JSON, binds input/model/route/seed hashes, and loads
retained copper through the existing negotiable-owner engine. It carries no
cached search history or native approval. Fresh scoped core/native/planes checks
precede selection; failed scoped attempts use a full fallback. Width-rewriting
rules currently force a full fallback because that numeric path is unaudited.

## First pinned experiment

Implementation `5c1bc0efda08730f80dc8580b9668e9a7610622d`, Linux binary
`b4b395f46cd7662e7fd305f2580e9c997918fa222864092f499c955b5587b0f6`,
Rust 1.93.1, Node 22.23.2 and native image `8c1c6d83...`. The pinned
[protocol](2026-11-06-ref-feedback-reuse-protocol.md) records frozen inputs,
resources, ordering and the later setup/preservation corrections. There was one
ESP32 pair plus NET-CORE and ENV-SENSE regressions, with no additional seeds.

| ESP32 native-stage measure | Full feedback | Scoped prototype |
|---|---:|---:|
| Wall time | 592.374 s | 281.410 s |
| Owned-child CPU | 594.218 s | 283.233 s |
| Feedback core | 311.1 s / 22 passes | 3.4 s / 1 pass |
| Track length | 2225.0 mm | 2168.0 mm |
| Vias | 201 | 181 |
| Native DRC / opens / parity | 0 / 0 / 0 | 0 / 0 / 0 |
| Final planes | 0 | 0 |
| Official configured gate | FAIL: 5 stale RP-001 entries | FAIL: 7 stale RP-001 entries |
| Strict unrelated-copper preservation | control | **FAIL: 15 unrelated nets drift by 1 nm** |

The initial model and first written board are identical across modes
(`5fae6723...` and `1dcb96b1...`). Only `/SPI_MISO` is selected for rip-up;
57 signal nets and 1028 seed items are retained. The scoped attempt including
its extra fresh checks took 7.269 s without a full fallback. The observed native
wall/CPU reductions are not an adoption result because preservation failed.
This is one pair on a shared host with AIO/CI overlap and no cache flushing,
not a general speedup estimate.

Late-received host context (task comment 5928): release 0.2.13 Linux builds used
2 CPUs / 4 GiB, one at a time from about 00:59 UTC, followed by an approximately
five-minute smoke at 8 CPUs / 16 GiB. This is additional overlap beyond the AIO
and merge-queue activity. Its exact interference was not measured; the sealed
raw outcomes stay unchanged and do not become a controlled-host comparison.

The full control's first separate gate had four checker-execution errors from
a missing project-root binary alias in the test launcher. Null metrics remain
errors. After repairing that alias, one gate-only check on identical board bytes
completed all actual configured error counts at zero; Happy reported zero
unwaived findings and five stale entries. It took 12.229 wall / 20.654 cgroup
CPU seconds, reported separately rather than fabricated into an observed total.
The scoped fresh gate likewise has zero non-Happy errors and zero unwaived
Happy findings, but a different set of seven stale RP-001 entries. No exemption
was edited or newly granted. Neither ESP32 candidate is a fully accepted board.

| Frozen regression, same prototype binary | Result |
|---|---|
| NET-CORE | Native 0/0/0 and full gate PASS; exact prior `f1deebad...` native bytes, 1118 tracks / 263 vias / 1563.9 mm; 330.865 wall / 329.400 cgroup CPU s |
| ENV-SENSE | Full gate and both semantic hooks PASS; exact `7c4dd481...` accepted bytes, 177 tracks / 20 vias / 262.0 mm; 17.243 wall / 16.710 cgroup CPU s |

Neither regression needed a feedback reroute. All frozen hardware hashes remain
unchanged; owned stages and containers completed cleanup. Those receipts test
the first implementation, not the later untested parser correction.

## Precision failure and local correction

The default JSON float parser can reload `108.69999999999999` as `108.7`.
The writer truncates `mm * 1e6` toward zero, so those values can become different
native nanometres. Keeping raw JSON in the seed was insufficient: the core
decoded it through the default float parser again. The writer already avoids
this class of error; the existing reuse loader did not.

An initial round-to-nearest audit was wrong and withdrawn. The retained native
integer-coordinate exports confirm 16 changed nets, including the intended
`/SPI_MISO`; 15 unrelated nets have one-nanometre changes. All 30 locked items
remain exact and no new locks were added. The exact auditor rejects fractional
route JSON inputs and applies no geometric tolerance. Regenerated unlocked-item
UUIDs are kept distinct from geometry and locked-object identity.

The local fix parses seed decimals through `RawValue` and the standard float
parser, preserving writer double bits, integer metadata and strings. Model
parsing, rule values and the search algorithm remain unchanged. Unit tests cover
the observed truncation boundary, negative zero, integer types, invalid/deep
JSON, named model invalidation, unchanged-input binding, fallback execution and
the native auditor's one-nanometre rejection. Local validation: 867 Rust tests
passed with one existing ignore, two native-auditor tests and nine source/bundle
checks passed. This is not native acceptance of the corrected executable.

## Retained evidence

[The prototype JSON](2026-11-06-ref-feedback-reuse-prototype.json) retains all
four outcomes, failed/recovered gate status, CPU scopes, exact hashes, stale sets
and the failed native preservation audit. Raw records, candidates, models,
source archive, binary, launchers, cleanup and both withdrawn/correct audits are
sealed at `/var/lib/cip/saved-artifacts/ref-feedback-reuse-1412/prototype-evidence.tar.gz`,
SHA256 `af619cf2f69c84896dc59e9315d35b79496dfa705d15089cbb7e03a8d31b10b7`.
The JSON names the immutable fixture/runtime archives needed for reproduction.
