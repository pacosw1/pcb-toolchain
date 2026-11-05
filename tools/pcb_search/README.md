# pcb_search

Proposals on native board text and cheap pattern routing. Nothing here qualifies a board: native DRC, connectivity and the
board's own gates decide. Source boards are never edited; every mode writes new files.

## core/: the Rust crate `pcbsearch`

```sh
cargo test --locked --manifest-path tools/pcb_search/core/Cargo.toml
cargo run --release --manifest-path tools/pcb_search/core/Cargo.toml -- MODE ...
```

| Mode | What it does |
| --- | --- |
| `route INPUT --output OUT --budget-s S` | Same-layer L and Z paths on an `iot-lab.route-problem.v1` model |
| `native-candidate SOURCE CANDIDATE OUT --net NET...` | Keep only new copper on the named nets from a backend's board |
| `native-eco BOARD VIA ALONG OUT --fraction F` | Move one via along a trace and bridge on the other layer |
| `native-conflicts EXPORT OUT --fraction F... --budget-s S` | Pick one via repair from attributed DRC evidence |
| `geometry-digest BOARD [--omit ID]...` | Hash of every board form except the named routing items |
| `source-set BOARD` | SHA-256 of the board and its three sidecars, as JSON |
| `fingerprint FILE` | Hash of a JSON file |

Exit codes: 0 complete, 3 stuck, 2 refused. A partial route is STUCK. PASS means complete in this model, never native acceptance.

- `pyjson.rs` writes JSON text exactly as Python does, so hashes match the former `contracts.py` `fingerprint`. Anything that hashes JSON
  belongs here or calls `pcbsearch fingerprint`: JavaScript's `JSON.parse` loses the difference between `1` and `1.0`.
- `decimal.rs` holds Python's `Decimal` text rules. Normalized numbers get hashed, and `100` normalizes to `1E+2`.
- `native/` is text work on KiCad 10 files, on the raw reader `tools/router/core/src/kicad/raw.rs`. Hashes cover the undecoded
  text. Board semantics come from `iotroute board-json`, not from here.
- `contract.rs` and `patterns.rs` are the route problem and its search. Exhausting the few patterns is not proof of
  unroutability. See `problem()` in `core/src/patterns/tests.rs` for the full input.
- `tests/fixtures/*-golden.json` are records written by the Python implementation. They cannot be regenerated once it is gone,
  so a difference there is a change of behaviour.

## Migrated helpers

The Python helpers have been removed. Use `pcbsearch fingerprint` for JSON fingerprints;
`tools/lib/native-board.ts` provides `footprints` and `footprintSignature` for TypeScript callers.

## Removed

`--router engine` and what only it fed are gone (#1324): the engine, `native_export`, the SRJ export and import, capacity
routing and the tscircuit adapter, local repair, `place`, packing, regional widths and the TraceMaker adapter. Tag
`pre-engine-delete` has all of it, in Python and in Rust. `tracemaker/Dockerfile` and `upstreams.json` stay for the TraceMaker
benchmark rerun (#1378). `tools/tracemaker_bench.sh` uses `iotroute board-json` and the native model on the retained
frozen NET-CORE project. It runs only in a dedicated Linux scratch directory; see
`tools/router/benchmarks/1378-baseline.mjs` and the benchmark report for the resource policy and input provenance.
