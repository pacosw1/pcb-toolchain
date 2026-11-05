# Mechanical inventory and owned binding: task 1330 slices 1-2

The native inventory now reaches actionable part-review results when a pinless
symbol has an actual unconnected NPTH-only footprint. Electrical, connected,
mixed-pad and padless cases remain per-reference blockers with schematic path
and selected unit. Classification does not change BOM/DNP requirements or grant
review approval. Other native parts remain available when one part is blocked.

The current TypeScript CLI already admitted `blocks bind`; the obsolete Python
allowlist finding no longer applied. The remaining gap was the owned artifact.
The supervisor now writes and seals `operation/binding.json`, verifies freshness,
and returns both the canonical binding fingerprint and raw file SHA256. The
binding remains a candidate with qualification and copper approval false.

## Read-only real fixture

Input: iot-lab commit `be07935b74613204a597bb0f7d03029c933a1117`.
Baseline tools: `228b964205037621c36cbc39f92bd0f6d8301d86`.
Integrated tools base: `dba19431f7184582008d02e1f2a901f000ce9709`, plus this change.
Runs used Linux Node 22 and the existing Rust owned-process helper; no Rust
implementation change was required. No CAD, stock, profiles or contracts changed.
BASE-PWR was not used. POE-ETHERNET reproduced the mechanical-symbol defect.

| Operation | Before run | After run | Before / after elapsed |
|---|---|---|---|
| POE-ETHERNET parts status | run-5Qdw9Z | run-Sl2u3W | 1.141 / 1.265 s |
| BUCK-3V3-AP63203 bind to DOOR-RELAY | run-dHeeaB | run-72wc3o | 0.495 / 0.519 s |

Before, parts status returned a contextless selected-unit-pin runtime failure and
zero parts. After, it returned 56 parts, identified H3/H4 as mechanical, and
reported the 40 references missing native part review. Status correctly remains
blocked: qualified, stock-current and release-approved are false. Both runs
completed cleanup. These are single-run feedback times, not performance claims.

Before, binding discovery passed without an artifact. After, the owned run
returned a sealed draft with the existing exact mapping:

| Source | Target |
|---|---|
| U2 | U4 |
| L1 | L2 |
| C1 | C21 |
| C2 | C19 |
| C3 | C20 |
| C6 | C22 |
| C7 | C18 |

Rotation is zero; translation is [6.93, 19.85] mm. VIN_5V maps to 5V_SYS.
The canonical binding fingerprint is
`d954ff15bb6ff31ed8b7e700af4bbb0944d67f008f426bf6b5c6f927b3fae22f`;
the raw file and sealed-file hash are
`773d93ed50321e65b90e7a954e8e71ec563e7fc56bfac9dbaed0e21ac37acbf6`.
DOOR-RELAY still has no gate.json and remains an unconfigured legacy target.
Binding does not establish release, electrical, package or thermal qualification.
All 24 source/target CAD hash comparisons matched the immutable fixture.

## Verification and evidence

The five-file Linux suite passed 81 tests with no failures or skips, covering
native parts, part evidence/PDF cache, binding, reuse, and the owned supervisor.
The final canonical/raw hash contract passed all three supervisor tests again.
Source/bundle synchronization passed nine tests. Type checking passed. The final
native regression rerun also covers a padless footprint remaining blocked.
Negative coverage includes connected/mixed electrical geometry, wrong unit,
unchanged unrelated electrical hashes, stock queries blocked before execution,
changed identity, stale binding, tampering and caller output overrides.

The machine-readable summary is [2026-11-05-mechanical-bind.json](2026-11-05-mechanical-bind.json).
Original receipts, test logs and summary are archived on the CI host at
`/var/lib/cip/saved-artifacts/mechanical-bind-1330/evidence.tar.gz`, SHA256
`ab180db1429d13d9a43dd4347142b476bf8d6fbd1295f183e56246cd63e0195f`.
An intermediate run used the earlier hash label; `run-72wc3o` is authoritative.

Slices 3-5 remain deferred: sourced part profiles and applicability contracts,
placement/routing integration, and a reviewed qualification/adoption cycle.
