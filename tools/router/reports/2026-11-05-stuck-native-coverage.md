# Native connectivity coverage in the stuck report (#1319)

A route without `--diagnose` wrote native DRC and model artifacts but no optional
triage. The existing stuck report built its open-net list only from triage and
checkpoint entries. It therefore reported zero open nets and zero unknown causes
while native DRC still recorded open connections. Conversely, a stale optional
entry could claim a net remained open after native connectivity had closed it.

## Change and interface wording

Native `drc.json` now owns the current connectivity list. Optional diagnosis can
annotate a matching net and endpoint pair, in either endpoint order. Unmatched
rows are counted and excluded; absent diagnosis leaves an explicit unknown cause.
Known native endpoint positions still provide the region. Missing coordinates
are counted, not replaced by invented `(0, 0)` positions.

| Before | After | Why |
| --- | --- | --- |
| `0 nets open ... 0 unknown ... unconnected 11` | `2 named nets open ... 11 unknown ... unconnected 11` | Keep native facts when optional diagnosis is absent |
| `walled in ...` / comment says a board change is needed | `no path on diagnosis grid ...` | Grid reachability does not prove physical impossibility or authorize moving a part |
| `a path exists ... router missed it` | `path found on diagnosis grid ...` | A diagnostic grid path is not a native-verified routing result |
| Missing parity displayed as zero | `parity not reported` | Missing evidence is different from a checked zero |

The CLI keeps the existing technical, matter-of-fact voice. The summary row limit
is unchanged, and display text remains concise. Machine-readable native names
and counts remain available beyond the displayed rows. Rigid-group blockers are
not guessed from missing model data. No LLM, geometry, search or movement policy
is added.

## Coverage and change accounting

The schema remains `iot-lab.stuck-report.v1` with additive `coverage` and
`comparison_note` fields; the TypeScript reader declares these optional for older
reports. Existing field names remain available. Coverage counts native,
matched-diagnosis, undiagnosed, unlocated, unidentified, and unused-diagnosis
entries, and states whether parity was reported. Unknown totals include native
connections that cannot be displayed with a usable endpoint pair.

Changes compare DRC errors, native unconnected items **and** parity. A different
board or incomplete counter coverage produces an unknown comparison. Legacy
reports may have omitted undiagnosed net names: those names cannot become false
"new" or "resolved" changes merely because the reporting bug is fixed. Native
counter deltas can still be compared when the declared counters are complete.

Balanced bus-index names and their pad references are preserved rather than
truncated at the inner closing bracket. The writer refuses missing native
connectivity/violation arrays, malformed reported parity, and explicitly non-mm
coordinates rather than fabricating a clean report.

Endpoint matching excludes unrelated diagnostic rows; it is **not** a new full
freshness attestation of every triage input or obstacle. Grid evidence stays
qualified. The report never replaces native DRC or the complete board gate, and
this increment does not add failure-driven board movement or an LLM loop.

## Actual artifact replay

The unchanged native records come from the previously proven #1325 GND case:

| Historical artifact | Native opens | Old named nets / unknown | New named nets | New unknown |
| --- | ---: | --- | --- | ---: |
| Original one-layer partial route | 11 | 0 / 0 | `/SCL`, `/SDA` | 11 |
| Degraded reuse trial | 33 | 0 / 0 | `/SCL`, `GND` | 33 |

Both have zero native DRC and parity errors. The new comparison says `WORSE`,
connections 11 to 33, with GND newly open and SDA resolved. The reuse flag is
preserved by including the original seed artifact. All native input file hashes
stay unchanged, and repeating the same CLI commands in the same work folders
produces byte-identical JSON. These are historical native facts replayed through
a reporting transformation; no new board route or qualification is claimed.

Example summary from the 33-open case:

```text
2 named nets open: 0 grid blocked, 0 grid path found, 33 unknown; DRC errors 0 unconnected 33 parity 0
diagnosis coverage: 0 of 33 native connections; 0 unlocated, 0 unidentified, 0 unmatched diagnoses
changed: WORSE: DRC 0 -> 0, connections 11 -> 33, parity 0 -> 0; new GND, resolved /SDA, same 1
```

The compact replay bindings are in
[`2026-11-05-stuck-native-coverage.json`](2026-11-05-stuck-native-coverage.json).
Full original/native/model/seed artifacts, old and new reports, replay script,
summary output and validation logs are retained under the session's durable
`artifacts/router-stuck-report-1319/replay-evidence.tar.gz`, with gzip integrity
and SHA-256 verified:
`8626cf5093330fed480d822d14e918f6583d35134a6f72c9f1575dc0b81d9be4`.
The source native evidence archive hash is
`d1bbe133fb5c82d20eea39586f5cb7f019c663f61b77582db96ece9be009546a`.

## Validation

- Three targeted regressions fail before the fix: missing native opens, invented
  stale opens, and an unreported parity-only worsening.
- Final Rust suite: **929 passed, 2 existing ignores**. Focused cases also cover
  partial/reversed diagnosis, missing positions, native bus names, missing parity,
  legacy name coverage, board mismatch, incomplete counters and invalid inputs.
- TypeScript consumer tests: **86 passed, no skips** using the current prebuilt
  reporter with fixture tools and the real owned supervisor; strict typecheck
  passes. The initial missing-binary skips are retained in the work log and were
  resolved for the final run.
- Actual retained native 11/33-open artifacts: complete connectivity coverage,
  correct delta, unchanged inputs and deterministic repeated CLI output.

Implementation: `8295143`, based on main `0ade1ef`. No new Python, canonical CAD
changes, production runtime installation or new native board acceptance result.
