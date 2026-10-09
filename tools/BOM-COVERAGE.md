# Complete board BOM scope

`check-packets.mjs` and offline `check-consistency.mjs` share the same
completeness check. A nonempty `BOM-VERIFIED.csv` must cover its owning native
project and explicitly reviewed assembly scope. Matching a selection ledger
to one supplied row does not establish complete board coverage.

This is structural validation, not engineering approval. Existing selection
ledger checks still establish attribution for supplied selected rows. Neither
scope hashes nor this checker prove pin functions, electrical ratings, correct
land geometry, current stock, reviewed conclusions, ordering or qualification.
Missing evidence must remain a finding; do not generate a real scope merely
to make a gate green.

## Revision ownership

Exactly one revision in `hardware-design/registry/boards.json` must own
`bom: "BOM-VERIFIED.csv"`, `bom_scope: "BOM-VERIFIED.scope.json"` and a native
`project` stem. The owning revision's `spec` and native project define scope.
Other revisions cannot reuse the same BOM or scope. Planned or historical
packet requirements remain unchanged. Missing and header-only BOM findings
remain failures without implying that the board has selected parts.

## Scope schema version 1

The scope JSON contains only these fields:

| Field | Required meaning |
| --- | --- |
| `schema_version`, `board`, `revision` | `1`, owning directory and revision |
| `revision_spec`, `spec_sha256` | Repository-relative owning SPEC and exact hash |
| `project` | Repository-relative native project stem |
| `bom`, `bom_sha256` | Owning verified CSV and exact hash |
| `source_hashes` | Exact closure of root schematic, recursively instantiated sheet files, PCB and registered variants file |
| `review_evidence` | Nonempty map of board-owned Markdown review paths to exact hashes |
| `native_population` | `DEFAULT` or the explicit registered variant represented by native CAD |
| `classification` | Every native schematic/PCB reference, without implicit prefix exemptions |
| `assembly` | Attributable complete assembly requirement scope and separate BOM |

Scope, SPEC, CSVs and reviews must remain inside the owning board directory,
including after symlink resolution. Native recursive sheet files may be shared
inside `hardware-design`; the exact source closure and hashes bind them to this
review. Hashes are lowercase SHA-256. Unknown scope fields fail. Review
references must name hashed reviews other than the SPEC itself.

Each classification is `{kind, reason, review, assembly_dependencies}`. The
dependencies are unique assembly item references; an empty list is explicit.
Every native reference must have exactly one classification:

- `component`: fitted schematic part, native BOM enabled, matching PCB MPN,
  LCSC, footprint identity and DNP state; PCB BOM/board-only flags must agree.
  Exact MPN and LCSC are required.
- `dnp`: native DNP and an empty fit list, with explicit classification.
- `excluded`: native schematic BOM exclusion, or a PCB-only footprint with
  both native BOM exclusion and board-only flags.
- `fabrication-feature`: PCB native BOM exclusion and board-only flags,
  no catalog identity, and any schematic counterpart explicitly excluded.
- `nonphysical`: schematic-only symbol with no footprint and BOM disabled.

Multi-unit components merge only compatible identities with distinct positive
units. Exact placed project/sheet instance paths distinguish repeated sheets.
The check does not demand that unused library units be placed. PCB footprint
identity checks the named land pattern, not its dimensional correctness.

## Variants and CSV rows

Registered variants require a complete `fit` map for every physical schematic
reference, including DNP entries with empty arrays. Optional `dnp` must match
empty fit lists. Native DNP state must match `native_population`. Fitted rows
cover the union of variant populations, with `Population` entries separated
by semicolons; no undeclared population or missing fitted population passes.

Both CSVs start with `Designator,Function block,MPN/value,LCSC`. Headers must
be nonempty and unique. Each required reference has one row, matching exact
identity. Native reference quantity is one; omitted `Quantity` implies one
only for the PCB CSV. No extra, duplicate or missing references pass.

## Required assembly scope

`assembly` contains `{review, basis, bom, bom_sha256, requirements}`. It names
a separate board-owned assembly CSV with explicit `Quantity`. Requirements
can be empty only when an attributable review establishes that scope. The
checker cannot discover omitted mating parts or infer harness requirements
from prose: a false review or jointly omitted dependency remains an engineering
review problem. No automatic connector-prefix or testpoint exemption is used.

Each requirement has `reference`, `kind` (`mate`, `contact`, `harness`,
`battery`, `other`), `mpn`, `lcsc`, positive integer `quantity`, `populations`,
`for_references` and `review`. Owners must be fitted native components with
reciprocal `assembly_dependencies`. An unqualified dependency covers every
owner population; variant-specific alternatives need a future explicit schema
rather than narrowing a required mate silently. Required item quantities are
per complete assembly in each stated population. CSV identity, quantities and
populations must match exactly.

Catalog items require an exact LCSC identity. A constructed harness or other
noncatalog assembly instead uses `lcsc: ""`, `definition` and
`definition_sha256`. Its hashed board-owned JSON must contain
`schema_version: 1`, matching `reference` and `mpn`, and nonempty `materials`
with exact `mpn` and positive integer `quantity` per constructed item. Do not
invent a JLC number for a custom assembly. Material identities and quantities
are structurally checked; ratings, contacts, wire specifications, workmanship
and manufacturer evidence still require engineering review.

## Regression verification

Run `node --test tools/lib/*.test.mjs`. Coverage regressions include a copied
actual AC-24V project with 14 native fitted components and an incomplete
one-row CSV, complete synthetic positive scope, repeated hierarchy, unit and
native identity disagreements, variants/DNP, explicit exclusions, missing
mates, quantity errors, constructed harnesses and attribution/path failures.
Fixtures use temporary directories and do not create real verified board BOMs.
