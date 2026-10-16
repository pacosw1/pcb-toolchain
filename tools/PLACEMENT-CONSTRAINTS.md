# Reviewed placement constraints

`engineering_constraints.py` consumes the verified part manifest from
`part_evidence.py`. Reviews remain bound to the actual schematic, footprint,
pad/net map, land geometry, original PDF hash and one-based source page.
The engineering screen grants no routing, assembly, enclosure or bench qualification.

```sh
python3 tools/engineering_constraints.py check BOARD --manifest REVIEW.json --json --output REPORT.json
python3 tools/engineering_constraints.py check BOARD --manifest REVIEW.json --candidate COPY.kicad_pcb --json
```

Reports distinguish `passed`, `blocked` and `stale`. A missing review or unsupported
metric names the blocker. A failed pose constraint includes its stable reviewed ID,
source page and measured value; it may be repaired by placement. Invalid evidence,
unknown conditions and changed source inputs cannot enter a reviewed search.

The manifest's `layout_constraints` entries use
`{schema: "iot-lab.engineering-constraints.v1", rules: [...]}` after verification.
Every rule contains a distinct `id`, a `kind`, and
`source: {path, sha256, page}`. Authored source paths must be repository-relative
and resolve within the supplied project root, including isolated workspaces.
Runtime/report bindings may use absolute paths. A source may also include a section locator.
Limits are numeric values taken from the cited reviewed source and its applicable
conditions; the tooling supplies no electrical limits.

| Kind | Supported fields and measurement |
| --- | --- |
| `fixed` | `refs`: exact references whose native positions and orientations stay fixed. Native footprint locks apply independently. |
| `rigid_group` | `refs`: two or more exact parts with one common rigid transform. Optional `binding: {path, sha256, layout_rule_ids, boundary_rule_ids}` verifies an existing hierarchical block binding against actual native identities and reviewed source/boundary rule coverage. |
| `pin_distance` | `a`, `b`: `{ref, pad}`; `metric: "pad_center_euclidean"`; `min_mm` and/or `max_mm`. Distances use transformed native pad centers, including pad offsets. Ambiguous repeated pad numbers require a richer selector and stop. Trace length, loop area and return-path quality are separate requirements. |
| `clearance` | Exact pad endpoints `a`, `b`; `metric: "copper_edge_2d"`; `min_mm`. Axis-aligned native rectangle/circle copper is supported. Unsupported shapes, drill rules, unrelated layers and conditional clearances stop. Full native DRC remains mandatory. |
| `connector_access` | `ref`; `metric: "courtyard_corridor_2d"`; `corridor_mm: [x0,y0,x1,y1]` relative to the footprint origin; `exit_side: "L"`, `"R"`, `"T"` or `"B"` in board coordinates. The corridor must include the connector origin, reach the requested outer board bound and avoid every foreign native courtyard envelope. Missing courtyards stop. This conservative 2D screen does not validate mating height, enclosure walls, cable bend radius or 3D access. |
| `escape` | Exact reviewed references/pads and supported native escape metric. Requires attributable escape evidence for the exact candidate, followed by the fresh configured native gate. The model does not duplicate or replace native DRC. Missing, stale or incompletely screened endpoints block routing. A grid enclosure is a model result, never proof of physical impossibility. |

Unknown rule kinds, fields and metrics stop instead of being ignored. Additional
supported escape parameters are governed by the native escape verifier; an
unsupported reviewed width, layer or clearance cannot silently become a default.

## Production placement path

```sh
python3 tools/placer/cli.py read BOARD.kicad_pcb -o problem.json \
  --engineering-board BOARD --engineering-manifest REVIEW.json
python3 tools/placer/cli.py run problem.json -o proposals.json --workers 2
python3 tools/placer/cli.py write BOARD.kicad_pcb problem.json proposals.json --outdir NEW_CANDIDATES
```

The reader also accepts `PCB_ENGINEERING_MANIFEST`, `PCB_ENGINEERING_BOARD` and
`PCB_ENGINEERING_ROOT` from the unified workflow's isolated snapshot. It creates
explicit rigid layout units before search, preserving existing native grouping.
A reviewed group cannot split another native unit or silently discard board
drawings. Fixed requirements reach the search's actual fixed-unit mechanism.
Pin distance, clearance and access requirements reach the existing legalizer's
`rule_miss` checks; objective weights and legacy geometrical policies are unchanged.
Source hashes are checked before worker admission, after search and before writing.

An initially failing distance/access requirement remains repairable. Search
results that still violate a requirement cannot be ranked as legal or written.
Compaction validates reviewed poses before routing; a virtual outline cannot
replace the source-bound board outline.

The reviewed writer retains all original copper. A library block with internal
copper is explicitly held fixed until a native copper-transform contract is
available; a copper-free rigid unit can move intact. The existing binding grants
neither qualification nor permission to reuse copper in another electrical
context. Boundary clearances, connector corridors and full target gates remain
required. Moved pads may require an explicit bounded local reconnection.

`binding.layout_rule_ids` maps every current source block layout-rule index
(zero-based string) to nonempty lists of reviewed constraint IDs.
`binding.boundary_rule_ids` names nonempty reviewed external-clearance,
connector-access or escape requirements affecting the bound instance. Missing
coverage stops reuse; legacy prose is never guessed into numeric rules.

A transported remote model needs the explicit producer-verified
`--engineering-frozen-model-sha256` argument. The worker checks that exact payload
and its modeled constraints, labels the result as requiring producer source
reverification, and grants no native acceptance. The owning producer rehashes all
original review/CAD inputs before writing. Direct runs verify their source files;
missing remote files never silently count as current evidence.

A model's own contract hash is only an integrity check. A source-verifying
consumer derives the contract from the reviewed manifest and actual native CAD
and compares its complete rules and geometry before searching or writing. The
writer also requires the exact modeled native input path; changing a rule,
geometry, reference mapping or input board cannot create a reviewed result.

Models without an attached engineering review retain legacy behavior and report
`legacy_unreviewed`; they do not acquire a reviewed-constraint claim. Use the
reviewed entrypoint when making an engineering approval decision.

CPU mutation tests are in `test_engineering_constraints.py`. Its explicit
`native_copy_proof(output)` function requires KiCad Python, NumPy, Poppler and
`kicad-cli`. The recorded proof used the installed macOS KiCad Python for the
real synthetic PDF/review, real native reader/writer and escape checks. The proof
covers a positive move, rejected distance mutation, forged contract/writer inputs,
actual critical-pin escape and partial/stale escape receipt rejection, retained
copper and source preservation. Separate fresh native DRC checks schematic parity
and zone refill. Synthetic fixtures never qualify production parts.

Completed placement work is saved in `checkpoint.json` before DRC. A bounded DRC
failure can be completed with reports produced on another runtime against the
exact same four native files. The recorded proof imported source-bound DRC from
the pinned Linux KiCad 10.0.6 image after macOS CLI startup exceeded 20 seconds;
that image does not provide the NumPy/Poppler placement prerequisites.

```python
from pathlib import Path
from test_engineering_constraints import import_placement_drc
import_placement_drc(Path("EXISTING_PROOF"), Path("SOURCE_BOUND_DRC/receipt.json"))
```

The receipt must retain the original native reports, exact input hashes, command,
return code, 20-second bound, unchanged-source observation and pinned runtime
identity. Missing commands, checks, inputs or reports are rejected. Each original
declared source remains hash checked; newly generated `.kicad_prl` housekeeping
does not become an invented CAD source change.

The first proof predates checkpoints. Its one-time recovery used
`reconstruct_placement_checkpoint(Path("EXISTING_PROOF"))` before the import.
Recovery reads preserved native geometry and the original escape receipt,
rechecks production writer rejection guards and records its later observation
time explicitly. It does not repeat placement, extraction, escape generation or
DRC, and does not claim a missing original checkpoint existed.
