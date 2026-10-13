# Integrated automatic placement and routing — CIP 839

The goal is better complete boards, measured by time to compliant output under the
same requirements. Placement and routing form one feedback loop. We select useful
algorithms from current upstream projects and our own tools by controlled board
results. The user's search-engine example describes selective effort; it does not
limit the design to a scheduler.

## Current implementation

This package is an **experimental proposal kernel**, not the completed placer/router
or a production pipeline replacement. Native experiments write new copies only;
none of these proposal stages qualifies a board.

The CIP CPU unit-test job runs these contracts and regressions on every workflow
check. Native and installed Node backend integration tests remain explicit,
separate experiments; their skips are not native acceptance evidence.

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
* `packing.py` invokes pinned `calculate-packing` 0.0.90 as an optional placement
  proposal backend, with a subprocess deadline. It exports intact units with their
  copper-pad envelopes, fixed state, allowed rotations and board boundary. It
  imports positions only, verifies exact component identity/cardinality, converts
  coordinate axes, and screens the original constraints. Fixed mechanical units
  without pads remain obstacles; movable units without physical pad geometry fail
  explicitly. Per-unit rotation, movement bounds, displacement caps and part rules
  remain enforced after import.
* `capacity.py` runs locked `@tscircuit/capacity-autorouter` 0.0.979 topology or
  fanout pipelines. Node permission mode denies network, writes and subprocesses;
  the host enforces a process deadline. Input rule/geometry changes are rejected.
  A blocked-terminal screen avoids searching a contradictory obstacle model.
* `native_srj.py` supports a deliberately narrow two-layer, selected-net round
  trip. It preserves all placement and other native content by comparing parsed
  board forms. Retained diagonal traces use exact centerlines, not their AABBs.
  Scoped proposals restore original copper and discard any backend edits to it.
  A same-layer crossing screen rejects definite shorts before native import.
  This is not complete clearance, connectivity, plane or current-path validation.
* `repair.py` tests one local waypoint shortcut around a crossing. It keeps
  widths, layers, vias and explicit connection anchors, requires elimination of
  all known crossings, and leaves full acceptance to native checks. It does not
  rerun the router or touch protected copper.
* `native_export.py` records native DRC and a fresh placement model. Coarse
  overlap/out-of-bounds conflicts request native reconciliation; they do not by
  themselves prove a physical defect. Structural failures still reject.
* `block_bindings.py` checks a library block against one hierarchical schematic
  instance before placement search: exact MPN/LCSC/value, footprint and side,
  pad definitions, bijective component identity, injective net mapping, and one
  rigid quarter-turn transform. A native export can require that instance to
  remain one intact placement unit. Source/target changes invalidate the binding.
  This does not authorize copper reuse or qualify a level-0 library block.
* `tracemaker.py` runs an explicitly fingerprinted native TraceMaker binary with
  the existing owned-process deadline/cleanup controller. `native_candidate.py`
  rejects edits to any original native form and discards added copper outside
  requested nets. Timeouts and unsuccessful backend exits admit no candidate.
* `__main__.py` writes a separate, new JSON proposal with input and implementation
  fingerprints. Partial routes return `STUCK` and exit 3. `PASS` means a complete
  proposal in this model, never native acceptance. Existing output is refused.

Run from the repository root:

```sh
PYTHONPATH=tools python3 -m unittest -v tools.test_pcb_search
PYTHONPATH=tools python3 -m pcb_search route route-model.json --output new-route.json --budget-s 1
PYTHONPATH=tools python3 -m pcb_search place placement-model.json --output new-placement.json --budget-s 1 --steps-mm 1 0.5
```

Optional packing backend (Node is required):

```sh
npm ci --prefix tools/pcb_search/packing --ignore-scripts --no-audit --no-fund
PCB_PACKING_INTEGRATION=1 PYTHONPATH=tools python3 -m unittest -v tools.test_pcb_search tools.test_pcb_search_packing
PYTHONPATH=tools python3 -m pcb_search place placement-model.json --backend packing --output new-packed.json --budget-s 2
```

The packing adapter defaults to translations only. Supply `--rotation-quarters`
explicitly to evaluate permitted quarter turns. Fixed parts and units marked
`rotate: false` retain their orientation. The uniform packing gap is the largest
input rect spacing: conservative but potentially inefficient for mixed domains.
This backend is not the default and has no demonstrated real-board quality gain.
Missing runtime imports in the published packer's dependency list are supplied by
our explicit dependency pins; `package-lock.json` records the complete resolution.

Optional capacity backend (current Node with permission mode is required):

```sh
npm ci --prefix tools/pcb_search/routing --ignore-scripts --no-audit --no-fund
PCB_CAPACITY_INTEGRATION=1 PYTHONPATH=tools python3 -m unittest -v tools.test_pcb_search_capacity
PYTHONPATH=tools python3 -m pcb_search route-srj srj.json --output new-capacity.json --budget-s 5
```

Native helpers require KiCad Python; placement export also needs numpy. Run
export and import in **separate short-lived processes**: the tested legacy SWIG
runtime corrupts later bindings when detached objects are collected. Do not use
these functions in a long-lived worker. The output directories must be new.

```sh
PYTHONPATH=tools python3 -m pcb_search.native_srj export BOARD.kicad_pcb NEW_INPUT --net /V_GAS
PYTHONPATH=tools python3 -m pcb_search route-srj NEW_INPUT/srj.json --output ROUTE.json --budget-s 5
PYTHONPATH=tools python3 -m pcb_search.native_srj scope NEW_INPUT ROUTE.json SCOPED.json
PYTHONPATH=tools python3 -m pcb_search.native_srj import NEW_INPUT SCOPED.json NEW_CANDIDATE
```

These are individual stages, not an unconditional script: a route error stops;
only a completed response with changes limited to preloaded copper can be scoped
for separate evaluation. A scoped geometry rejection stops before import. Every
import requires native DRC/refill and the board's complete gates before adoption.
PTH drill rules, composite netclasses, retained arcs, internal board holes and
variable-width traces currently cause explicit abstention in the native adapter.

For a scoped crossing rejection, one bounded local repair can be requested:

```sh
PYTHONPATH=tools python3 -m pcb_search.native_srj repair NEW_INPUT SCOPED.json REPAIRED.json --budget-s 0.5
```

Import a repaired proposal only if that stage returns `PASS`, then validate it
with the same native gates. Repeated unsuccessful repairs require diagnosis.

Build TraceMaker only in an isolated server worker using `tracemaker/Dockerfile`.
It pins upstream source and retains its license/source. The base distribution and
apt packages are not a reproducible lock: record the resulting image and binary
hashes, as the benchmark does. Run the controller with networking disabled,
read-only frozen input/tools, and a separate writable output directory:

```sh
PYTHONPATH=tools python3 -m pcb_search.tracemaker NEW_INPUT NEW_OUTPUT \
  --binary /build/src/app/tracemaker --binary-sha256 APPROVED_SHA256 \
  --search-s 5 --wall-s 15 --threads 1
```

This uses the same narrow frozen native export as the capacity experiment. All
original copper remains protected. The backend's inferred component rules are
disabled; supplied project rules and subsequent native gates retain authority.
Via-in-pad is conservatively prohibited using the exported pad envelopes. Its
own completion/refill counters are diagnostic only. Validate `NEW_OUTPUT/selected`
with native and board-specific checks before ranking or adopting any candidate.

Retrieve and bind existing blocks without editing CAD:

```sh
PYTHONPATH=tools python3 tools/blocks.py find 'buck' --mpn AP63203WU-7
PYTHONPATH=tools python3 tools/blocks.py reuse BUCK-3V3-AP63203
PYTHONPATH=tools python3 tools/blocks.py bind BUCK-3V3-AP63203 BOARD.kicad_pcb \
  --instance /EXACT_SHEET_UUID > binding.json
PYTHONPATH=tools python3 -m pcb_search.native_export BOARD.kicad_pcb NEW_MODEL \
  --drc-seconds 30 --block-binding binding.json
```

`blocks.py plan ID TARGET_MANIFEST --mapping PRIOR_PLAN` also checks a source-
and-target-bound port map. The manifest's explicit `inputs` list must cover the
requirements and hierarchical dependencies relevant to that decision. A native
binding covers the PCB and adjacent top-level project/rules/schematic, not every
external library or target operating requirement. Missing source evidence and
open items remain visible. Arbitrary-angle or mirrored reuse, duplicate-numbered
pads and legacy numeric pad nets currently abstain.

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
export. The SRJ native helper does not yet export this cheap-pattern contract.

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
audit pins, not claims that all dependencies are installed or integrated. Packing
and capacity routing have installed, locked dependency sets here. The audit
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

Verification on 2026-10-13: 27 targeted tests passed, including the installed
packing backend. A compatibility smoke on the historical `io6x6-prob.json` (59
units) rejected both the seed and packed proposal under the geometric screen.
The source fixture predates current pad-layer metadata and contains forbidden-area
penalties, including fixed units. This is not evidence of a current-board defect,
a fair baseline comparison, or packing improvement. Stop at this evidence and
export fresh native inputs before spending time on routing. The attributed smoke
record is `.bench/cip-839/io6x6-packing-smoke.json`, referenced in CIP 839.

Fresh ENV-SENSE experiment, 2026-10-13 (KiCad 10.0.6): baseline native DRC had
zero errors/opens and the existing board layout checks passed. Its placement
model reported a 0.74 mm² projected boundary conflict at U5's courtyard/cutout;
this motivated native escalation rather than unconditional coarse rejection.
Only `/V_GAS` was stripped and routed in isolated copies. A retained diagonal
ground trace's AABB falsely covered C6.1, and the initial solver exhausted about
two million iterations in 4.58 seconds. The new terminal check finds that model
conflict without running the solver. Exact preloaded traces removed the false
obstacle. The corrected solver response arrived in 3.42 seconds, with seven
proposed edits to retained copper. Scoping preserved original copper; KiCad then
found one `/V_GAS`–`/SCL` crossing and zero opens. **Candidate rejected.** The new
crossing screen also rejects the cached candidate before native import.

A bounded local shortcut removed one interior waypoint in 18 ms without rerunning
the router. Its new native copy has zero DRC errors and zero opens; all original
placement, rules and other copper remain identical. It is still unqualified
pending all release gates. The committed reference route is better on the measured
quality metrics: 10.438 mm and zero vias, versus 10.774 mm and four vias for this
candidate. Keep the reference. This experiment demonstrates interoperability,
failure localization and inexpensive repair, not grounds to replace the router.

This is a diagnosed adapter/backend failure and regression case, not a released
board, a whole-board benchmark or an improvement percentage. The native positive
control (strip and restore the known original routes) passes and preserves all
other board forms. Evidence and exact artifact hashes are held in CIP 839, under
`.bench/cip-839/cip839-env-native-20261013T065125Z/`. Latest KiCad 10.0.7 native
validation, broader local repair and comparative placement plus
routing remain open.

The same frozen `/V_GAS` input was then evaluated with TraceMaker at
`c6fcb7b4912bdabefeb7f4191c011b1a086335e0`, built on the server. The backend spent
5.02 seconds, added 17 requested-net items and 17 extra ground items, and still
reported failed ground-to-zone searches although its final refill reported zero
opens. Scope removed the extra ground items. KiCad 10.0.6 then reported zero
errors/opens; `check-env-pcb.py`, power-path capacity/coverage and via-in-pad checks
passed. The requested route is 10.147 mm, zero vias, 17 segments; the reference
is 10.438 mm, zero vias, 15 segments. This is a 2.8% improvement in this net's
length only, with more segments. It is **not** a whole-board speed or quality
claim, and no production board was changed. Complete release gates remain open.

The existing seven-part BUCK-3V3-AP63203 instance in DOOR-RELAY matched its source
parts/pads/net mapping and one translation; the fresh native model retained it
as one unit (`BLOCK9`). The overall placement screen still reported a coarse
outline conflict and did not qualify the board. Source blocks remain level 0.
Artifacts, runtime identities and hashes are under
`.bench/cip-839/tracemaker-c6fcb7b/`, referenced in CIP 839.
