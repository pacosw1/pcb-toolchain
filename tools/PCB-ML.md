# Small models for PCB development

`tools/pcb ml` builds numeric datasets from sealed workflow observations, fits a
small model and scores new source inputs. It shares the CLI supervisor, run IDs,
streamed events, timeouts, cleanup and artifact seals. All outputs are advisory.
Training and prediction do not change CAD, enable the old CNN surrogate or
authorise model adoption. Numeric work uses Python's standard library; collecting
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
and retained copper; all-net pad-centre HPWL and pairwise distance sum; two-pad distances; and the board
outline's bounding-box area. HPWL is a geometric measurement, not routed length
or the production placer's weighted score. Unsupported geometry remains unknown.
Feature values, units and extractor hashes form a versioned contract.
Routing contract v2 counts unique nonempty names in both legacy net tables and
KiCad 10 pad-local declarations; unresolved numeric net references stay unknown.
The pairwise sum measures unordered pad-centre pairs within each named net, in
millimetres. It can distinguish interior pad movements that leave HPWL unchanged.
Rebuild datasets and models after an extractor-contract change.

Routing targets are `accepted_within_budget`, `owned_elapsed_s`,
`successful_completion_elapsed_s`, `native_errors`, `native_opens` and
`native_parity`, plus accepted-only `routed_track_length_mm` and
`routed_via_count`. Acceptance uses full fresh-gate success within the owned run's
`run.json:timeout_s`; the solver's separate time limit remains recorded.
`owned_elapsed_s` measures time to any terminal outcome. Successful completion
time stays unknown for a failure or timeout, with censoring recorded explicitly.
Unknown controls or incomplete native evidence never become invented labels.

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

`pcb_ml_data.py` and `pcb_ml_models.py` also expose the reusable numeric contract
for another narrowly scoped, evidence-backed adapter. Add its pre-decision
features, source verifier and meaningful labels before adding model complexity.

## Verify the foundation

```sh
cd tools
python3 -m unittest test_pcb_ml_data test_pcb_ml_models test_pcb_ml_adapters test_pcb_ml_backend test_pcb_ml_cli
```

`pcb_ml_smoke.py` runs three distinct passive native net topologies with two
placements each through actual KiCad checks and controlled Fastroute, then all
five ML actions for both adapters. It requires the original read-only Docker
inspection receipt in `PCB_EXECUTION_CONTEXT`, KiCad 10.0.6 and Fastroute 0.1.7.
Use a fresh owned output folder and bounded server execution. The six tiny
routing trials verify integration and split wiring; they do not establish
generalisation, optimal placement or improved routing on production boards.
