# Route coverage in Rust

The hole, project and native thermal proofs of the route job. The thermal
validator reads receipts; `iotroute fastroute` writes none, and
`--native-thermal-checkback` is an error there, because a receipt needs
`ZONE_FILLER.Fill`'s result, which only pcbnew reports.

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

Board JSON gives each via its `via_type`: Through, Micro, BlindBuried, Unknown,
or Custom for a through via with a padstack of its own. Anything but Through, or
a via with no type or layer extent, stays in the inventory unsupported and cannot
receive a false through-via proof.

The API lists a `*.Cu` pad on every copper layer KiCad knows, enabled or not, so
it cannot tell a wildcard from a pad naming a disabled copper layer. Such a pad is
refused from the `layers` of the hash-bound `.kicad_pcb` text, read by pad uuid; a
drilled pad the file does not list is refused too. Geometry still comes from the
API.

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
use `lib/board-edit.ts`, and hashes use the existing shared helpers. The former
`route_decision.py` entry point has been removed.

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

Latest targeted evidence: 112 Rust tests of this crate pass (hole 45, admission
24, project 9, thermal 31, DSN floor 3). The hole proof also rejects differences
beyond 100 decimal places: every finite division is exact, with no library
precision limit silently rounding a boundary into coverage.

Compared with `fastroute_job.py` before its removal (2026-11-04), same input to
each, on scratch copies:

- ENV-SENSE, one net: blocked with the same cause, 24 requirement rows equal.
- ENV-SENSE with `min_resolved_spokes` 0 in the copied project, features
  rule_compiler, via_off_small_pads and via_halo on: admitted, routed, the same
  288 copper items, and equal requirement rows and rules.log.
- CHECKIN with `min_resolved_spokes` 0, GND plane vias: blocked with the same
  cause, 27 requirement rows equal, equal DSN wiring in another order.

These runs did not reach a thermal proposal, a replay of preserved copper, a pose
rounded onto the grid, a layer mask or class pair, a quality backend manifest,
native thermal checkback, or a positive PTH proof past admission. Those have
tests with synthetic boards and receipts only.
