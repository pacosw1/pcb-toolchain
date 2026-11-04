# Route coverage in Rust

Ports of `route_hole_coverage.py`, `route_project_coverage.py`, and
`route_native_thermals.py`. The Python files and their tests stay while the
unported route-job and engineering modules still import them.

Build with `cargo build --locked --manifest-path tools/route-coverage/Cargo.toml -j 2`.
The `route-coverage` binary accepts an operation and a JSON request file (or
stdin), and prints JSON. Operations: `inspect`, `inspect-drilled`,
`native-pth-pads`, `native-drilled-geometry`, `evaluate`, `admit`,
`validate-capability`, `discharge`. Request fields retain the Python argument
names; `evaluate` builds its conservative model from `dsn_text`. Native reads
invoke `IOTROUTE_BIN` (default `iotroute`) with `board-json BOARD` and verify the
board/project/rule hashes. No Node or Python is needed in the job.

Containment uses arbitrary precision decimals and squared distances. There is
no new numerical tolerance. The backend grid bound and patch are the same
reviewed upstream contract as the original check.

The current shared board JSON omits via type/layer extent. Such inventory rows
remain present and unsupported; they cannot receive a false through-via proof.

Two intentional provenance changes require fresh evidence:

- `native_form_sha256` binds normalized API geometry instead of parsed source
  text; native inventory millimetres use the API's whole nanometres.
- Native thermal implementation v2 binds one compiled validator artifact.
  Separate interpreted helper/parser origins and historical v1 implementation
  role records are removed. The recorded producer artifact remains required;
  another copy must have identical bytes. Existing fill/DRC receipt schemas
  remain accepted; the validator never executes their recorded tools.

Targeted tests: `cargo test --locked --manifest-path tools/route-coverage/Cargo.toml -j 2`.
Synthetic native receipts test validation only; no actual KiCad run is implied.

## Mac-side routing decisions

`node --experimental-strip-types tools/route_decision.ts` supplies `diagnose`,
`repair`, and `escape`. The implementation is split across
`tools/lib/route-decision*.ts`; typed board reads use `lib/board-json.ts`, edits
use `lib/board-edit.ts`, and hashes use the existing shared helpers. Python
`route_decision.py` remains for its unported engineering/operation callers.

The TypeScript port removes the obsolete compute-status/compute-calibrate
branches (their pcb_engine package has been deleted), Python/pcbnew/NumPy
runtime assumptions, temporary native-conflict receipts, and wall-clock-based
via selection. Source positions use integer nanometres and exact intersection
arithmetic. The allowed via fractions and ranking stay the same. Pad rejection
envelopes round outward to whole nanometres; widths receive no extra credit.
API geometry and port implementation hashes give plans new provenance, so
existing Python plans must be regenerated.

Escape generation needs `ROUTE_GRID_BIN`, an executable adapter for the native
grid port. It accepts `escape BOARD --skip '' --layers F.Cu,B.Cu --out FILE`.
Its pin-escape-evidence.v1 result must bind the context's feature file and
executable in `generator_inputs`, preserve the effective feature/model fields,
and record `runtime.schema = iot-lab.escape-runtime.v2` with nonempty `files`
descriptors, including that executable. Context schema is escape-context.v2.
No Python fallback is run. The actual grid adapter is outside these four files;
this interface has only been exercised with synthetic producers.

Latest targeted evidence: 13 hole, 9 project, and 13 thermal Rust tests pass;
18 Node decision tests pass, including stale receipts, one guarded gap edit,
exact crossings, missing via extent, and escape-cache invalidation. Targeted
TypeScript typechecking passes. The hole proof also rejects differences beyond
100 decimal places: every finite division is exact, with no library precision
limit silently rounding a boundary into coverage.

No Python baseline, real-board board-json read, native save/DRC, full configured
gate, or daemon/grid integration was run. The tests use synthetic boards and
receipts and make no native-validity claim. No Python files were deleted.
