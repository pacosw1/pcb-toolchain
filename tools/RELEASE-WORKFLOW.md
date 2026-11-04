# Checked fabrication and order preparation

`sh tools/fab-workflow.sh BASE-PWR release` and the equivalent `ENV-SENSE`
command create locally checked CAD/fabrication candidates. BASE-PWR selects
revision A's canonical `cad/BASE-PWR/BASE-PWR` project; ENV-SENSE includes VIB,
AIR and ALL assembly populations. The workflow does not order or upload.

Use new paths on the same filesystem:

```sh
FAB_WORK_DIR=/absolute/new/work FAB_RELEASE_OUT=/absolute/new/candidate \
  sh tools/fab-workflow.sh BASE-PWR release
node tools/check-release-readiness.mjs BASE-PWR /absolute/new/candidate \
  --stock /absolute/stock --orientation /absolute/orientation.json \
  --boards 5 --as-of 2026-10-15
```

`FAB_WORK_DIR` is optional; the default is a unique directory next to the
canonical fabrication destination. Failed evidence remains there. A successful
run claims `FAB_RELEASE_OUT` with an exclusive mkdir, then atomically renames the
stage over that empty directory; existing files, directories and symlinks are
never replaced or nested into. An empty `FAB_RELEASE_OUT` is never a candidate:
it is a publication in progress, or a crash between the two steps that left the
stage intact and refuses further publishing until `rmdir` removes it. Read live native
events at `FAB_WORK_DIR/gate/events.jsonl`, switching to
`FAB_RELEASE_OUT/gate/events.jsonl` after publication. `START`/`PASS`/`FAIL`
messages identify phases. The owning CLI supplies deadlines and cancellation.

The release gate runs fresh in the isolated directory, without changing tracked
metrics or the board's latest pointer. Native input closure, tool versions,
successful checker exits, parsed reports and evidence identity are checked
before export and again afterward. The workflow checks the exported ZIP against
its actual Gerber/drill files, reconstructs Gerber connectivity, verifies exact
BOM identities and fitted populations against native KiCad, and compares every
CPL reference, coordinate, side and normalized rotation with the PCB.

BASE-PWR also runs the staged board audit (mechanics, land patterns, part/net
semantics, artwork and assembly files), reusing validated shared electrical
evidence. ENV-SENSE runs both the schematic net/variant checker and the complete
layout/thermal checker. Its schematic checker currently repeats ERC; that keeps
its semantic coverage intact. Native CPL rotation agreement does not establish
the supplier's package orientation.

For diagnostics only, the BASE audit accepts `--gate-observation-dir DIRECTORY`
in place of `--gate-dir`. This verifies exact current input/tool/report identity
and reuses the observed shared verdict, including failures. It still returns
failure when the shared checks failed; the release path requires all targets
and cannot accept a diagnostic failed verdict.

Runtime overrides are `KICAD_CLI`, `KICAD_PYTHON` (legacy `KICAD_PY` accepted),
`PYTHON_MODERN` and `GERBERCHECK_PY`. macOS/Linux and standard Python 3.9+/Node
are required; the Gerber checker additionally needs its documented gerbonara
and shapely environment. Export creates the existing 3D renders by default;
`FAB_RENDER=0` omits those view-only images for targeted diagnostic runs. The
manifest records the actual render count; electrical, mechanical and fabrication
checks retain their required coverage. The
standalone BASE/ENV exporters refuse existing fabrication directories; choose
new `FAB_OUT`/`RENDER_OUT` locations for exploratory output.

The existing executor can build a separate Gerber-capable runtime with:

```sh
python3 tools/build-release-image.py /absolute/new/image-run
```

This derives from the immutable native CI image ID recorded in the helper. It
does not change that base image or the six-case smoke corpus. Original PyPI
wheel URLs/SHA256 and `requirements-gerbercheck.txt` pin gerbonara 0.13.0,
Shapely 2.0.7 and click 8.1.8 from the existing local Python 3.9 environment.
NumPy 2.1.3 supplies the CPython 3.13 wheel absent from local NumPy 2.0.2;
the pinned pip 25.0.1 wheel is used only for installation. Docker installs
offline into a dedicated target and exposes `GERBERCHECK_PY`, preserving native
pcbnew's interpreter. The helper records source hashes, image ID and original
wheel hashes. A matching image is reused; an existing tag with different inputs
is refused. `--wheel-cache DIR` reuses only matching original wheel hashes.

`release-manifest.json` binds the checked gate, native population, release-tool
source closure, board-specific reports and hashes of the candidate artifacts.
Its scope is `cad_fabrication_candidate`; it explicitly leaves G5 approval,
ordering and G6 qualification false.

## Readiness evidence

`check-release-readiness.mjs` emits one JSON object: exit 0 means
`ready_for_user_review`, 1 means `blocked`, and 2 means invalid invocation or
an operational error. It checks structural packet completeness, exact verified
BOM/complete assembly coverage and attributed electrical selection using the
existing registry contracts. Historical order-ready text, header-only BOMs and
unscoped assembly CSVs cannot satisfy these checks. Current BASE/ENV packet debt
is reported as blocked; this tooling does not create replacement board evidence.

Stock requires source evidence from the declared UTC order day, following the
existing requirement to recheck on the day of order. `--boards` is the planned
quantity; there is no invented availability margin. Each population is checked
independently, so a mixed-population order needs its own total quantity plan.

```sh
python3 tools/release-stock.py /absolute/new/candidate /absolute/new/stock --boards 5
```

This opt-in read-only collector saves unmodified JLC assembly-search responses,
their exact URL/time/SHA256 and a `stock.json` receipt bound to the candidate.
It does not retry failures, reserve stock, log in, contact a supplier, create a
cart or order. Readiness verifies the original responses, exact selected
MPN/LCSC, quantity and day. LCSC catalog quantity cannot substitute for JLC
assembly availability.

The reviewed complete assembly scope may also require mates, contacts, harnesses,
batteries or other off-board items. For these, put an attributed `assembly.json`
availability review in the stock directory. Required top-level fields are
`schema_version: 1`, `board`, `candidate_sha256` (the manifest file),
`order_day_utc`, `boards`, `reviewer` and `items`. Every scoped assembly item must
appear exactly once with its `reference`, exact `mpn`/`lcsc`,
`available_quantity`, `observed_at_utc`, HTTPS `source_url`, relative original
`evidence` path and `evidence_sha256`. The human review attributes the supplier's
availability claim; quantities are not reserved. An explicit validated assembly
scope with no off-board items requires no such receipt.

The orientation review is separate JSON with `schema_version: 1`, `board`,
`revision`, `candidate_sha256`, `reviewer`, `reviewed_at_utc` and `placements`.
Each fitted population/reference requires an entry containing `population`,
`reference`, exact `lcsc`, `orientation_verified: true`, and a relative
`evidence` file plus its `evidence_sha256`. Evidence should support the actual
supplier package/pin orientation and the candidate's BOM/CPL. Hashes attribute
the review; they do not replace that engineering judgment.

## Verification boundaries

```sh
node --test tools/lib/fab-workflow.test.mjs tools/lib/release-evidence.test.mjs
```

The shell fixtures inject gate, semantic, exporter, Gerber and publication
failures. Parser fixtures reject changed inputs, wrong native populations,
heterogeneous BOM identities, missing/duplicate CPL entries, coordinate/side/
rotation errors, stale or substituted stock, incomplete orientation reviews and
missing packet evidence. They also exercise exclusive publication and exact ZIP
comparison. External native tools are controlled fixtures; these tests do not
establish actual board acceptance or measured hardware qualification.
