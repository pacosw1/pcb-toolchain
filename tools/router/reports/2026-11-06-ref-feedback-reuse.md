# Scoped reference-feedback reuse (#1412)

**Opt-in only; no canonical board adoption.** The corrected same-binary ESP32
pair passes native 0/0/0, planes 0 and exact unrelated-copper preservation.
Native-stage wall/CPU fell in this single shared-host pair; the option remains
off by default. Both official ESP32 gates still fail on stale exemptions, with
zero unwaived findings. The first prototype's failed preservation is retained.

Later user-authorized stale-entry cleanup gives both exact candidates a fresh
full-gate PASS under their reviewed candidate-specific ledgers. See the separate
[stale-exemption closure](2026-11-06-esp32-stale-exemptions.md). The measured runs
and their original gate failures below remain unchanged historical records.

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

## Corrected pinned pair

Coordinator message 1952 authorized one corrected same-binary ESP32 pair after
the original four cases completed. Source pin
`2c498953f4c40af7895d13ecdaa7bf9b3aa66e51`, archive SHA256
`43966d1a091880d3bce69fe0783fc5f6e097a628571b294170e573dcfdeea7f8`,
Linux binary `1c8fa03450d42b3bc9a6ea4c3566f350e083a877a14ef233372bc8439196cf59`.
This includes the independently verified owned-child cleanup fix before pinning.
Rust 1.93.1, Node 22.23.2 and the native image remain pinned as before. The
same frozen PCB, all 2723 hardware files, 2 CPUs / 8 GiB, seed 0 and 80-pass
policy are unchanged. Control ran 02:03:50-02:13:18 UTC; scoped ran
02:13:34-02:17:42 UTC, sequentially in separate owned projects.

| Corrected ESP32 measure | Full control | Scoped reuse |
|---|---:|---:|
| Native-stage wall / owned CPU | 554.730 / 553.494 s | 236.496 / 238.781 s |
| Initial core wall | 270.2 s | 216.5 s |
| Feedback core wall / passes | 270.3 s / 22 | 3.5 s / 1 |
| Complete scoped attempt including fresh checks | n/a | 7.226 s; no fallback |
| Configured gate wall / owned CPU | 12.287 / 20.813 s | 10.481 / 17.673 s |
| Whole harness wall / cgroup CPU | 567.718 / 575.149 s | 247.607 / 257.056 s |
| Track length / vias | 2225.0 mm / 201 | 2168.0 mm / 181 |
| Native DRC / opens / parity; planes | 0 / 0 / 0; 0 | 0 / 0 / 0; 0 |
| Official gate | FAIL: 5 stale entries | FAIL: 7 stale entries |

The observed native-stage reduction is 57.37% wall and 56.86% owned CPU.
This is one corrected pair on a shared host without cache flushing. Initial
core time also differed by 53.7 s despite identical initial route bytes, so the
whole-run percentage is not an isolated causal estimate or a general speedup.
The feedback core itself changed from a full 22-pass route to one scoped pass.

Both modes have initial model `5fae6723...` and first native board
`1dcb96b1...`. The control reproduces historical final bytes `e9464aaa...`.
The corrected scoped native board is `f3dee697...`: the independent native
integer-coordinate auditor finds **only `/SPI_MISO` changed**, every unrelated
net exact, all 30 locked objects identical and no new locks. No geometric
tolerance is applied. The named fresh native, scoped/final reference and
configured non-Happy checks are zero. Happy reports zero unwaived findings;
the five/seven stale sets match the respective prototype sets. The official
gates and whole harness remain FAIL/ERROR; neither board is fully accepted.
ERC warnings are 337 and DRC warnings 22 in each mode. No waiver was edited.

The first independent audit-export container refused to create its JSON due
to its default user permissions, before any board export. That failure is
retained. A separate read-only export with user 0:0 completed; it did not reroute
or alter either candidate. Both attempts' terminal state and absence receipts
are archived. All native/gate children and containers are gone; frozen hardware
hashes are unchanged. The corrected pair JSON and raw archive retain timings,
checks, bindings, candidates and cleanup. The original NET-CORE/ENV regression
receipts below belong to the first binary; they are not relabelled as reruns of
the corrected binary. No additional real-board cases were performed.

## First pinned experiment (preservation failed)

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
The AIO owner's later audit identifies a separate original-board planes check
at 01:09:40-01:11:23 UTC, capped at 2 CPUs / 8 GiB, overlapping the scoped case's
initial core. It reproduced preexisting AIO findings and was not a reuse trial.

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
the first implementation, not the later corrected executable.

## Precision failure and correction

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
checks passed. The corrected ESP32 native preservation result is recorded separately above.

## Retained evidence

[The prototype JSON](2026-11-06-ref-feedback-reuse-prototype.json) retains all
four outcomes, failed/recovered gate status, CPU scopes, exact hashes, stale sets
and the failed native preservation audit. Raw records, candidates, models,
source archive, binary, launchers, cleanup and both withdrawn/correct audits are
sealed at `/var/lib/cip/saved-artifacts/ref-feedback-reuse-1412/prototype-evidence.tar.gz`,
SHA256 `af619cf2f69c84896dc59e9315d35b79496dfa705d15089cbb7e03a8d31b10b7`.
The JSON names the immutable fixture/runtime archives needed for reproduction.

[The corrected pair JSON](2026-11-06-ref-feedback-reuse-corrected.json) retains
the new same-binary outcomes. Its separate raw archive is
`/var/lib/cip/saved-artifacts/ref-feedback-reuse-1412/corrected-evidence.tar.gz`,
SHA256 `cbbad129b233d13b369d46dac818f344741b433f3fef283139c70b150fbc32ab`
(190 files). Both raw archives have matching durable local copies. The original
failed prototype is immutable and remains available beside the corrected pair.
