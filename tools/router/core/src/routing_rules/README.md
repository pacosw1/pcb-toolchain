`cargo build --manifest-path tools/router/core/Cargo.toml -j 2 --bin routing_rules`
builds a route-image executable with no Python, Node or KiCad runtime dependency.
It reads one JSON object from stdin and writes one JSON result. Errors exit 2.

The `op` field names a function from `tools/routing_rules.py`; the other keys are
that function's named arguments. For example:

```json
{"op":"stage_plan","nets":["/SCK","/LED"],"info":{"clocks":["*SCK*"],"pairs":[],"fast":[],"current":[],"spec":{}}}
```

The result is `[["pairs_clocks",["/SCK"],true],["rest",["/LED"],true]]`.
All public operations are available, including board_info, layer_keepouts,
add_keepouts, via_report, hot_loop and repair_selection. Coordinates are mm, y
down; DSN keepouts convert to micrometres, y up. Sorted collections make output
deterministic. Glob matching and decimal rounding use the shared model helpers.

The Python implementation stays only because fastroute_job.py still imports it.
Its tests have moved to tests.rs: `cargo test --manifest-path
tools/router/core/Cargo.toml -j 2 --bin routing_rules` (13 targeted tests).

The old DSN insertion fallback (`text[:-1]` when there is no via or rule) is gone:
the port inserts at the structure boundary and rejects a missing structure.
Nonpositive scan grids are rejected before allocation.
