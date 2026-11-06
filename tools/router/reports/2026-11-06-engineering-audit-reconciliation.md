# Engineering audit and implementation handoff reconciliation (#1325)

Reviewed source: `ce586b41c053aae9374d0c18dd21083f525511d6`.
This closes the audit/handoff record against the implemented deterministic
increments and measured comparisons. It does not close the separate controller
task #1323, certify every researched algorithm, or qualify a physical board.

The old task discussion is historical evidence. In particular, Python compiler
paths, claims that resumable state is absent, 8 CPU route defaults, the old
TraceMaker pin, and the missing ordinary-CLI live path are not descriptions of
this source revision.

## Disposition of the concrete findings

| Finding or required increment | Implemented evidence | Verified source gate |
| --- | --- | --- |
| Recovery must not clear an explicit hard antipad-web rule | [Core audit](2026-11-05-core-audit.md), hard-web regression, PR 45/46 | Promotion 1522 passed at `62d5c9b` |
| Four compiler forms were partially translated and labeled applied | [Rule admission](2026-11-05-rule-admission.md), PR 52; compiler and direct solver refuse lost semantics | Promotion 1543 passed at `d7ea605` |
| A progress JSON is not resumable state; short stops must avoid discarded finalization | [Continuation-only yield](2026-11-05-checkpoint-yield.md), PR 46; model/binary/flag binding and replay tests | Promotion 1522 passed at `62d5c9b` |
| One packed job, distinct variants, parent deadline and complete child cleanup | [Sprint runner](2026-11-05-sprint-runner.md), PR 49 | Promotion 1535 passed at `022a3b7` |
| Native open connections must remain visible without optional diagnosis | [Stuck-report coverage](2026-11-05-stuck-native-coverage.md), PR 58 | Promotion 1555 passed at `4e77112` |
| Dynamic via holes must be checked in both insertion orders | [Reference-via holes](2026-11-05-reference-via-holes.md), PR 54; corrected net/domain scope in [#1433](2026-11-06-reachability-scope.md), PR 84 | PR 54 is an ancestor of passed promotion 1548; promotion 1600 passed PR 84 at `ce586b4` |
| Unchanged-input reuse must retain the stronger verified incumbent | [GND reuse](2026-11-05-gnd-reuse-incumbent.md), PR 56 | Promotion 1548 passed at `e6d89b6` |
| Placement raster scores must not accept exact edge-clearance violations | PR 53; exact legalization checks and regressions | Promotion 1544 passed at `6aa3e07` |
| Placement route score must consume a real signal instead of constant zero | PR 65; sparse pressure remains diagnostic/opt-in | Promotion 1562 passed at `fc2934e` |
| Ordinary CLI daemon jobs must feed the existing live viewer | [Live dispatch](2026-11-05-live-dispatch.md), PR 50, building on PR 47/48 | Promotion 1539 passed at `696715d` |
| Agent actions must retain source, revision and movement authority | PR 69; action-envelope/candidate/adoption guards | Promotion 1569 passed at `dba1943` |
| `project-check` must refuse options the backend refuses | PR 83; inherited budgets, overrides, option/feature regressions | Promotion 1598 passed at `558c697` |

The promotion records above were read live through CIP during this audit.
The local Git ancestry of PR 54 in the passed PR 56 revision was checked: its
own promotion row is absent from current retained history, so a direct PR 54
deployment claim is not substituted for that containing-revision evidence.
These repository promotions contain `verify`; they prove merged/verified
source, not installation of a new runtime bundle or app.

The route dispatcher currently requests two CPUs and four GiB for an ordinary
route. A sprint requests its aggregate configured parallelism/memory in the
same packed job. These are resource reservations, not measured speedups or
electrical requirements. The solver remains single-threaded within one core
invocation; the portfolio supplies independent concurrent continuations.

## Rule coverage is deliberately bounded

| Authored constraint | Current disposition |
| --- | --- |
| Minimum-only track width | Refused: no complete width-selection implementation |
| Length minimum plus maximum | Refused: minimum semantics are not implemented |
| Layer-specific track-width optimum | Refused: one scalar net width cannot represent it |
| Via diameter minimum plus maximum | Refused: maximum semantics are not implemented |

These forms are not newly supported. The compiler records the exact refusal,
and the direct solver checks that report before writing route/checkpoint output.
Other admitted constraints retain their implemented model or named verification
stage. Reviewed placement constraints, source-bound action envelopes, native
DRC/parity and configured electrical/semantic gates remain separate checks.
There is no claim of one universal constraint object enforcing every placement,
routing, schematic, manufacturing and physical requirement.

The #1433 correction removes an over-broad obstacle envelope without changing
the applicable clearance numbers. Old mixed-plane models lacking domain
membership remain conservative; fresh model generation is required. Its
historical pad-access probes do not become accepted board routes.

## Comparison and performance decisions

| Comparison | Measured conclusion and limit |
| --- | --- |
| [Single run versus sprints](2026-11-05-sprint-benchmark.md), #1318/#1358 | No demonstrated verified-quality benefit; no-go for adding LLM scheduling on this evidence. Larger-board results include failed/inconclusive budgets. PR 57, promotion 1551, is verified source. |
| [TraceMaker v0.12.1 on frozen NET-CORE](2026-11-05-tracemaker-v0.12.1-net-core.md), #1378 | Refreshed pinned comparison completed; both candidates failed the unchanged gate. PR 61, promotion 1558, is verified source. This does not describe an unspecified latest upstream version. |
| [ESP32 single/sprint comparison](2026-11-06-esp32-sprints.md), #1399 | Historical singles met the registered benchmark definition; sprints did not. Official gate failures and host/policy confounds remain explicit. PR 75, promotion 1578, is verified source. |
| [Shared-feedback follow-up](2026-11-06-sprint-feedback.md), #1416 | One candidate met benchmark qualification later and with more CPU than historical singles; the official run still failed. PR 80, promotion 1595, is verified source. No LLM policy was tested. |

The old continuation-only, harder-board, refreshed-baseline and equal-budget
follow-ups now have implementations or terminal evidence. Negative results
close those experiments; they are not permission to keep increasing a budget,
weaken a gate, or relabel an incomplete candidate as verified.

On 2026-11-06 the user explicitly requested an **experimental opt-in controller**
despite the benchmark no-go. This is a scheduling exception for #1323 only.
The no-go evidence remains unchanged. The controller must remain disabled by
default, identify itself as experimental, retain a bounded round/deadline
policy, record every decision and reason, preserve search-best separately from
verified-best, stop repeated causes, and use the existing reversible move and
candidate workflows. It cannot add layer/movement authority, alter reviewed
electrical limits, waive native checks, or adopt CAD automatically.

## Remaining boundaries

Task #1323 owns the controller implementation and its CLI/Studio integration.
The research register in #1325 remains staged options for named bottlenecks:
multi-label search, exact escape allocation, new topology/shove methods,
within-router parallelism, predictive culling and learned/GPU scoring are not
all requirements of this audit closure. Their presence in the brief is not
implementation or performance evidence.

Source CI, publication, runtime installation, native candidate acceptance,
canonical adoption, fabrication and physical qualification remain distinct.
Release 0.2.14 was published and its public archive checksum verified in #1440;
it predates PR 83/84. No board was adopted, ordered, built or qualified by this
reconciliation. Dropped AIO/PQ board repair work was not resumed.
