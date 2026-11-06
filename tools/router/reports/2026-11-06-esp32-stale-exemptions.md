# ESP32 candidate stale-exemption closure (#1446)

Both exact corrected #1412 rev B candidates now pass the fresh **full configured
board gate** after removing only the exemptions their original checks reported
as stale. User repo message 2776 explicitly authorized this cleanup. No PCB,
schematic, engineering rule, threshold, gate target or live exemption changed.
No new routing run was performed. No canonical CAD was adopted.

| Exact candidate | Ledger before / after | Removed stale entries | Fresh CLI run | Full gate |
|---|---:|---|---|---|
| Full control `e9464aaa...` | 37 / 32 | `/ETH_RSTn`, `/EXP_P04`, `/EXP_P06`, `/SPI_MOSI_S`, `/WDI` | `run-26Uiqv` | PASS |
| Scoped `f3dee697...` | 37 / 30 | `/ETH_INTn`, `/ETH_RSTn`, `/EXP_P02`, `/EXP_P03`, `/EXP_P06`, `/EXP_P07`, `/SPI_MOSI_S` | `run-sIFccU` | PASS |

Every removal is RP-001 and matched the exact original checker-reported stale
set. All retained entries, ordering and reason strings remain unchanged. The
remaining 32 / 30 exemptions still apply; this is acceptance under the existing
reviewed exemption contract, not a claim that the raw analyzers have no findings.

Both fresh runs report zero ERC errors, DRC errors, parity defects, opens, plane
failures, pair failures, low paths, via-pad failures, unwaived Happy findings,
stale exemptions and port-label failures. Existing warnings remain 337 ERC and
22 DRC in each case. Checker source, native image, numeric rules and the strict
stale-exemption exit policy were not changed. The checks use the same pinned
Rust binary `1c8fa034...`, Node `3517c2df...` and native image `8c1c6d83...` as the
corrected routing pair. See the exact hashes and commands in the JSON receipts.

## Geometry and revision binding

The cleanup ran in separate owned copies under `/var/tmp/esp32-stale-1446`.
Each copy starts with the frozen rev B project and the exact already-routed
candidate. Relative to the frozen source, only the candidate PCB and reviewed
exemption ledger differ. Fresh checking leaves the candidate and ledger hashes
unchanged. Owned children are reaped, their groups are gone, and both containers
are removed and independently absent.

The current iot-lab main is **a different rev C design**: source `27660119...`,
PCB `33baa9f5...`, with nine ledger entries. Its source CLI context/next reports
a retained C layout with no current unified check. None of the rev B ledger
removals was applied to C. The local installed launcher refused the project's
0.2.13 pin because it is an older bundle; source CLI context/next was used only
for read-only revision identification. No version-mismatch bypass or global
installation was performed.

The concrete reviewed configuration is in
[review.json](2026-11-06-esp32-stale-exemptions/review.json), bound to each exact
candidate hash, with all removed and retained entries. It is **not** a ledger
replacement for a different revision or geometry.

## Evidence and limits

[summary.json](2026-11-06-esp32-stale-exemptions/summary.json) retains the actual
full-gate metrics, CLI result hashes, runtime bindings, reviewed ledger hashes,
candidate preservation and terminal cleanup. Raw checks, native candidates,
configuration, context and helpers are sealed at
`/var/lib/cip/saved-artifacts/esp32-stale-1446/evidence.tar.gz`, SHA256
`eaff1e76a0eac0ed6be55dfc47713056b05aacde1c644fffd137a5255d90ec57`.
The durable local copy has the same verified hash.

The original #1412 timing records and official 5 / 7 stale failures remain
immutable. These are later, separately measured checks after a reviewed data
change; do not splice their cost into an invented timed whole-run measurement
or retroactively relabel the original checks as passed. Exact unrelated-copper
preservation and the observed single-pair timing reduction are documented in
[the routing report](2026-11-06-ref-feedback-reuse.md). This closure establishes
the configured gate for the two named copies, not current rev C readiness,
physical qualification, manufacturing release or canonical adoption.
