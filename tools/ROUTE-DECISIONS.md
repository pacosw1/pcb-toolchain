# Bounded routing decisions

## After a stuck route

`tools/pcb next BOARD` prints the stuck report of a failed route, then one move from this fixed list
(`tools/lib/route-moves.ts`). No other action exists, and a move is checked before it runs:

```sh
tools/pcb routing --json --follow move BOARD --evidence RUN/operation/stuck.json --move '{"kind":"reroute_stuck"}'
```

| Move | Fields | What it does |
| --- | --- | --- |
| `reroute_stuck` | | A route plan with `reuse`: start from that run's copper, route again what it left open. |
| `change_setting` | `setting`, `value` | `passes` (1..1000), `time_s` (above 0) or `layers` (of the board's routing layers). Rules, widths and clearances are no settings. |
| `move_part` | `ref`, `dx_mm`, `dy_mm` | A placement spec for `tools/pcb edit`. |
| `move_cluster` | `refs`, `dx_mm`, `dy_mm` | The same for two or more parts, one offset. A rigid group moves whole. |
| `swap_pins` | `ref`, `pads` | Only a proposal: nothing runs. It is a schematic change for a person to review. |
| `widen_region` | `nets` | `reuse` with the blocking nets routed again too. |
| `ask_user` | `question` | Stop and ask. |

A part move from `next` names the part with null offsets: fill them in. The answer is `accepted` with the next command, `rejected` with the
reasons, `proposal` or `ask_user`. Refused: an unknown move or field; a locked part; a part in a reviewed `fixed` rule; part of a
`rigid_group`; a pose off the board; a pad a reviewed rule names; nets the report does not name. Pin distance, clearance and connector
access are measured on the moved candidate by the checks every candidate run has, so a move can pass here and fail there.
Every move is reversible: it is a new candidate run, so discard the run. Only `tools/pcb adopt` changes canonical CAD.

`reroute_stuck` and `widen_region` are not suggested after a run that reused an earlier one and gained nothing, and they are refused after
one that came out worse: start from the earlier run. Neither is suggested for a net that is walled in while another move is open. On
ENV-SENSE held to one layer a reuse routed /SDA by ripping GND, and open connections went from 11 to 33 with 2 nets open before and after;
on both layers it went from 3 to 2, then stayed at 2. So the report counts connections as well as nets.

`tools/pcb route` stops when the latest route of the board in the runs folder ended stuck (it has `operation/stuck.json`), no accepted move
names that report, and the source revision and parameters of the new route equal those of the stuck run. The error names the run and the
`move` command that records the decision. A changed input, such as a new plan, a new `--from-run` or an adopted edit, allows the route. A
routing loop round is a decision of its own and is not stopped (`tools/ROUTING-LOOP.md`).

A `--router route-json` plan is also checked against the nets of its board when the route is admitted (`tools/lib/route-plan-nets.ts`):
the stages must cover every net with two or more pads, by `only_nets` or by a stage with no `only_nets`, and a net name in `only_nets`,
`plane_nets` or `unlock_nets` must be on the board. `skip_nets` are patterns and stage order is not checked.

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
