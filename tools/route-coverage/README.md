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
