# Preserve the better unchanged-input reuse incumbent (#1325)

The reported ENV-SENSE failure is reproduced: a six-pass one-layer route leaves
SCL/SDA open but keeps GND connected. Reuse initially keeps three nets and
reroutes SCL/SDA; negotiation and strict recovery then remove all GND tracks.
The run returns more native unconnected items, although its aggregate failed-net
count is still two. No canonical board is adopted during this reproduction.

## Observed native result

| State | Total tracks | GND tracks | DRC / opens / parity | Board status |
| --- | ---: | ---: | --- | --- |
| Original six-pass partial route | 135 | 77 | 0 / 11 / 0 | FAIL |
| Previous reuse result | 95 | 0 | 0 / 33 / 0 | FAIL |
| New reuse trial, retained as evidence | 95 | 0 | 0 / 33 / 0 | FAIL |
| New selected, freshly checked incumbent | 135 | 77 | 0 / 11 / 0 | FAIL |

The new trial has exactly the same board bytes as the old degraded result. The
change is truthful incumbent selection, not a claim that this search now solves
the one-layer board. The selected board is byte-identical to the original partial
route. It remains incomplete and exits with `FAIL`; no stale receipt turns it into
an accepted board.

## Change

Retained copper stays negotiable; useful movement is not disabled. The native
run controller now includes the earlier route as a candidate only when:

- No part has moved under the existing pose comparison.
- The previous model file matches its own recorded SHA-256.
- Every value in the current admitted model equals the previous model, except
  the isolated input-copy `pcb` filename. Geometry, rules, layer/net scope,
  copper, limits and other policy data cannot be excluded from this comparison.

Missing, altered, or changed models decline replay and record the reason in
`reuse.incumbent_note`. This deliberately requires exact model-value equality;
it does not claim geometric equivalence for differently represented models.

When routing leaves native problems, an eligible earlier route is copied into
`a-incumbent`, rewritten through the **current** width rules, native writer and
copper-preservation guards, and checked with fresh native DRC/parity. Only a
strictly better result under the existing native-problem/failed-net ordering can
replace the trial. Cached acceptance counts are never used to select it. Clean
trials avoid this extra replay cost. Existing reuse/full tie behavior is retained.

```text
partial reuse trial -> fresh native counts
                           |
                           v
same admitted problem? -> replay incumbent -> fresh native counts
                           |
                           v
                   choose strictly better
                   retain every attempt
```

`--reuse-fallback none` still disables a new full-routing search. It no longer
forces a worse trial to replace an eligible, freshly checked incumbent. Direct
core search and moved/changed-input reuse retain their existing behavior; this
increment does not solve every recovery failure after geometry changes.

The selected incumbent has an explicitly named attempt, a replay log and a
zero-search core stage with its original incomplete claim. Its write/native
checks are new. All trial artifacts remain available for diagnosis. A future
reuse of an incumbent does not accumulate the rejected trial's passes as if its
search state had won.

## Validation

| Check | Evidence |
| --- | --- |
| Before diagnostic | daemon job `20261105-195058-b70f1f` |
| After diagnostic | daemon job `20261105-195517-d1dda3` |
| Ordinary two-layer acceptance | daemon job `20261105-195730-a59f6a` |
| Rust suite | 917 passed, 2 existing ignores |
| Eligibility regressions | PCB-copy path allowed; changed model fields, moved parts, missing metadata and altered receipt binding rejected |
| Partial-incumbent status | FAIL preserved, not promoted to PASS |
| Ordinary acceptance result | PASS; native 0 / 0 / 0, fresh configured gate and both semantic hooks pass |
| Ordinary accepted copper | 177 tracks, 20 vias, 262.0 mm; same accepted bytes as prior fixture proof |

The diagnostics run sequentially on Hetzner using the same frozen ENV-SENSE
source, one-layer/six-pass policy, pinned Node and existing nightly image. Each
has two CPUs, 4 GiB, a 240-second daemon limit, one attempt and retries zero.
Their daemon `passed` states mean the diagnostic assertions completed; the
partial boards themselves **failed** acceptance. The ordinary two-layer check
uses a 120-second limit and its full acceptance harness. This is correctness
proof, not a performance benchmark or a general speedup claim. Board experiments
remain on Hetzner, not CI. The retained submit helper's mode labels select the
before/after diagnostic phases; neither phase runs the sprint portfolio.

The implementation is `4ee875880cbcfa6f8b5ccabd466f8156279098c8` on base
`6aa3e07`. Its router core and diagnostic helper are identical to the tested
pre-rebase `3a6e578`; the intervening main changes affect only the placer.
Tests cover receipt integrity and model changes so an old route cannot be
replayed merely because it has the same part names or a favorable old score.

The initial raw-core reproduction retains its failed mount setup: the image's
non-root user could not traverse the scratch root. The corrected run uses
read-only evidence plus a separately writable diagnostic subdirectory. The raw
core produces 94 tracks before width finalization; the native run produces the
reported 95-track degraded board. These are separate stages, not conflicting
measurements. No new Python or service configuration is introduced.

## Bindings and retention

| Artifact | SHA-256 |
| --- | --- |
| Frozen source PCB | `6abb00a0a30cd3f02d6e96a0cb326e16c1f050b735e5ed43770dcbf653844ae7` |
| Partial incumbent and new selected board | `6441ad36ea8986da9b5549d9e0db1dd420d7608f2ac5fc36d5ed4f969283ee14` |
| Degraded trial, before and after | `f1812f9a5a42038247f305580118568950f8a4a00b7f4aa669b83da5a3b22723` |
| Ordinary accepted board | `7c4dd481c5454a055da4b956124c984cae450a17547d81c3abe5092b31316da3` |
| Tested new Linux router | `f71a7a737f02ba9920d6ab6b6bd65d1f879f4ae8ee23c1321e0db7e86358d747` |
| Complete native evidence archive | `d1bbe133fb5c82d20eea39586f5cb7f019c663f61b77582db96ece9be009546a` |

All diagnostic/native job terminal states, trimmed attempts and absent containers
are checked independently. The ordinary acceptance run also confirms all four
owned stages completed cleanup. Full before/after routes, models, native reports,
receipts, source baseline bundle and failed setup logs are retained with the
archive in durable `artifacts/router-gnd-reuse-1325/`, together with the tested
binary and unit-suite logs. The archive passes gzip integrity and checksum checks.
No physical runtime installation or canonical board adoption is performed.
