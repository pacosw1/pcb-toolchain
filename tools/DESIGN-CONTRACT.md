# Idea to production evidence contract

`design_contract.py` connects declared requirements and acceptance plans to the
existing engineering verifiers. It adds traceability and an explicit next decision;
it does not replace engineering judgment or confer physical qualification.

```sh
tools/pcb design --json check NEW-IDEA --contract tools/examples/design-idea.json --through architecture
python3 tools/design_contract.py check NEW-IDEA --contract tools/examples/design-idea.json --through architecture --json --output assessment.json
```

The example is explicitly synthetic. It needs no gate, native CAD, part choice or
bench hardware. Original project requirements, source reviews, physical results and
order status remain unchanged. The backend supports `--root PATH` / `IOT_LAB`.
The CLI adds its normal durable supervisor, evidence sealing and cycle integration.
With `--output`, the full report is retained once and JSON stdout contains a compact
status plus its exact path and SHA-256. Without `--output`, JSON stdout is the full report.

## Eight stages, one next decision

| Stage | Evidence evaluated when the stage is reached |
| --- | --- |
| requirements | Sourced named requirements, explicit acceptance and intended verification stage. A recorded plan grants no functional claim. |
| architecture | Sourced interfaces/decisions and failure-condition links to named tests. Explicit unknowns name owner and blocking stage. |
| parts | Reviewed part applicability before CAD, or exact native part-use evidence once CAD exists. The check kind records which scope passed. |
| schematic | Functional schematic contract with named requirement results, plus successful native ERC-stage evidence. An unrelated clean ERC cannot prove functional acceptance. |
| placement | Existing reviewed native placement verifier and named measured rules; test plans and actual native signal access must be present before layout. |
| routing | Current sealed native run, every configured check successful, actual source/tool dependency verification and original artifacts. |
| prototype | Original approved plan, exact design/native binding, attributable instrument/raw measurement data and sourced numeric acceptance; existing block qualification can replay its complete original proof. |
| production | Explicit sourced applicability of assembly, test coverage, substitutions and lot yield. Required controls currently block as unsupported until original manufactured-population/control verification exists. |

`--through STAGE` assesses prerequisites only through that stage. Later stages
remain `required_now:false`, with no demand for future bench results. A failed
prerequisite stops later verifier work; blocked stages name `upstream_stage_blocked`.
Missing/stale evidence is not retried. Change or resolve the named cause first.

All report statuses are `passed`, `blocked` or `stale`. Early `passed` stages are
explicitly `acceptance_plan_recorded`; later ones mean only the declared existing
verifier coverage was evaluated. Every report retains `qualified:false`,
`functional_qualification:false` and `production_approved:false`. A stage assessment
cannot prove an omitted requirement, authenticate physical reality from a file,
approve production, order components or authorize machinery operation.

## Small manifest

Schema identifier: `iot-lab.design-contract.v1`. All top-level fields are explicit:

- `identity: {design_id, board, revision}`. `board` is `null` before CAD; `current_stage`
  is a separate top-level field. The CLI target must equal `identity.design_id`.
- `requirements`: rows with `id`, `statement`, `source`, `verification_stage`,
  `acceptance`. Acceptance is either `{kind:"interval", min, max, unit, source}`
  or `{kind:"review", criterion, source}`. Intervals are finite and ordered;
  units are explicit and never converted by guessing. Unsupported fields or
  structured conditions block. Use the explicit functional modes and reviewed
  part applicability checks for their supported conditions; unmodeled conditions
  remain unknown rather than silently acquiring a pass.
- `architecture`: `null` initially, or a source plus `interfaces`/`decisions`, each
  with its own stable ID, source and named requirements.
- `test_plans`: ID, requirements, prototype/production stage, method, sourced
  procedure/access/equipment/failure response, and named signals. Before placement,
  each signal requires exact native `{ref,pad,net}` access. This binds the endpoint;
  probe geometry, fixture mechanics and safe procedures still require their real
  reviewed constraints and physical acceptance evidence.
- `failure_conditions`: ID, condition, source, named requirements and test plan.
- `unknowns`: ID, question, owner, source and blocking stage; optional
  `resolution_check` must actually pass. A declaration `resolved:true` is no proof.
- `checks`: actual verifier descriptors described below.
- `production`: explicit `assembly`, `test_coverage`, `substitutions`, `lot_yield`
  applicability rows `{required, source, check?}`. These become required at production;
  required controls return `unsupported_production_control`. An unchecked artifact,
  CAD/fab readiness, selected parts or an unrelated measured voltage cannot establish
  assembled-lot coverage, approved substitutions or lot yield. Sourced `required:false`
  records applicability only; it never grants production approval.

Sources use repository-relative paths, exact SHA-256 and section/record locator,
or an actual one-based PDF page. The existing PDF helper verifies page count.
Changing a source invalidates its binding. Sources remain original and attributable.
No source content is inferred merely from package-name matching or file existence.

## Actual verifier descriptors

Each check has `id`, `stage`, `kind`, `requirements` and a repository-relative
`path`. The path is read and hashed during assessment. It deliberately has no
embedded result SHA: a schematic manifest can hash the design contract without
forming a design-to-checker-to-design hash cycle. The resulting report binds both
files and the actual invoked verifier/source closure.

| Kind | Additional fields and actual evaluation |
| --- | --- |
| `part_selection` | `references`: exact planned references; invokes `part_evidence.verify_selection` on reviewed profiles, limits, operating demands and applicability conditions without native files. Manifest revision must equal `identity.revision`; board must equal `identity.board`, or `identity.design_id` while board is null. Reports CAD/native/stock verification as false. |
| `part_use` | `references`: exact native references; invokes `part_evidence.verify_manifest`. It contributes reviewed part facts, not later physical numeric acceptance. |
| `schematic` | Path names a functional schematic manifest. Calls `schematic_contract.check_contract`, requires passing entries for every named requirement and its exact design-contract hash binding. |
| `placement` | Path names the reviewed part manifest; `constraint_ids` and `selectors: {requirement_id: rule_id}` bind actual measured rules. Optional `escape_evidence`. Numeric acceptance supports measured millimetres only. |
| `native_gate` | Path names the original unified `run.json`. Reuses sealed evidence and current dependency verifiers. Schematic-stage use evaluates ERC only; later use requires all configured checks. Exact board/workspace ownership is required. |
| `release` | Path names `release-manifest.json`; optional `stock`, `orientation`, `boards`, `as-of` use the existing release-readiness checker. Original native/fab/BOM/CPL/stock/orientation evidence is retained and revalidated; no upload or purchase happens. |
| `bench` | Path names original measured evidence; `plan` names the approved plan. Reuses `block_qualification.verify_bench` and its raw CSV, calibration and operator/serial attribution. Plan test limits and source identity must match the design acceptance exactly. |
| `block_qualification` | Path names a reference receipt, but `library`, `block_id`, `binding`, `proof` and `bench` must name all original inputs. Replays `block_qualification.qualify`; an editable receipt's level/pass field is insufficient. |

Numeric final acceptance cannot be satisfied by a part/gate/release status.
Use `part_selection` for the early parts decision, then `part_use` to bind reviewed
facts to installed symbols, pins and land patterns. Passing an early selection
check does not establish actual connectivity or current assembly availability.
Final prototype/production review acceptance also remains unsupported; a CAD review
cannot close a physical requirement even when a different bench measurement passes.
Earlier checks can contribute evidence toward a future requirement, but its
verification stage still requires its own actual result. Bench plans use the
existing `iot-lab.block-bench-plan.v1` and measurements use
`iot-lab.block-bench.v1`; these historical schema names are reused deliberately.
`design_binding(root, contract)` binds declared identity, requirements, DFT plans
and exact current native inputs without depending on a result file's future hash.
The operator/serial/calibration/raw-data records remain necessary; the tool does
not turn synthetic fixtures into measured production hardware.

Default release availability expires with its UTC day. An explicit historical
`as-of` records its original build/release observation; it cannot establish present
stock. A prototype bench assessment does not require fetching stock again for
hardware already built. Substitution approval, lot acceptance and mixed build
populations still need the specifically applicable recorded controls.

## Integration and focused checks

`load_contract(root,path)` returns the validated raw manifest or raises
`ValueError`/`OSError`. `requirement(root,path,id)` returns a source-validated row.
`quantity_range(root,value,inputs=None)` provides the shared strict numeric shape.
`dependency_files(root,path,through=None)` returns snapshot paths without native
execution. Missing future outputs are allowed. Actual assessments bind active
missing paths in `absent_inputs`, so newly appearing evidence invalidates an old
blocked observation even before CAD exists.

`evaluate_contract(root,path,through=None)` returns schema
`iot-lab.design-assessment.v1`, identity, stage/check/requirement results, current
inputs/tool inputs, absence and temporal bindings, `schematic_contracts`, and a
nonexecuting `next_action`. `next_stage` names the following review stage without
automatically starting hardware work. `current_assessment(report)` checks recorded
file/absence/date freshness only; it never invokes native or supplier tools.

Candidate admission uses architecture before building, schematic before placement,
placement before routing/repair, and routing before release. Its full dependency
closure travels with the candidate and must still match at adoption. Fresh candidate
native and board-specific checks remain mandatory; an old prerequisite report
cannot approve newly edited hardware.

`evaluate_candidate_layout(root,path,candidate=None,evidence_directory=None)` replays only declared placement
checks and DFT endpoint checks. `root` and `path` must identify the unchanged canonical
design; `candidate` names the actual edited PCB. Reviewed fixed/rigid geometry is then
compared with the canonical baseline. Reviewed escape rules require a new explicit
owned `evidence_directory` outside canonical CAD/tools/registry. The existing native
escape producer writes a fresh per-check receipt for the exact candidate there;
the verifier consumes that override and retains its dependency closure without
rewriting the authored contract or canonical receipt. Existing output directories
are rejected. This helper does not replay old gate, release
or bench receipts. Candidate adoption requires a declared layout contract and DFT
plan, including initial builds; existing candidate identity and fresh native checks
remain necessary alongside this scoped result.

Owned candidate operations share an optional `EscapeStageReceipts` provider
between engineering and design checks within each stage. It keeps the original
sealed receipt and rechecks candidate/sidecar hashes, reviewed policy, producer
code, environment and observed runtime before reuse. Reports distinguish generated
from reused evidence; events name cache hits/misses. Preflight and post-writer
checks use separate providers, and the final native/configured gate stays fresh.
This is a bounded screen with recorded runtime files, not physical routability
or complete runtime certification. Direct callers without a provider still
produce fresh evidence in a new owned directory.

```sh
PYTHONPATH=tools python3 -m unittest test_design_contract
```

Tests exercise pre-CAD ideas, stage ordering, source changes, missing and future
evidence, DFT plans, actual part verification, raw numeric bench rejection and false
declared-pass records. Evidence belongs under `.gate/pcb-lifecycle-20261016/design/`;
the parent lifecycle index distinguishes these software/fixture proofs from future
physical prototype or production evidence.
