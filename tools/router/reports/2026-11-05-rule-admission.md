# Rule compiler admission audit (#1353)

The current Rust compiler already refuses the four historical partial translations. They must remain refused until their full semantics have an implementation; this change adds no routing support for them.

| Authored constraint | Current compiler result | Reason |
| --- | --- | --- |
| `track_width (min 0.8mm)` | unknown / admission refused | Net width is selected from opt only |
| `length (min 20mm) (max 30mm)` | unknown / admission refused | Net length retains max only |
| F.Cu `track_width (opt 0.4mm)` | unknown / admission refused | One scalar width cannot represent layer scope |
| `via_diameter (min 0.5mm) (max 0.7mm)` | unknown / admission refused | Via geometry retains min only |

The remaining bypass was the direct solver entrypoint. `iotroute model` writes a diagnostic model even when it exits 1 for unknown rule coverage. `iotroute MODEL OUT` previously ignored those coverage rows and could route that refused model. The solver now validates coverage before loading geometry or writing checkpoints/results, and exits 2 with each refused rule's name, constraint, and reason.

Models declaring `iot-lab.route-model.v0` require a rules array; malformed rows and unknown state names also fail admission. Legacy models without a schema or rules remain compatible. This is an admission check of compiler evidence, not independent verification of edited model JSON. Admitted proposals still require the existing native and independent gates.

No rule values, units, net-class selection, precedence, endpoints, or search algorithms change. The four regression cases run the Rust rule compiler and coverage pass, serialize their real reports, then invoke the binary directly. Refusal must happen without creating output or a checkpoint. Existing admitted routing tests cover compatibility.

Validation on 2026-11-05:

- Before the guard, the first regression failed: the refused minimum-width model exited 0, routed a net, and wrote four checkpoints.
- Hetzner / Rust 1.93.1: both boundary tests passed (four compiled refusal cases plus malformed-report and admitted-state coverage).
- One retained ENV-SENSE model on Hetzner, seed 7 and six passes: released `696715d` versus this change produced byte-identical route JSON, SHA-256 `e84ae5bf827bcf1e67bea668808cfd7ff569a9291a4ea9f140f0707c2a4c26d3`. Both reported native PASS, 171 tracks, 30 vias, zero failed nets, seven notes, and `converged false`. This is an admission compatibility comparison, not independent board qualification. Only scratch JSON was written; no board was modified.
