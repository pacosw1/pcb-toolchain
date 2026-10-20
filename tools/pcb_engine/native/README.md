# Apple compute worker

`pcb_engine.compute.ComputeWorker` is the sole Python adapter. It builds a
content-addressed C++20/Objective-C++ executable below
`~/.cache/iot-lab/pcb-engine` using Xcode's compiler, then keeps one worker alive.
No package is installed into KiCad Python. `PCB_ENGINE_BUILD_DIR` overrides the
cache location.
The cache identity includes adapter/build policy, native sources, compiler, SDK
and host architecture. Reuse requires a matching build receipt and binary hash;
changed or corrupted executables are rebuilt.

The worker accepts bounded JSON objects, one per line, with `id`, `revision`,
`op`, and `backend` (`cpu`, `metal`, `auto`). Responses echo identity and contain
`ok`, `result` and `metrics`, or `ok: false` and `error`. Unsupported custom-rule
metadata does not disable mathematical jobs; none of these operations establishes
rule compliance or board acceptance.

| Operation | Inputs | Result |
| --- | --- | --- |
| `capabilities` | None | Metal device and availability, compilation time, limits |
| `snapshot.put` | Immutable source revision, operation and input data | Snapshot identity for later sparse requests |
| `placement_hpwl` | Candidate arrays of XY pad positions; nets of pad indices | One float HPWL per candidate, explicitly an incomplete objective |
| `congestion` | Width, height, integer-coordinate segments | Integer bounding-box demand map |
| `cost_field` | Width, height, optional layers, blocked and target flat indices, optional max_sweeps | Integer six-neighbor relaxed field, convergence status |
| `coreml.*` | See `coreml.hpp` and the ML adapter | Model lifecycle, advisory inference and anticipated compute placement |

Metal pipelines and shared buffer allocations are retained across requests.
`worker.prepare(op, revision=..., **data)` sends immutable inputs once and returns
a snapshot ID. Subsequent `request` calls may provide that ID and changed fields;
operation/revision mismatches fail. HPWL accepts `candidate_deltas`, one array of
`[pin_index, dx, dy]` changes per proposal, relative to the snapshot's single
base candidate. This avoids repeating unchanged board geometry and nets over
JSON. The worker expands sparse proposals into reusable Metal buffers.
The snapshot cache holds at most eight inputs and 16 MiB. Congestion and field
snapshots reuse unchanged JSON inputs; the first version recomputes their entire
bounded output region rather than maintaining a mutable global map.
Field sweeps are submitted in groups of 32, with explicit dependencies between
encoders. A field that has not converged remains marked as such. Distances assume
unit planar/layer moves; they are guidance only and must not prune exact routes,
certify reachability or be called admissible under unrelated routing rules.
The CPU field implementation uses linear-time bounded BFS, so calibration compares
against an appropriate CPU algorithm rather than scalar copies of GPU sweeps.

CPU and Metal HPWL use float32 in the native worker; the Python reference uses
Python floats. Small rounding differences are expected. Complete CPU rescoring
and native geometry verification remain required for acceptance.

`metal` explicitly requests real GPU dispatch and falls back to CPU if Metal
initialization is unavailable. `auto` uses CPU until a matching promoted workload
calibration exists. `worker.calibrate(op, revision=..., **data)` alternates warmed
CPU/Metal requests, checks parity and actual dispatch, and promotes only a median
round-trip gain of at least 10% with no p90 regression. Profiles bind worker,
shader and adapter source hashes, hardware, input revision and workload shape.
HPWL profiles bind net topology, candidate/pin counts and sparse delta counts;
grid profiles bind the exact workload. Profiles live in the local build cache,
overridable by `PCB_ENGINE_CALIBRATION` or `calibration_path`. Calibration is
numerical workload evidence, never board completion evidence or model promotion.
Worker timing, actual dispatch count and Metal GPU timing are reported separately
from Python round-trip time.

The adapter reserves one CPU and an estimated 0.5 GiB from the existing cooperative
resource ledger for its lifetime, reusing a live inherited reservation. This is
shared-memory admission, not an OS memory limit. The native worker separately
bounds grid cells, request work and retained Metal buffers (128 MiB). Core ML
applies its own model cache/source-size bounds. Callers can request a larger
memory reservation for their surrounding workload.

Run `PYTHONPATH=tools python3 -m unittest tools/test_pcb_engine_compute.py -v`
for CPU bounds/fallback and actual Metal parity tests. Metal tests skip only when
the platform/device is unavailable; they assert dispatch rather than merely
compilation or configuration.

## Existing CLI entrypoints

Use the existing supervisor and sealed evidence workflow:

```sh
tools/pcb routing --json compute-status ENV-SENSE
tools/pcb routing --json compute-calibrate ENV-SENSE --request request.json
```

The calibration request is a JSON object with schema
`iot-lab.compute-request.v1`, `revision` equal to the current native PCB SHA256,
`op` naming one mathematical primitive, `data` containing its bounded inputs,
and optional `repetitions` (5 to 31, default 9). Arbitrary native operations,
model paths and snapshot handles are rejected at this public boundary.

These observations never modify CAD or global production calibration settings.
Capabilities, measurement samples and a source/hardware/workload-bound profile
are sealed inside the run's operation directory. Later engine runs must select
that profile explicitly through `PCB_ENGINE_CALIBRATION`; a changed revision,
implementation, device/OS or workload cannot inherit its promotion.
