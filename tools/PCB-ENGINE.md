# Stateful placement and routing engine

The existing `tools/pcb` CLI owns admission, processes, isolated candidates,
verification and adoption. `--router engine` adds a bounded search session behind
that interface. Agents submit a job policy and inspect its run; they do not stitch
together native exporters, solver commands or acceptance receipts.

This is an opt-in engine. Existing explicit proposals and controlled Fastroute
policies retain their behavior. The new engine has not established broad
completion/quality superiority over those workflows.

## Submit a job

```sh
tools/pcb context ENV-SENSE --json
tools/pcb next ENV-SENSE --json
tools/pcb route ENV-SENSE --router engine --spec tools/pcb_engine/examples/env-route.json --detach --json
tools/pcb events RUN_ID --after 0 --wait 20 --json
tools/pcb status RUN_ID --json
tools/pcb explain RUN_ID --json
tools/pcb view RUN_ID
```

`view` prints a localhost URL with a session token. It shows native candidates,
layers, connection/error overlays, metrics and attempt history. Cancel and
continue use the same supervisor APIs as the CLI. The preview omits zones and
curved outlines; it is not a clearance or manufacturing check.

An engine policy has schema `iot-lab.engine-policy.v1`:

```json
{
  "schema": "iot-lab.engine-policy.v1",
  "routing": {
    "schema": "iot-lab.routing-policy.v2",
    "thermal_verification": "native-checkback",
    "layers": ["F.Cu"],
    "only_nets": ["/V_GAS"],
    "passes": 20,
    "threads": 2,
    "timeout_s": 30,
    "optimizer": "if-routed",
    "max_repairs": 0
  },
  "max_attempts": 3,
  "movement": {
    "refs": [],
    "max_displacement_mm": 0,
    "step_mm": 0.5
  },
  "compute": "auto",
  "runtime": "native"
}
```

The nested routing policy keeps its existing v1/v2 meaning. Its zero
`max_repairs` forbids separate repairs inside that controlled backend policy;
the outer engine's explicit `max_attempts` bounds engine transactions.
The engine search deadline is the run `--timeout` less a reserve for the outer
native gate: max(60 s, 25 % of the timeout). Admission rejects a policy whose
routing `timeout_s` does not fit in the remaining search time.
Movement requires an explicit reference list and displacement bound.
All incident nets and affected copper layers must be within routing authority.
Locked geometry, fixed units and reviewed groups remain protected.
Before its gate, each candidate is compared with the session input board.
Tracks, arcs and vias on a net outside `only_nets`, or with a layer outside
`layers`, must be unchanged; otherwise the attempt is blocked. Zones are
protected by the design identity check, except their fill caches.

The native Mac runtime uses the existing cooperating resource ledger and
backend worker caps. These are declared reservations, not OS memory/CPU quotas
or network isolation. Its v2 execution receipt records that distinction and
actual tool identities. Legacy container routing still requires its original
inspect receipt and enforced limits. `FASTROUTE_BIN` selects the installed
backend; drilled-hole proofs may additionally require the existing
`FASTROUTE_QUALITY_MANIFEST` with actual artifact validation.

## Engine behavior

The session retains a verified incumbent separately from partial proposals.
It checks the baseline, diagnoses it, tries an applicable guarded gap/via repair,
then controlled routing and bounded local routing/placement work. Every attempt
has an immutable input, strategy, candidate and evidence. Source hashes and
protected identity are checked before selection. Returning the unchanged
baseline is explicitly not an improvement.

The local router supports a bounded two-layer native model, multiple terminals
and native-connected groups. It retains selected-net copper and attempts to
bridge disconnected groups. Its current local paths use a common authorized
layer; unsupported geometry and rules remain explicit blockers. It does not
replace the full-board Fastroute backend or promise general BGA escape.

CPU production scoring retains every active term. GPU pad-centre HPWL is a
separately labelled primitive used for proposal ordering/ties, not a replacement
for weighted pad-envelope HPWL or hard constraints.

The current search proposes bounded translations of diagnosed units, not
placement from scratch. It can stop without a fully accepted board. `next`
reports the recorded engine decision instead of recommending the same blind
retry. `--from-run RUN_ID` continues a sealed candidate with source revalidation.
Interrupted transactions have a durable rollback image.
The session phase is persisted. A resumed `complete` or `blocked` session does
not search again: it returns its recorded `result.json` when the board agrees
with it, and fails closed otherwise. An interrupted session resumes as `admitted`.

Internal configured gates rank candidates. The engine summary has status
`candidate` and `candidate_verified: true` only for a candidate that passed its
internal configured gate. An unverified best candidate has status `unverified`
and exit 1; it still gets the outer gate and its failed receipt. Only the outer
fresh native, configured and board-specific semantic checks can set
`candidate_verified` in the operation result.
`tools/pcb adopt` remains separate, including frozen-board named-defect rules.

## Apple compute

One persistent C++20/Objective-C++ worker owns Metal pipelines, bounded shared
buffers, immutable geometry snapshots and Core ML models. Python owns search
policy. It avoids rebuilding native state for every proposal.

| Work | Execution |
| --- | --- |
| Exact rules, connectivity and final acceptance | CPU/native KiCad |
| Batched pad-centre HPWL and integer congestion maps | CPU reference or Metal |
| Relaxed grid field for local search | CPU BFS or Metal sweeps |
| Model training | Optional isolated PyTorch/MPS |
| Advisory model inference | CPU reference or native Core ML |

Custom rules do not disable unrelated GPU calculations. Grid fields influence
search ordering only; they do not prove reachability, prune exact legal routes,
or certify copper. Every emitted route still passes native import and checks.

`compute: metal` requests actual GPU work, with an attributed CPU fallback if
unavailable. `auto` uses CPU unless a matching measured calibration promotes
Metal. Profiles bind source, hardware/OS, revision and workload. Reports include
actual dispatch counts and queue/round-trip/GPU timing. A selected backend flag
does not establish device use or a board-level speedup.

Use supervised observation commands:

```sh
tools/pcb routing --json compute-status ENV-SENSE
tools/pcb routing --json compute-calibrate ENV-SENSE --request REQUEST.json
```

Calibration requests use `iot-lab.compute-request.v1`, the native board SHA256
as `revision`, a supported mathematical `op`, bounded `data`, and `repetitions`.
The resulting profile stays inside the run evidence. It does not change global
production settings. The native worker protocol and bounds are in
`pcb_engine/native/README.md`.

Measurements on this M3 Max favored CPU for the tested small placement batches
and unit-cost fields. In particular, CPU BFS supersedes an initially slower
scalar sweep reference. Actual Metal dispatch/parity is demonstrated; a general
GPU speedup is not.

## Learned ranking

Create a separate Python 3.12 environment using
`pcb_engine/requirements-ml.txt`; never install Torch/Core ML Tools into KiCad
Python. Set `PCB_ENGINE_ML_PYTHON` to that environment's interpreter for the
supervised ML commands and ranking-configured engine jobs.

```sh
tools/pcb ml --json engine-public-corpus DEMO --manifest tools/pcb_engine/examples/kicad-ecc83-public-corpus.json
tools/pcb ml --json engine-dataset STUDY --manifest CORPUS.json
tools/pcb ml --json engine-train MODEL --dataset DATASET.json --target accepted_within_budget --device mps
tools/pcb ml --json engine-evaluate REVIEW --dataset DATASET.json --model MODEL.json
tools/pcb ml --json engine-export EXPORT --model MODEL.json --precision float16
```

Public source imports verify pinned bytes and retain attribution/license files.
They supply no outcome labels. The engine dataset adapter reads sealed attempts,
pre-decision source features and native execution controls. Only the exact
selected candidate with full outer acceptance can supply accepted quality labels;
incomplete or unverified evidence stays unknown.

The model is a two-hidden-layer ReLU MLP (64/32), compared with ridge and the
declared production proxy. Training/validation/test families are disjoint.
Failed and censored attempts remain in the dataset. Routing feature contracts
bind the exact numerical producer, including Python/math/OS: use the same
interpreter for extraction and inference rather than weakening that contract.

An optional policy `ranking` object names repository-relative `model_path`,
its exact `model_sha256`, optional `package_path`, and `compute_units`
(`cpuOnly`, `cpuAndGPU`, `cpuAndNeuralEngine`, `all`). The model and package
dependencies travel with the snapshot. `allow_experimental` defaults false;
explicit experimental ranking never changes acceptance authority.

Models stay frozen for a run. Invalid/OOD inputs use deterministic ordering.
At least 25 percent of selected proposal slots are reserved for deterministic
exploration. Predictions never drop rules, accept copper or change a model
automatically.

Core ML records allowed devices and anticipated compute-plan placement
separately from measured execution. Tested small FP16 models support the Neural
Engine but preferred CPU on this host. Successful inference under
`cpuAndNeuralEngine` is not proof of ANE dispatch. No model or ANE speedup has
been promoted from the synthetic numerical smoke tests.

## Validation and rollout

Run engine unit/parity tests plus existing CLI, workflow, diagnosis and ML
regressions.

Native success on a gap fixture proves lifecycle integration, not whole-board
search superiority. Keep default routing unchanged until matched development
and confirmation families establish better accepted completion without
regression. Include failed work, cold setup, verification and synchronization
in performance comparisons. Package-wide escape planning, broader native
geometry support and placement from scratch remain future extensions.
