# Part and datasheet evidence

`pcb parts` wraps `part_evidence.py` with durable CLI events and reports. Extraction,
reviewed engineering facts, dated assembly availability, native ERC/DRC, release
approval and measured qualification remain separate states. No command selects a
part or changes an existing selection ledger.

```sh
pcb parts --json status ENV-SENSE
pcb parts --json inspect hardware-design/registry/datasheets/ISM330DHCXTR_C2655101.pdf --render-pages 1
pcb parts --json verify ENV-SENSE --manifest hardware-design/registry/part-reviews/ENV-SENSE.json
pcb parts --json selection NEW-IDEA --manifest hardware-design/registry/part-reviews/NEW-IDEA.json
pcb parts --json stock ENV-SENSE --candidate /path/to/candidate --boards 3 --receipts /path/to/new-stock-receipts
```

The backend also runs directly; each command accepts `--root PATH`, `--json` and
`--output FILE`, before or after its command. `IOT_LAB` sets the default root.
For example:

```sh
python3 tools/part_evidence.py inspect original.pdf --cache /path/to/cache --render-pages 1,13 --json --output inspect.json
python3 tools/part_evidence.py verify ENV-SENSE --manifest review.json --json --output verification.json
```

Python3 and Node.js are required for native identity inspection. PDF inspection
and page validation require Poppler `pdftotext`/`pdfinfo`; rendering also requires
`pdftoppm`. Set `PDFTOTEXT`, `PDFINFO`, `PDFTOPPM` to explicit executable paths, or
use bundled Codex Poppler/PATH. A missing tool produces a blocked receipt with the
original cause. Native parsing reuses `tools/lib/kicad-population.mjs`; it does
not require starting KiCad or loading `pcbnew`.

## Extract once, review attributable pages

`inspect` keeps two source-bound cache identities. The shared text entry under
`text/<text_cache_key>` binds the original PDF SHA-256, resolved `pdfinfo` and
`pdftotext` executable hashes/versions, and exact text options. A full inspection
entry additionally binds requested render pages, DPI and `pdftoppm` when used.
Changing render pages or DPI can miss the full entry while reusing the same text
extraction; changing the PDF or text tools invalidates the text identity.

Text remains available as `pages/0001.txt` and requested images as
`renders/0001.png` in the full inspection entry. Its receipt retains actual page
count and artifact hashes. Locked, atomic publication and hash validation apply
to both layers. Missing/corrupt artifacts regenerate the affected entry; a valid
matching full entry can also seed the shared text entry without another extraction.
Concurrent source/tool changes refuse acceptance. Original PDFs remain unchanged.
Extracted text and renders always report `reviewed:false` and `qualified:false`.

`cache_hit` describes the exact full request. `text_cache_hit` is true when text
is reused from either the canonical text entry or a valid matching legacy full
entry. Reports retain `text_cache_key`, `text_cache_directory` and the full entry's
key/directory. Regenerating a missing/corrupt full artifact from verified canonical
text does not require `pdftotext`; final full-entry artifacts, source and tools are
still validated. With `--json --output FILE`, inspect writes the full evidence
report once and prints a compact receipt with cache status and report path/hash.
Without `--output`, JSON stdout remains the full report.

Owned `parts inspect`, `selection`, `verify` and `status` observations can use an
audited code boundary rather than every engineering tool and test. Their terminal
`engineering_policy` records the chosen mode and execution context. Relevant
Python imports, native-reader code, the resolved Python launcher and all backend
source/tool/artifact inputs remain bound; missing local import candidates are
recorded so a newly appearing module also invalidates the observation.

The narrow boundary is certified for reviewed producer and supervisor source
revisions. A changed producer, unsupported execution path or candidate continuation
uses the conservative policy inventory. Other observation backends and stock
retain that boundary too. Unrelated test or checker edits preserve a certified
parts observation, while changed consumed files, tools, import resolution or
missing inputs expire it. Existing historical receipts keep their original
bindings. New production-module filenames conservatively expire observations;
unreviewed compiled or sourceless import shadows use the broad boundary.
Candidate checks, adoption and fresh release gates retain their own
verification paths.

PDFs must retain their existing `.pdf.source.json` source/time/hash attribution.
A review cites exact original PDF paths, hashes, document identity/revision and
one-based pages. A text hit for a package name provides no engineering approval.

## Shared facts and board use

[part-use.schema.json](../hardware-design/registry/part-reviews/part-use.schema.json)
defines a board contract; [part-profile.schema.json](../hardware-design/registry/part-reviews/part-profile.schema.json)
defines reusable exact-part facts. Schemas describe structure; `verify` checks
actual source/native identities and numeric/coverage requirements. Use a shared
profile to avoid copying manufacturer facts between boards:

```json
{
  "reference": "U1",
  "profile": {"path": "hardware-design/registry/part-reviews/exact-part.json", "sha256": "<actual SHA-256>"},
  "use": {
    "pad_net_map": {"1": "GND", "2": "+3V3"},
    "required": {"supply": {"min": 3.0, "max": 3.6, "unit": "V", "source": "<this board's exact requirement source>"}},
    "conditions": {"supply": {"ambient_temperature": "<this board's sourced temperature range>"}},
    "refs": {"DECOUPLER": "C1"}
  }
}
```

This fragment illustrates fields, not actual part limits or a valid approval.
Full synthetic examples live in `hardware-design/registry/part-reviews/examples/`;
their reviews deliberately remain pending. The runnable `make_fixture` in
`test_part_evidence.py` creates a self-contained synthetic review and original
synthetic PDF. No production review has been manufactured or migrated.

A shared profile fixes exact MPN/LCSC, manufacturer, package/variant, original
PDF identities/pages, symbol definitions and pin map, installed footprint/land
geometry, sourced rating limits with applicability conditions, layout rules and
assembly dependencies. `$SELF` and named `$ROLE` references in its layout and
assembly templates are mapped by board `use.refs`. Required ranges/conditions
and actual pad nets belong to the board. Board use cannot replace profile limits
or erase unresolved profile items. Inline contracts remain supported.
Expanded shared rule IDs use `<reference>:<source-rule-id>` so a profile can be
instantiated repeatedly. `constraint_origins` retains the exact profile hash,
reference and original rule ID; inline rule IDs remain explicit and board-unique.

Both profile and board review record reviewer/time, a hashed review evidence file,
and `facts_sha256`: SHA-256 of canonical sorted compact UTF-8 JSON excluding only
`review`. Python API `facts_digest(value)` produces this value. This binds a
review to its exact facts; it is attribution, not a signature or independent
verification of a manufacturer's specification. Changing a profile also changes
the hash required by every board use. A missing/stale/pending profile blocks reuse.

`verify` compares the installed schematic instance and PCB MPN/LCSC, symbol/pin
definition, footprint identifier, all pad geometry, and exact pad-to-net mapping.
Every fitted native reference requires evidence. Physical pad numbers must be
explicitly electrical or mechanical. Translation/rotation alone leaves static
package evidence reusable; every report still hashes current native source files.
Whole schematic paths are excluded from reusable symbol hashes, allowing the same
exact symbol to be used on different boards.

Native `verify` blocks `unspecified_pin_type` when an explicitly reviewed symbol
contains actual pins with electrical type `unspecified`, even if their stored
hashes match. This is our reviewed-symbol completeness rule. KiCad 10's default
pin-conflict map warns for many unspecified-pin connections; its configured ERC
rules determine the actual result. The [KiCad 10 pin-type documentation](https://docs.kicad.org/10.0/en/eeschema/eeschema.html#pin-electrical-types)
distinguishes unspecified types, unconnected types and schematic no-connect flags.
[KLC S4.4](https://klc.kicad.org/symbol/s4/s4.4/) requires electrical types to match
their function, including appropriate power/ground and logic types.

The guard checks actual symbol `pin_map` entries. Mechanical-only pads are covered
by the separate electrical/mechanical pad classification, and cannot hide an
electrical pin. An explicitly reviewed DNP part receives the same guard; automatic
required-part coverage remains limited to fitted parts. Pre-CAD `selection` does
not inspect native pins. Assign types from reviewed function and mode; do not
automatically relabel pins as passive or unconnected to silence the blocker.

Rating demand and applicability ranges must use identical explicit units and lie
inside their sourced limits. Demands must cite that board's requirements; limits
must cite that part's exact PDF. Net current/power budgets cover all fitted native
references on the declared net through explicit loads or sourced exclusions and
compare summed maximum loads with the sourced budget. No numeric threshold,
operating range, safety factor or test exemption is invented. Connector mates,
contacts, harnesses and batteries have explicit identity/quantity/source records;
unresolved items block verification.

Layout sources are validated here, then `engineering_constraints.py` evaluates
supported metrics against actual native candidate geometry before and after a
writer. Unsupported metrics and escape evidence remain blocked. A passed part
report establishes only the explicitly reviewed part-use contract; it cannot
establish that an omitted engineering requirement was considered, replace ERC/DRC,
or establish prototype/bench qualification.

## Dated assembly stock

`stock` invokes the existing `release-stock.mjs` once, streams its progress and
retains original responses plus `stock.json`. It requires a supplied candidate,
an exact configured board, positive board quantity and a new receipts directory.
The candidate's native source hashes must still match current schematic/PCB input
files before any query. Results bind candidate hash, board, UTC day, requested
quantity, exact native LCSC/MPN, original-response hash and observed assembly quantity.
Changed native source, wrong candidate/day/quantity, missing or ambiguous code,
insufficient stock or altered response blocks acceptance. No retries or arbitrary
stock margin are added. Tests use saved synthetic responses; no live query is
needed for testing.

`population_source` records the exact absolute `variants.json` path, explicit
`exists` flag and its SHA-256 or `null` for an absent policy. Creating a policy
after a DEFAULT-population observation expires that observation. Shared
`verify_population_source(report)` raises for absent/malformed or changed bindings;
`stock_population_current(report)` returns the same check as a boolean. Legacy
stock reports without this binding cannot establish current availability.

Availability is reported as `scope:assembly_stock_observation`, never a renewed
engineering review. Each candidate population is checked independently; mixed
population totals, complete off-board assembly availability, selection identity,
supplier orientation and reservation still require the existing release-readiness
checks. A dated observation expires with its day/candidate/quantity context. No
order, upload, supplier contact or purchase is performed.

## Reviewed selection before CAD

`selection BOARD --manifest FILE` uses the same profile, review, source, rating,
operating-condition, assembly-dependency and unresolved-item validation as native
`verify`. It needs the planned board/design ID, its owned requirements/specification
and planned project path, but no gate configuration, schematic, PCB, Node or KiCad.
The manifest still uses `iot-lab.part-use.v1`; shared profiles remain source-hashed.

Native declarations may be partial or `{}`. A shared-profile use may omit its
planned `pad_net_map`. The structural schemas allow those early declarations;
`verify_manifest` still requires all installed symbol/pin/footprint/land/pad-net
bindings and fitted-reference coverage. Schema validity never grants a CAD verdict.
Declared current/power budgets require planned pad maps for all listed selections
and report `declared_planned_net_only`, without proving actual connectivity.

A passing result has scope `reviewed_part_selection`, `selections` keyed by planned
reference, exact revision/project and complete source hashes. `bindings` and
`native_inputs` stay empty; `native_verified`, `cad_verified`,
`connectivity_verified`, `layout_verified`, `stock_verified`, `stock_current`,
`qualified` and `release_approved` stay false. Only explicitly listed selections
are covered; a complete actual assembly cannot be established before CAD. Reviewed
facts remain attributable authored claims; the PDF parser checks original identity
and page locations, not semantic truth. Its actual executable hash is retained.

```sh
python3 tools/part_evidence.py selection NEW-IDEA --manifest review.json --root /path/to/project --json --output selection.json
```

With `--output`, this command retains the full report and prints a compact JSON
receipt naming its path and SHA-256. It creates no selection ledger or approval.

## Integration and focused verification

`verify_manifest(root, board, path)` returns schema `iot-lab.part-evidence.v1`,
`status`, `blockers`, exact `inputs`/`native_inputs`/`tool_inputs`, native
`bindings`, and normalized `constraints`. `dependency_files(root, manifest)`
returns the repository-relative source closure, including referenced profile/PDF/
review/spec files and native hierarchy, for isolated operation snapshots. Relative
paths resolve within the supplied project root, so a source-bound manifest works
inside a copied workspace. Sources are rehashed before accepting a verification.

`verify_selection(root, board, path, output=None)` returns the distinct pre-CAD
scope described above. `dependency_files(root, manifest, include_native=False)`
collects its exact profile/PDF/review/spec closure without touching native CAD.

```sh
PYTHONPATH=tools python3 -m unittest test_part_evidence
```

`test_part_evidence.real_copy_proof(repo, output)` exercises pending real ENV-SENSE
evidence and deliberate pin, land and voltage mutations only in a copied tree.
It records unchanged shipping hashes. The separate
`test_engineering_constraints.native_copy_proof(output)` uses actual pcbnew and
Poppler on the explicitly synthetic fixture; the native runtime is required.
Local evidence is indexed at `.gate/pcb-engineering-20261016/parts/summary.json`.
