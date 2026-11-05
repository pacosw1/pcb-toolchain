# Schematic functional contracts

`tools/pcb schematic --json check BOARD --contract FILE` verifies declared
functions against actual native CAD and reviewed evidence. The backend is:

```
node --experimental-strip-types tools/schematic_contract.ts check BOARD --contract FILE --root ROOT --json --output REPORT
```

`check_contract(root, board, path, output=None)` returns
`iot-lab.schematic-contract-result.v1`. `passed` means every declared assertion
passed on the bound sources; `blocked` retains causes. `qualified`,
`release_approved` and `stock_current` remain false. ERC/DRC, simulation,
firmware behavior and measured qualification require their own evidence.

The native part reader and reviewed part-use verifier supply exact MPNs, symbol
pin definitions, PCB pad nets, native DNP/BOM flags and installed assets. One
owned KiCad netlist export supplies actual schematic pin nets, nominal values
and custom fields. Its original XML, log and durable events are retained.
Connected native schematic pins must agree with the PCB before any functional
assertion passes. The checker neither runs ERC/DRC nor changes CAD.

Export receipts currently report `hit:false,reusable:false`: a complete external
library/project-variable closure has not been certified for safe cache reuse.
The current native hierarchy, available project file, sources, actual exporter
binary and checker implementations are hashed and rechecked after evaluation.

The manifest schema is `iot-lab.schematic-contract.v1`. Required top-level fields:

| Field | Meaning |
| --- | --- |
| `board`, `project` | Exact configured board and repository-relative native project stem. |
| `design_contract` | `{path,sha256}` binding the actual design contract. Its identity must name this board. |
| `part_review` | `{path,sha256}` binding a complete passing reviewed part-use manifest. |
| `population_source` | `{path,exists,sha256}` for this board's `variants.json`; explicit absence uses false/null. |
| `review` | Passed verdict, reviewer, timezone-bearing timestamp, `facts_sha256` and original review evidence. |
| `assertions` | Nonempty list of unique IDs and supported typed assertions. |

`facts_sha256` uses `factsDigest(manifest)` of `lib/part-review.ts`, excluding only the
manifest's root `review`. Sources use the existing `{path,sha256,page}` PDF or
`{path,sha256,section}` record descriptor. PDF pages are checked against the
original document. Each assertion names a `requirement` whose design verification
stage is `schematic`, plus a `source` for its engineering rationale.

Supported assertions are:

| `kind` | Required fields beyond ID, kind, requirement and source |
| --- | --- |
| `value` | `reference`, exact `mpn`, sourced `expected` interval, explicit `conditions`. Both schematic and PCB nominal values must agree. |
| `pin_net` | `reference`, string `pin`, exact `net`; optional reviewed `pin_name`. Both actual schematic and PCB must agree. |
| `population` | `reference`, boolean `dnp`, boolean `in_bom`, exact `fits` variant-name list. |
| `mode` | `reference`, custom native schematic `field`, explicit allowed strings, fitted `variant`. This checks the schematic's operating-state declaration; runtime behavior remains unproved. |
| `budget` | Exact `net`, `variant`, sourced `limit`, `loads`, `exclusions`, and explicit `conditions`. |

Intervals use finite JSON numbers `{min,max,unit,source}`. No tolerance or safety
margin is implicit. Supported dimensions are resistance, capacitance, inductance,
voltage, current, power, frequency, time and Celsius temperature. SI prefixes
canonicalize exactly: `1uF` and `1000nF` agree. Resistance supports IEC `4k7` and
`4R7`. A bare nominal value takes its dimension from the explicitly reviewed
assertion; a written conflicting unit fails. Unknown notation and nonfinite or
boolean quantities fail.

A condition is `{mode:ASSERTION_ID,value:EXACT_STATE}`. Mode assertions are
evaluated before dependent values and budgets. Budgets also require the mode's
variant to match. Each load supplies `reference`, explicit `conditions:[...]`,
and `reviewed_demand:{budget:ID}` or `reviewed_demand:{rating:ID}`.
The former selects this exact reference and net
from the reviewed part-use budget; the latter selects this part/profile's
required operating interval and applicability conditions. The selected reviewed
interval supplies the load demand directly. An optional `demand:INTERVAL` remains
supported for existing manifests and must match that reviewed interval after
unit normalization. Lower duplicate current estimates cannot make an inadequate
aggregate budget pass.
The selected demand must also cover every already reviewed demand for the same
net and reference. A positive reviewed load cannot be reclassified as a non-load.

Every fitted native reference touching the rail must appear exactly once as a
load or a sourced non-load classification
`{reference,reason,source}`. These classifications cover connectors, sources and
passives explicitly; they cannot conceal missing load coverage. Worst-case
demands are summed without an invented duty factor or concurrency credit.

Numeric design acceptance is checked against the measured canonical value or
aggregate demand, independently of the assertion's own interval. A mode or
population assertion cannot satisfy a numeric requirement. A reviewed textual
acceptance still depends on the author's declared functional assertions; the
checker does not infer additional circuitry or requirements from prose.

Reports include `assertions`, `requirement_results`, declared coverage counts,
source/tool hashes, explicit `absent_inputs` and the native export location.
`requirement_results[id]` passes only when all its declared assertions pass.
Consumers must also require overall `status:passed` and revalidate inputs; a
source change after measurement can invalidate the whole result.

`dependency_files(root,path)` lists exact existing contract, requirement, part
profile, original evidence and native dependencies for isolated operations.
Recorded absent inputs travel in the hashed manifest and are rechecked; they
are never represented by fabricated file hashes. The design evaluator invokes
this checker directly and consumes exact requirement IDs, rather than accepting
an arbitrary supplied report.

CPU verification:

```
PYTHONPATH=tools python3 -m unittest test_schematic_contract
```

Fixtures are synthetic and isolated. They keep the actual native identity,
review and design readers, replacing the native export process and the synthetic
PDF page-count boundary. Original PDF inspection remains separate native proof. Wrong
values, pin nets, DNP, modes, aggregate loads, missing branches and stale inputs
must fail independently of the circuit generator. Actual exporter compatibility
requires the separately recorded bounded native copy proof.

Actual native integration:

```
python3 tools/schematic_contract_smoke.py --output NEW_DIRECTORY --timeout 45
```

This uses KiCad10.0.6 on a synthetic source tree and a separate wrong-value
clone. Full mode requires the existing Poppler runtime for actual original PDF
page checks. `--export-only` provides narrower native CI coverage without
Poppler: actual XML export, production pin/mode parsing and exact nominal-value
canonicalization. Its receipt explicitly excludes PDF/part-review and complete
functional-contract verdicts. Neither mode runs ERC/DRC or routing.
