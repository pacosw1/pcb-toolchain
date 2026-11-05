# Bounded routing decisions

The unified CLI records a routing diagnosis as an unqualified engineering run:

```sh
tools/pcb routing --json diagnose ENV-SENSE --evidence /absolute/run/gate/result.json
tools/pcb repair ENV-SENSE --plan /absolute/diagnosis/operation/report.json --follow --json
```

Use the returned report path and `next_action.argv`. A supported diagnosis names
one local operation. Unsupported geometry, unknown rule coverage, missing native
checks or stale inputs remain blocked decisions; they never justify relaxing a
rule or launching another unchanged full-board route.

Diagnosis accepts the original configured gate `result.json`, a completed native
export `record.json`, or an `iot-lab.route-evidence.v1` envelope. The envelope
names the board, exact four native source hashes and original artifact paths plus
SHA-256 values. Its `native` artifact is a gate/export receipt; optional `triage`,
`escape`, `router` and `rules` artifacts retain their own source bindings. A loose
DRC JSON or old grid report cannot certify current inputs. The report records
which tool/library freshness checks remain for the fresh configured gate.

Findings distinguish native geometry/parity failures, native/router disagreement,
bounded escape/enclosure results, individually reachable `ROUTER_MISS` connections,
unknown constraints and unresolved native opens. `ROUTER_MISS` does not prove all
connections jointly routable. Grid enclosure does not prove physical impossibility.
Router completion is compared with native opens only for explicitly named completed
nets; omitted plane nets are never silently included in that comparison.

Two candidate patterns are supported:

- One straight gap between exact native track endpoint UUIDs, with the same net,
  layer and existing width. Only a 0/45/90-degree segment may be added. A conservative
  crossing screen rejects other-net tracks, pad/via envelopes and unsupported arcs.
  Endpoints come from source UUIDs and retained-copper connections; DRC display
  anchors may identify the opposite end. The nearest exposed endpoint pair must
  be unique; ambiguous patterns require further diagnosis.
- The existing two-layer local via repair: move one unlocked through-via along an
  incident straight trace and add one bridge on the other layer. All original
  tracks remain unchanged; via net, geometry and layers remain unchanged.

Each operation permits one proposal and preserves every other native form. Source,
evidence, implementation or plan changes invalidate it. The parent candidate
workflow creates the isolated snapshot, records the guard receipt, runs fresh
ERC/DRC/refill/parity plus configured electrical checks and board-specific checks,
and requires explicit adoption. Frozen boards still require a current failed
baseline and an exact defect ID. A guard receipt alone never permits adoption.

The existing compaction loop writes `route-decision.json` after native route
results. It suppresses a repeated failed source/rules/effort fingerprint within
that loop; changed effort or a distinct candidate remains eligible. Successful
clean scalar scores retain their existing meaning. Diagnostic refs and blocker
nets remain available alongside the score and existing bounded feedback.

Reviewed critical escape rules use `native_minimum_track_escape`, exact refs and
optionally explicit `{ref,pad}` selectors. `generate_escape_evidence` invokes the
existing native polygon/minimum-width grid in an owned, bounded process. Evidence
binds PCB/project/DRU/schematic hashes and every screened pad. It also binds the
actual grid/policy implementation, defaults and board feature configuration,
launcher, native Python/KiCad/NumPy versions and loaded runtime file hashes.
The effective grid/reach/layers and minimum-width/clearance model are explicit;
external feature-file overrides and mismatching board overrides are unsupported.
`generate_escape_for_candidate(root, board, candidate, output)` screens a complete
temporary native project using its reviewed owner's unchanged policy. Unsupported custom
DRU rules or unscreened requested pads block this screen. Width/clearance/layer or
grid overrides are not silently interpreted. It performs no duplicate DRC: the
fresh parent gate remains authoritative. KiCad Python and NumPy are required.

Verification: `node --test --experimental-strip-types --no-warnings tools/lib/route-decision.test.ts`.
