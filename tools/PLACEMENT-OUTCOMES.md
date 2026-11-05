# Attributed placement and routing outcomes

`placement_outcomes.py` reads existing evidence. It does not run a placer, router
or native checker, change weights, select parts or qualify CAD. Historical
observations can remain valid after an isolated candidate was adopted: the
original input artifact, sealed run and routed output must match their recorded
hashes; current canonical CAD is a separate question.

The TypeScript observer is available for the ML routing adapter and can also be
run directly with Node. It independently revalidates native thermal obligations
through the `route-coverage` binary in the pinned Linux job runtime; unavailable
thermal validation remains an unknown, never an accepted observation. The legacy
Python entry point remains while its Python callers are still present.

```sh
node --experimental-strip-types --no-warnings tools/placement_outcomes.ts evaluate STUDY_ID --manifest STUDY.json --json --output REPORT.json
```

```sh
python3 tools/placement_outcomes.py evaluate STUDY_ID --manifest STUDY.json --json --output REPORT.json
```

The public API is `evaluate_study(root, manifest, study_id=None)`.
`study_dependencies(root, manifest)` returns the consumed file/hash closure for
the unified workflow. A report can have `observational_ready: true` while its
`status` is `blocked` and `comparative_readiness` is false. Its typed blockers and
`next_action` explain the missing evidence. `qualified` and `adopt_weights` are
always false.

A study is an explicit inventory of trials, including failed, timed-out,
cancelled and unknown observations. Omitted attempts remain unknown. The format is:

```json
{
  "schema": "iot-lab.placement-outcome-study.v1",
  "study_id": "review-a",
  "arms": ["baseline", "proposal"],
  "development_families": ["BOARD-A"],
  "holdout_families": ["BOARD-B"],
  "trials": [{
    "id": "a-baseline-1", "kind": "cli_run",
    "path": "ARCHIVE/run-ID", "sha256": "TERMINAL_RESULT_SHA256",
    "arm": "baseline", "split": "development", "family": "BOARD-A",
    "case": "unchanged-routing-task", "replicate": 1,
    "placement_input": {"path": "ORIGINAL_INPUT.kicad_pcb", "sha256": "INPUT_SHA256"},
    "execution_policy": "operation/execution-policy.json"
  }]
}
```

The CLI adapter accepts actual route/repair runs, verifies their terminal evidence
inventory and native report/candidate binding, and checks complete fresh native
and configured acceptance before counting a full success. A continued candidate
also needs `parent_run: {path, sha256}` matching its admitted sealed parent.
An original input backup is acceptable when its bytes match the recorded source;
the current adopted board must not be substituted. Electrical metrics are retained
individually. Unknown native results are not interpreted as zero findings.

Execution controls must have been recorded inside the sealed run. The optional
policy receipt schema is `iot-lab.placement-outcome-execution.v1`, with the actual
`command`, `runtime: {image_id, tools: {NAME: {version, sha256}}}`,
`resources: {cpus, memory_bytes, threads}`, and
`effort: {timeout_s, passes, max_repairs, optimizer}`. The command must match an
actual `tool.start` event. Runtime/resource/effort controls, original tool sources,
native tool identities, actual route spec and gate policy must match within each
pair. Missing historical controls cannot be supplied retrospectively from memory
to establish a comparison.

Comparative readiness requires paired repetitions in both development and
holdout partitions. Board-family declarations must be disjoint; identical native
electrical/copper cases cannot appear in both. These checks do not prove unseen
data or statistical generalization: unrecorded model-selection access is unknown.
Two repetitions establish repetition, not a confidence or quality threshold.
No score changes are adopted automatically, including after a complete comparison.

Each independent CLI trial must refer to a distinct sealed run. Aliases,
relabelled arms/repetitions and copied archives cannot count the same execution
again. Observations expose both `placement_input_sha256` and
`placement_pose_fingerprint`; their shared `case_fingerprint` intentionally
excludes unlocked poses while retaining electrical identity and existing copper.
Controlled Fastroute trials also need finalized, sealed effective-configuration
and original executor receipts. A prepared or incomplete receipt remains an
unknown control; its failed execution stays in the study inventory.


Existing `placer.placement_audit.archive` evidence is also readable through
`kind: "placement_archive"`, with the archive folder and expected `run.json` hash.
Its original source/hash attribution and proxy scores are retained. Legacy
archives lacking controlled runtime, full electrical acceptance or repeated
holdout trials remain observational; correlation alone cannot rank new policies.

Elapsed supervisor durations include failed work when known. Missing duration
stays null. Recorded run coverage unions actual submission/terminal intervals
instead of adding overlapping wall times. It excludes unrecorded engineering work
and gaps; an engineering cycle supplies broader effort evidence.

The actual ENV-SENSE archived repair is a positive observation of native and
electrical acceptance, not a placement-policy A/B: its original run was 3.512
seconds with zero native errors/opens/parity and 44 retained warnings. The study
correctly remains blocked without comparison controls, paired repeats and holdout.

The earlier `route_grid.GetOwnClearance` concern is not a confirmed defect:
KiCad can return effective DRC-engine clearance, and the measured ENV 10.0.6
probe returned 0.15 mm on all 11 nets with no zero-clearance nets. A future
inherited/default/custom-rule differential audit should compare exact native
evidence before changing the model. This backend changes no clearance policy.

The bounded historical ranking audit found no equal-control selection-regret
measurement. In the [four-pose BASE-B table](../hardware-design/reports/2026-10-09-base-b-placement-audit.md),
the two poses with zero recorded native errors have costs 4002.69 and 4022.45,
but respectively 9 and 7 opens. Their halos differ, only one route per pose is
recorded, and neither completed. The [accounting JSON](../hardware-design/reports/2026-10-09-lean-archive-accounting.json)
records zero completions in four real-outline attempts. Its optimizer windows
are nested within backend time. The common-halo exercise was a rescore without
new routing or a holdout; it does not establish a routing improvement or failure
of a new scoring policy.

The later [six-pose native-screen record](../hardware-design/reports/2026-10-09-placement-native-screen.json)
contains no routed outcomes: all six retain an inherited native error and 308
opens, and one introduces two additional native errors despite an empty internal
illegal list. These are a different source revision from the four-pose archive.
Their costs do not establish an actual routed selection rank. The original raw
BASE-B archives were not recovered by the bounded local/server pointer search;
tracked summary hashes attribute these observations but do not replay the absent
native artifacts.

The task-local evidence is retained under
`.gate/pcb-lifecycle-20261016/invalidation-placement-audit/placement/`.
Its corrected `audit.json` and `rebuild_audit.py` bind the exact four-pose table
and accounting source separately from the later seed table. The next useful
handoff is an attributable raw-archive location; otherwise a separately
authorized nonproduction comparison needs the selected pose and a native-legal
alternative with matching source, runtime, resources and router effort, original
failures, and route/repair/verification receipts. This audit ran no routes and
provides no basis for changing weights or claiming a speedup.
