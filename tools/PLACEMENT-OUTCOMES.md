# Attributed placement and routing outcomes

`placement_outcomes.py` reads existing evidence. It does not run a placer, router
or native checker, change weights, select parts or qualify CAD. Historical
observations can remain valid after an isolated candidate was adopted: the
original input artifact, sealed run and routed output must match their recorded
hashes; current canonical CAD is a separate question.

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
