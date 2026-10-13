# Integrated automatic placement and routing — CIP 839

The goal is better complete boards, measured by time to compliant output under the
same requirements. Placement and routing form one feedback loop. We select useful
algorithms from current upstream projects and our own tools by controlled board
results. The user's search-engine example describes selective effort; it does not
limit the design to a scheduler.

## Current implementation

This package is an **experimental proposal kernel**, not the completed placer/router
or a production pipeline replacement. It does not modify CAD or qualify a board.

* `contracts.py` requires explicit trace widths, per-net and pair clearances, layer
  masks, obstacle envelopes, edge rules, sources and input fingerprints. Unknown
  fields are errors. Known but unrepresented requirements cause abstention.
* `patterns.py` tries deterministic, same-layer orthogonal L/Z paths using the actual
  net width. It preserves input copper envelopes and checks new paths against one
  another. Exhausting these few patterns is **not proof of unroutability**.
* `placement.py` uses our existing `placer.cost` geometry, including fixed/fixed
  conflicts excluded by its search objective. A bounded coordinate descent can
  propose translations of intact units while preserving fixed parts and avoiding
  regressions in congestion, via-access and wirelength proxies. This small stage
  does not replace global placement or annealing. Derived fanout geometry is bound
  to owner geometry and pose; moving its owner requires regeneration.
* `__main__.py` writes a separate, new JSON proposal with input and implementation
  fingerprints. Partial routes return `STUCK` and exit 3. `PASS` means a complete
  proposal in this model, never native acceptance. Existing output is refused.

Run from the repository root:

```sh
PYTHONPATH=tools python3 -m unittest -v tools.test_pcb_search
PYTHONPATH=tools python3 -m pcb_search route route-model.json --output new-route.json --budget-s 1
PYTHONPATH=tools python3 -m pcb_search place placement-model.json --output new-placement.json --budget-s 1 --steps-mm 1 0.5
```

Placement input has exactly `problem`, `params` and `attachments`; `problem` is the
existing `placer.cost` JSON model. An attachment has `id`, `owners`, `anchor_sha256`
(from `anchor_fingerprint`) and `geometry_sha256`. These hashes describe bindings;
the caller must verify the associated files. Search steps and time budgets are
effort policies, never electrical allowances. The placement timeout is cooperative
between score evaluations; an outer process deadline is required for heavy runs.

Route input uses schema `iot-lab.route-problem.v1`. See `routing_problem()` in
`../test_pcb_search.py` for the complete structure. Geometry is in millimetres,
in KiCad coordinates. Obstacles are conservative rectangular envelopes; mechanical
obstacles use an empty net. A connection's layers must be accessible at **both**
endpoints. `inputs` records SHA-256 values, not permission to trust an incomplete
export. A CAD exporter and native round-trip validator are still required.

## Integration decisions and remaining work

1. **Resolve intent and reuse proven blocks.** Apply atopile's explicit interfaces,
   constraints and hierarchical module identity. Reuse the existing #833/#834
   block work after checking its exact input and target bindings. Keep KiCad as CAD
   authority. Ports, pad mappings, rules, orientation, power domains and revision
   must match before reusing placement or copper.
2. **Place for routing.** Keep our rigid blocks, fixed connectors, electrical domains,
   global placement and annealing. Compare tscircuit outline packing where it fits;
   check that the backend returned every unit exactly once. Evaluate pin escape,
   congestion, return paths and high-current corridors before full routing. Cheap
   scores rank proposals; actual routing decides whether a placement helps.
3. **Route by problem.** Try reusable copper and inexpensive patterns first. Use
   tscircuit capacity/topology and coordinated fanout for the applicable remainder.
   Compare TraceMaker and our existing router with identical constraints and
   frozen inputs. Preserve widths, layer masks, differential-pair rules, fixed
   copper, holes, pours and isolation rules across every format conversion.
4. **Repair locally.** TraceMaker's `routable.cpp` suggests a useful approach: use
   failed connections to identify nearby movable parts, propose bounded moves,
   regenerate owned escape geometry, and reroute the affected region. Do not
   restart unrelated work. Preserve the previous candidate until native evidence
   verifies the replacement. No repeated blind retries.
5. **Escalate only remaining ambiguity.** An LLM receives a small failure package
   with rule sources, exact geometry and unsuccessful attempts. Its proposed move
   or algorithm choice passes the same deterministic rules. It cannot relax rules
   or approve its own candidate.
6. **Validate and adopt.** Native KiCad DRC/connectivity, schematic parity, current
   paths, reference planes, pair constraints and existing fabrication gates decide
   acceptance. Benchmarks progress from the smallest relevant committed boards to
   increasingly constrained designs. Record completion, violations, vias, length,
   changed area, rework and end-to-end time. No speed claim from toy fixtures or
   evaluations per second. Only a demonstrated winner becomes a default.

Stage reuse must include board, schematic, rules, libraries, derived geometry,
adapter, backend version and parameters in its fingerprint. This package does not
yet implement a cache or the multi-backend execution loop. Native artifact
validation, complete adapters and controlled real-board comparisons remain open.

## Source audit

Exact observed revisions and files reviewed are in `upstreams.json`. These are
audit pins, not claims that all dependencies are installed or integrated. The audit
checked current upstream heads on 2026-10-13. Refresh and pin before benchmarking.

* [tscircuit autorouter](https://github.com/tscircuit/tscircuit-autorouter/tree/46f4fdf941ad2ca641f6e090cf592012b35b3da6)
  combines capacity, topology and detailed repair stages. Its own completed-but-
  DRC-failing benchmark cases reinforce the need for independent acceptance.
* [calculate-packing](https://github.com/tscircuit/calculate-packing/blob/c177bc54418b61441653c57079bdc435723fef72/lib/PackSolver2/PackSolver2.ts)
  supports static parts, rotation choices, weighted connections and boundaries.
  It filters parts without valid pad geometry, so adapter cardinality checks are
  mandatory. Its uniform `minGap` does not replace our electrical rule system.
* [placement analysis](https://github.com/tscircuit/circuit-json-placement-analysis/blob/c42d5a3a5dc28a364eba8feb466401544e3609e0/lib/buildPlacementAnalysisReport.ts)
  produces focused geometry/orientation issues useful for diagnosis. Suggestions
  still need complete board constraints and validation.
* [TraceMaker routable placement](https://github.com/DingoOz/TraceMaker/blob/c6fcb7b4912bdabefeb7f4191c011b1a086335e0/src/place/routable.cpp)
  evaluates routing outcomes and local moves. Its source is GPL-3.0; retain license
  obligations if incorporating code. The initial kernel here contains no copied
  upstream implementation.
* [atopile layout reuse](https://github.com/atopile/atopile/blob/619eda7f777558a3e500dbad9cc2941712881495/src/atopile/layout.py)
  maps module identities to sub-PCB layouts. This is a useful reuse boundary,
  separate from routing search.
* [KiCad 10.0.7](https://www.kicad.org/blog/2026/10/KiCad-10.0.7-Release/) is the
  current stable release observed in this audit. The local bundle and tested
  routing-server image are 10.0.6. Mac native startup probes stalled; the server
  successfully imported `pcbnew`. No native acceptance was inferred from that
  runtime probe, and no system installation was changed.

Claude's clean `ac24c-floorplan` worktree and this branch both started at
`5482542cc382f99fd7b89fda81ecebce1649bfd7`. Newer uncommitted AC24C dogbones,
pour protection and a clearance change were found in the primary checkout and
preserved. Incorporation requires source evidence and a controlled comparison.
