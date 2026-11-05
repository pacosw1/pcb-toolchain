# Core audit and ENV-SENSE baseline (#1325)

Audited base: `735e29e42839c73d62ce2fbec8fe70ac30966f18` (release 0.2.7).
This is a bounded correctness increment and a first-board baseline, not a
completed portfolio benchmark or electrical qualification.

## Correctness fix: hard antipad web survives recovery

After non-converged negotiation, `route_cli` used to clear `web_hard` and set
`web` to zero before strict rerouting. Cascade repair, length recovery, and
final auditing then used the relaxed geometry. A note disclosed the relaxation,
but the result could still report no failed nets.

The CLI regression has two nets, each requiring an F.Cu/B.Cu layer change on a
10 mm board, with an explicit 20 mm hard web. These are synthetic test values,
not production requirements. Before the fix, both nets routed, `failed` was
empty, and the output contained two violating signal vias. After the fix, a net
remains open and the emitted copper respects the hard spacing. The test checks
both failure reporting and the geometry of every pair of different-net vias.

The fix removes the relaxation. Default priced-web behavior is unchanged;
recovery may change search strategy but cannot waive an explicit hard rule.

Validation: full `cargo test --release --locked --quiet` on macOS: 891 passed,
two ignored. The behavioral regression was observed failing on the old code
and passing on the fixed code, including Linux rust:1.93.1-bookworm. The ignored
tests remain ignored; this is not a claim that external KiCad integration tests
all ran inside Cargo.

## ENV-SENSE: isolated native verification and search

Existing `pcb-release-smoke:test` image:
`sha256:80c6a3ec7ede5687e4f220be654705acfa5da39bc204ccffb65d69098af96424`.
Runs were sequential on Hetzner, with two CPUs, 8 GiB RAM, no container network,
`PCB_JOBS_LOCAL=1`, the same input project, and a 600 second outer timeout.
Other host work was not stopped, so timings are observations under shared load.
Only owned scratch copies changed; no canonical adoption or deployment occurred.

Start: `pcb context ENV-SENSE --json`, `pcb next ENV-SENSE --json`, then a fresh
check (`run-kaS5Mh`, passed). Routing used the supported `pcb route` interface.

| Run | Mode | Wall s | Owned-child CPU s | Result |
| --- | --- | ---: | ---: | --- |
| run-qAxHla | route-json, preserves input copper | 11.589 | 10.102070 | PASS; zero new tracks/vias |
| run-3F6FYu | iotroute, baseline full reroute | 24.662 | 25.770493 | PASS |
| run-wwPuHF | iotroute, patched full reroute | 18.930 | 19.479290 | PASS; identical candidate bytes |

The preservation run is not evidence of search quality. Full reroutes used
`{"schema":"iot-lab.iotroute-policy.v1","return_exempt":true,"keep":"lock-nets"}`.
The return policy consumes the board's declared exemptions; it does not waive
new nets. Both full reroutes removed 283 input copper items, kept zero locked
items, and produced 187 tracks, 23 vias, and 258.6 mm track length in seven
passes. Core wall times were 11.3 and 9.4 seconds respectively. Both passed
native DRC, unconnected checks, schematic parity, the configured board gate,
and the existing schematic/layout semantic checks. All three native error
counts were zero. Source preservation was verified by the run receipts.

One pair of runs does not establish a performance improvement. ENV's model has
zero antipad web, so this comparison checks that the fix leaves the ordinary
path unchanged. Hard-web enforcement is established by the targeted regression.
This board's gate has no planes/pairs acceptance metrics; no synthetic checks
were added to create such coverage. CPU is the recorded owned leader wait4
accounting, not a sum of overlapping nested spans. Peak RSS was not collected.

| Identity | SHA-256 |
| --- | --- |
| Source board | 6abb00a0a30cd3f02d6e96a0cb326e16c1f050b735e5ed43770dcbf653844ae7 |
| Gate | 60e3950961993622b39a088e212ffaa6c822f224c5d3244cbdb74f07f4f3c04e |
| DRU | 0f32e6c9b570d23eceed7fa8ba6b7c3b901abac05a4b22da3316fafbc67259a1 |
| Full-route model | 737bab78968362e4acad86bc6a0c861fd68336560c7c5e474baf05919db186b0 |
| Baseline binary | 4c50ef41f35890854b83194cd2706fc97d29dc2e40f857ecf0dd40f588655db8 |
| Patched binary | 57ab663d4b3935b6e67b609bb1dffdbbe131ce007416133f85c6d8ed371a96a4 |
| Both full-route candidates | c04e1bfc75d538951b89d1926fa95cca768553f002b87dfafdc365d4dd38dbc4 |

## Resume and search audit

The old task comments claiming resume does not exist are stale. `resume.rs`
already implements a prototype, with binary/model/flag binding, hashed durable
state, copper/history/incumbent/order/resource counters, terminal markers,
and synthetic replay and signal-interruption tests. Those tests passed here.
The run wrapper exposes seed/progress flags but does not expose resume/save.
The documented limitations remain important: no reuse combination, no resumed
`--max-time`, large full-grid snapshots, and external total-deadline ownership.
Do not start #1317 by reimplementing this state format.

A Linux tool-development replay on the exact ENV model above compared one
80-pass-budget invocation with a two-pass save followed by resume to the same
80-pass budget. Both converged in seven passes; `tracks`, `vias`, `failed`, and
`passes` were identical. This tests raw core replay, not a new native gate receipt.
The snapshot was 4,488,077 bytes. Its accounting recorded 1.9409 wall seconds
and 1.9405 CPU seconds at the saved boundary. Actual invocation times were:

| Invocation | Wall s |
| --- | ---: |
| Uninterrupted | 9.275 |
| Two-pass save, including final recovery | 28.634 |
| Resume to convergence | 12.099 |

The split run cost 40.733 seconds, about 4.4 times the uninterrupted run in this
single case. This is not checkpoint serialization overhead alone: the early
invocation still executes end-of-run recovery before exiting, and resume reloads
the earlier negotiation state. A supervisor-compatible continuation-only stop
and accounting for finalization are prerequisites for efficient short sprints.
Do not advertise checkpoint availability as a demonstrated speedup. The test
harness and raw evidence are retained with the audit artifacts.

The core checks its time budget at pass boundaries and can perform recovery
afterward. Treat core `--max-time` as a search stopping condition, not a hard
end-to-end SLA. The enclosing CLI timeout owns that boundary. A* distinguishes
pop-limit termination from no path; preserve this distinction in diagnostics.
Single-label resource-constrained search remains a research concern, not a
newly reproduced production defect. Rule compilation/admission and staged-job
features are being handled separately; this change does not certify them.

## Next ladder and Studio progress contract

Use active revisions with reviewed inputs and complete gates. The current
iot-lab registry at `d1e6e7cf59901c0edf55b80036c70103e7ed7b6b` identifies NET-CORE
as planned rev B with no gate; its old gate.json addresses rev A. Do not silently
benchmark that old board and call it the active revision. BASE-PWR variants are
excluded by the user's instruction. Coordinate FIELD-24V-BUS with the staged
backend owner, who is already exercising it, before starting duplicate work.

Extend existing run events and `route-checkpoint.v0`, rather than a separate
Studio progress channel. Proposed additive fields/events:

| Boundary | Required data |
| --- | --- |
| Attempt start | parent run, variant, seed/policy, source/model/rule/binary hashes, resource limits |
| Pass checkpoint | pass, open nets, conflicts, length/vias, worst nets, hot cells, CPU/wall, resumable-state hash |
| Attempt stop | converged, search limit, deadline, cancelled, invalid input or unsupported rule; retained state |
| Candidate verification | saved candidate hash, exact fresh gate receipt, success/failure and remaining findings |

Progress is provisional until native verification. Display search-best and
verified-best separately; do not turn a core completion event into a verified
board. A stopped attempt must identify its last usable state and whether work
can resume. Fixed-work replay and complete deadline accounting precede parallel
portfolio comparisons. Single-run algorithm quality and multiworker throughput
need separate experiments with equal resources; neither is established here.
