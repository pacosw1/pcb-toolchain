# Small models for PCB development

`tools/pcb ml` builds numeric datasets from sealed workflow observations, fits a
small model and scores new source inputs. It shares the CLI supervisor, run IDs,
streamed events, timeouts, cleanup and artifact seals. All outputs are advisory.
Training and prediction do not change CAD, enable the old CNN surrogate or
authorise model adoption. Numeric work is plain TypeScript with no dependencies; collecting
native/router observations still requires the normal controlled toolchain.

## Run the complete path

Put supervisor options before the action. Each command returns a run ID; its
terminal result lists the exact output artifact paths and hashes.

```sh
tools/pcb ml --detach --json dataset EXPERIMENT --manifest corpus.json
tools/pcb events RUN_ID --json --after CURSOR --wait 20
tools/pcb status RUN_ID --json
tools/pcb ml --json train MODEL --dataset /absolute/dataset.json --target accepted_within_budget --algorithm ridge --regularization 1
tools/pcb ml --json evaluate EVALUATION --dataset /absolute/dataset.json --model /absolute/model.json
tools/pcb ml --json features CANDIDATES --manifest features-request.json
tools/pcb ml --json predict RANKING --model /absolute/model.json --features /absolute/features.json
```

Artifacts are `operation/dataset.json`, `model.json`, `evaluation.json`,
`features.json` and `predictions.json` inside the respective owned run folders.
`operation/report.json` is the common receipt. Check the terminal verdict;
successfully reading status is not a passed experiment. `adopt` rejects ML runs.
`--cycle CYCLE_ID` can associate observations with an existing engineering cycle.

## Collect source-bound examples

The routing adapter consumes ordinary controlled route runs and the original
placement PCB. It reuses the placement-outcomes verifier for terminal seals,
native checks, task identity, placement identity and execution policy. It never
extracts candidate features from the routed output.

```json
{
  "schema": "iot-lab.pcb-ml-corpus.v1",
  "dataset_id": "placement-study-1",
  "adapter": "routing",
  "trials": [
    {
      "id": "case-a-placement-1-repeat-1",
      "family": "BOARD-FAMILY-A",
      "split": "train",
      "path": "/absolute/route-run",
      "sha256": "SHA256_OF_ROUTE_RUN_RESULT_JSON",
      "placement_input": {
        "path": "/absolute/original-placement.kicad_pcb",
        "sha256": "SHA256_OF_ORIGINAL_PCB"
      },
      "execution_policy": "operation/execution-policy.json"
    }
  ]
}
```

Replace the hash placeholders with actual SHA256 values and include independent
families assigned to `train`, `validation` and `test` before inspecting results.
Family names are experiment declarations, not automatically inferred PCB
genealogy. Native case, source and run identities add hard leakage checks.
Copies, variants and all placement/repeat arms of a case belong in one split.
Independent repeats remain observations; aliases of the same run count once.

Routing features are counts of footprints, pads, declared nets, copper layers
and retained copper; pre-decision retained straight-track length; all-net pad-centre HPWL and pairwise distance sum; two-pad distances; and the board
outline's bounding-box area. HPWL is a geometric measurement, not routed length
or the production placer's weighted score. Unsupported geometry remains unknown.
Feature values, units and extractor hashes form a versioned contract.
Routing contract v2 counts unique nonempty names in both legacy net tables and
KiCad 10 pad-local declarations; unresolved numeric net references stay unknown.
The pairwise sum measures unordered pad-centre pairs within each named net, in
millimetres. It can distinguish interior pad movements that leave HPWL unchanged.
Rebuild datasets and models after an extractor-contract change.
Routing contract v3 adds `retained_track_length_mm`, measured only from the
original placement PCB. Copper arcs or malformed/nonfinite segment geometry
leave this feature unknown. Via geometry does not change straight-track length.
Old v2 feature packets and models cannot silently use v3 columns or semantics.
The routing feature contract also binds static `quantity_contracts` shared by
the extractor and label adapter. This includes the added-length definition and
version without putting outcome values in features. Changed quantity semantics
therefore reject even when the numeric columns are identical.

Routing contract v4 also binds `numeric_producer`: the actual CPython build,
interpreter, verified math-module origin and a resolvable shared Python runtime,
float ABI, OS build/architecture and available C-math provider context. An
extension needs its own content hash; built-in math binds the interpreter or
actual mapped shared runtime that contains it. A missing extension cannot use
the built-in branch. Build-time linker filenames do not prove loaded code.
Host file paths are excluded from this compared identity. Workflow count and
indicator features remain contract v1 without this routing runtime restriction.
The measurements and targets are unchanged. Python versions can implement
summation and distance differently: the same board produced different final
bits under CPython 3.9.6 and 3.13.5 despite identical v3 source hashes.

Create routing datasets, feature packets and source-verified predictions in the
same frozen numerical runtime. A different producer rejects even a resealed
feature packet; no rounding or tolerance makes it compatible. A matching profile
attributes the producer; it does not attest every transitively loaded C library
or guarantee portable bitwise results. Unresolved shared-runtime/provider
details retain their explicit cause. Keep the actual execution image/toolchain
evidence and verify exact replay before reusing cached measurements.
Keep old v3 artifacts immutable. Re-extract their original sealed pre-decision
sources for a new v4 dataset/model; record the new fit and previously inspected
exposure. Re-extraction does not require rerunning native gates or routing.

Routing targets are `accepted_within_budget`, `owned_elapsed_s`,
`successful_completion_elapsed_s`, `native_errors`, `native_opens` and
`native_parity`, plus accepted-only `routed_track_length_mm`,
`routed_via_count` and `added_route_track_length_mm`. Acceptance uses full fresh-gate success within the owned run's
`run.json:timeout_s`; the solver's separate time limit remains recorded.
`owned_elapsed_s` measures time to any terminal outcome. Successful completion
time stays unknown for a failure or timeout, with censoring recorded explicitly.
Unknown controls or incomplete native evidence never become invented labels.
New observations record acceptance target contract
`iot-lab.accepted-within-owned-budget.v2`. A finalized failed route may supply
acceptance `0` through `iot-lab.verified-routing-execution-attempt.v1`: the sealed
original source, runtime, resources, budgets, admitted DSN, effective backend
configuration, actual launch and termination, and owned cleanup must all agree.
This means that the declared attempt failed to achieve acceptance; it does not
prove that the placement is unroutable. Missing or ambiguous execution evidence
stays unknown. Unfulfilled native obligations remain unfulfilled, and an
unreached final gate remains unreached. Failed attempts supply no accepted
copper quality or successful-completion time; terminal duration stays separate.
Reobserve original evidence under the new contract without rewriting earlier
datasets, model inputs or outcomes. No routing retry is needed for this readback.
Rule-coverage admission checks custom rules and typed native project/netclass
minima before the solver. Retain any blocked cause and its source/DSN-bound
report; it supplies neither route completion nor accepted copper-quality labels.
Project hashes alone do not prove coverage: actual final DSN clearance floors,
complete final width/edge/neck argv controls, executable and backend policy are
bound to the immutable per-stage model. Missing, duplicate, weaker or unknown
applicable controls stop admission.
Positive drilled-obstacle containment requires the reviewed quality-first
binary/patch/manifest/native-evidence bindings and actual `--quality-first`
command. It supports the exact one-layer circle/rectangle subset, including
physical pad aliases, circular NPTH keepouts and retained vias, on the verified
`um`/`resolution um 10` grid (0.1 micrometre). NPTH gets no wire-to-pin credit.
Slots, oval/path obstacles, offsets, mirrored or off-grid geometry and opaque
legacy backend geometry remain unsupported. Custom PTH rules still reject
same-net coverage; the KiCad 10 project track rule has only its explicit sourced
same-nonzero-net exclusion after full drilled-inventory binding.
Filling zones does not prove `min_resolved_spokes`. The complete no-zone or
explicit solid/none/no-thermal-override subset can establish inactivity. Strict
model-only routing still blocks applicable thermal requirements. The explicit
`routing-policy.v2` native-checkback mode can leave only the authored project
spoke minimum pending after a source-bound fresh native input check. Such an
admission is not DSN coverage. The exact saved final candidate must satisfy the
native obligation with checked successful fill, raw DRC, unchanged rule/count
and error/exclusion policy, and actual runtime bindings before positive
acceptance or accepted-quality targets can become training eligible. Pending or missing proof supplies no accepted
quality label. All fresh configured gates remain required. Creepage and spatial
constraints remain blockers. Exact inactive-layer and unchanged-silkscreen decisions use actual
active-net masks; silkscreen immutability requires no new vias and preserved
source/import geometry. Complete fresh candidate gates remain required for any
new accepted label. Earlier sealed native outcomes stay immutable historical
facts under their recorded controls, not proof of current admission or a new
successful route.
Repeated-failure decisions must bind the exact placement and execution policy
and use `placement_outcomes.native_diagnostic_fingerprint` for native findings.
It ignores diagnostic UUIDs and finding/item order while preserving every
semantic value. Unknown diagnostics have no fingerprint. Stop collection as
soon as the declared fit-admission requirements can no longer be met.

The two copper labels measure the exact sealed final native candidate bound to
the fresh gate, only after acceptance within the owned budget with verified
execution controls. Length is the sum of straight copper-segment centreline
lengths in millimetres across all nets and copper layers. Via count counts native
via objects, including blind/microvias when their required geometry is supported.
Both include retained input copper. Length excludes pad/zone copper and vertical
via length; it is not a measure of electrical quality or newly routed copper.
Copper arcs or malformed/nonfinite segment geometry leave length unknown with a
cause; a well-formed via count can remain independently known. Failed, timed-out
or control-unknown runs receive neither successful quality label. These are
post-route targets and never pre-decision features or engineering qualification.

`added_route_track_length_mm` uses the versioned definition
`iot-lab.native-added-straight-track-length.v1`: accepted final straight-track
length minus the original retained straight-track length. It additionally
requires a native geometry multiset proof that every original track and via
remains, with multiplicity, net, layers and dimensions preserved. Item order,
equivalent decimal notation, straight-segment direction, UUIDs and locking do
not change copper geometry; other native attributes remain exact. Arcs,
unsupported geometry, changed/missing source copper or an invalid difference
leave the new target unknown with a cause; no zero clamp or assumed tolerance
is applied. Whole-board length retains its existing meaning independently.
Each row binds both original native files and records the source/final lengths
and preservation verdict. Re-extracting historical accepted receipts requires
no repeated native gates, while source hashes and original seals are checked.

The residual removes fixed board copper from the learning target. It does not
change ranking within a case whose retained copper is constant, or establish
that the current global geometric features explain local routing detours.
Already-inspected validation cases can become development data only in a new
dataset/model with explicit lineage; they cannot then be claimed as unseen
validation or test cases. Independent repeats do not create extra board cases.

Routing-case identity preserves authored zone boundaries, settings, UUIDs and
connectivity, and all retained segments, arcs and vias. Only derived zone
`filled_polygon` and `fill_segments` caches are excluded, so zone refill alone
does not turn placement alternatives into separate cases. All alternatives and
repeats of a case still belong to one split.

The `workflow` adapter accepts the same sealed run descriptors without
`placement_input` or `execution_policy`. It supports operations across the PCB
workflow, including parts, schematic, placement, routing and verification.
Its features use only pre-run budget, operation and declared manifest flags;
targets are `run_passed` and `owned_elapsed_s`. A passed tool operation does not
mean a part or physical board is qualified. Sealed pre-decision source context
helps distinguish underlying tasks across copied run paths.

Invalid or missing attempts remain visible and ineligible with reasons. Dataset
construction can return blocked while retaining a diagnostic dataset artifact.
Existing inputs are hash-checked on load and before/after operations. Historical
missing paths remain diagnostic; they are not fabricated training examples.

## Fit, evaluate and predict

Available algorithms are `mean` and `ridge`. Ridge standardises using eligible
training rows only, exposes its coefficients and regularisation, and uses no
implicit missing-value imputation. Binary outputs are bounded scores, not
calibrated probabilities. Case, placement and repeat weighting prevents a case
with many reruns from dominating the fit or reported metrics.

Evaluation reports validation and test separately against a constant baseline
fitted on training data. It also reports available case-level selection and
proxy comparisons. Missing folds block a complete evaluation. Unknown outcomes
stay visible, including when a ranking selects an unlabelled candidate. Split
lineage prevents changing an inspected validation family into an unseen test.
No fixed sample count or score grants readiness: a useful improvement requires
an independently defined experiment and actual held-out routing results.

Prediction takes source inputs through the matching extractor:

```json
{
  "schema": "iot-lab.pcb-ml-features-request.v1",
  "id": "new-placements",
  "adapter": "routing",
  "samples": [
    {
      "id": "candidate-1",
      "source": {
        "path": "/absolute/unrouted-candidate.kicad_pcb",
        "sha256": "SHA256_OF_CANDIDATE_PCB"
      }
    }
  ]
}
```

For workflow prediction the source is the pre-run `run.json`. Feature packets
contain no targets and prediction re-extracts their measurements; resealing
edited feature numbers is insufficient. Unsupported samples remain unscored.
Models are JSON, contain their training lineage and bind logical implementation
hashes. Deploying a model needs current matching code and new feature sources;
the original training directory and Python executable path need not exist.

`pcb_ml_data.ts` and `pcb_ml_models.ts` also expose the reusable numeric contract
for another narrowly scoped, evidence-backed adapter. Add its pre-decision
features, source verifier and meaningful labels before adding model complexity.

## Verify the foundation

```sh
cd tools
python3 -m unittest test_pcb_ml_data test_pcb_ml_models test_pcb_ml_adapters test_pcb_ml_backend test_pcb_ml_cli
```

The bounded real-board family comparison and its retained stop condition are
recorded in [the 2026-10-18 study result](../hardware-design/reports/placement-ml-family-study-2026-10-18.json).
It preserves the pre-label prediction seal, actual production-score selections,
accepted validation routes and the unlabelled PWR identity blocker. The model
remains advisory; the complete held-out test was not reached.
