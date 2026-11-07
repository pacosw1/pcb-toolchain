# PCB state machine

This file maps the state machine of one board, from the first idea to the assembled board.
It lists each state, the check that lets a board enter it, and the tool that enforces it.
It also lists the states that no tool enforces. The diagram is in
[PCB-STATE-MACHINE.svg](PCB-STATE-MACHINE.svg). Its source is
[PCB-STATE-MACHINE.dot](PCB-STATE-MACHINE.dot).

This file maps what exists. It adds no new rule and no new state.
All paths are under `tools/`. A reference `lib/x.ts:12` means `tools/lib/x.ts`, line 12.
The code is the branch `codex/setup-batch`. The lab data (`hardware-design/`) is not in this repository.

## Status values

| Status | Meaning |
|---|---|
| `enforced` | A tool stops the process when the check fails. |
| `recorded` | A tool records the state or reports a finding. No tool stops the process. |
| `implicit` | Only habit, Markdown, or the memory of an agent holds the state. |

A caveat in the "Enforced by" column tells you when the stop has a bypass.
The two bypasses are an exemption row in `registry/boards.json` and a Claude Code hook that other agents do not use.

## A. States of the board process

The order is the order of the work. Failure paths are in the "Next states" column.
Build (A20) is another path to a candidate: a pipeline script can make the whole layout.

| State | Entry check | Input | Output | Next states (fail paths in brackets) | Enforced by | Status |
|---|---|---|---|---|---|---|
| A1 Requirements and spec | The board has a design contract, or an exemption. `SPEC.md` and the packet files exist. | `SPEC.md`, shared Markdown, requirement rows (statement, source, verification stage). | Design contract `design-contracts/BOARD.json`. Stage assessment (`passed`, `blocked`, `stale`). | A2. [`design_contract_missing`; `design_assessment_stale`; `stuck` after the same failure twice] | `lib/design-contract-load.ts:13`, `:87`, `:165`. `lib/pcb-next.ts:241`, `:257`, `:213`. `lib/pcb-workflow.ts:162-168`. Bypass: exemption (B1). | `enforced` |
| A2 Architecture | A1 passed. | Interfaces, decisions, unknowns, test plans. | Stage result in the assessment. | A3. [`blocked` with the unknown that has an owner and a blocking stage] | `lib/design-contract-load.ts:126`. `lib/pcb-action.ts:31` (build needs architecture). `lib/pcb-candidate-screens.ts:56-73`. Bypass: exemption (B1). | `enforced` |
| A3 Part selection and part records | A manifest `part-reviews/BOARD.json` exists. Without it, no tool stops. | Part-use manifest, datasheet PDFs with `.source.json`, dated JLC evidence. | Part report (`passed`, `blocked`, `stale`). Selection ledger state `electrically-selected`. | A4. [`missing_part_review`; `blocked`; `stale`; the candidate run stops with scope `engineering_preflight`] | `lib/part-review.ts:563-573`, `:587-600`. `lib/pcb-candidate-run.ts:84-95` (stops only when a manifest is bound). `lib/board-selections.mjs:10`, `:60`. | `recorded` |
| A4 Schematic | A3 passed for a board with a contract. The CAD seal is intact. | `.kicad_sch`, `.kicad_pro`, schematic contract manifest. | Sealed schematic. ERC result. `schematic_sha256`. | A5. [ERC errors fail the gate at G3; `cad_changed`; the layout approval becomes stale (A8)] | `lib/gate-core.mjs:51-54` (G3 needs `erc`). `lib/cad-seal.ts:15`, `:52-71`. `lib/pcb-check-start.ts:44`. `lib/pcb-next.ts:259-260`. The `schematic` passthrough has no stage check (`DESIGN-CONTRACT.md:159-160`). | `enforced` |
| A5 BOM | `BOM-VERIFIED.csv` and its scope file exist. | `BOM-VERIFIED.csv`, `BOM-VERIFIED.scope.json`, registry BOM owner. | Coverage findings. Verified BOM. | A6. [`missing_context_source` (file absent); coverage finding in `check-packets` and `check-consistency`] | `lib/pcb-workflow.ts:18`, `:198`. `lib/pcb-next.ts:257`. `lib/board-packets.mjs:9`. `lib/bom-ownership.mjs` (`revisionBoms`). The lab runs the coverage check, not `pcb next`. | `recorded` |
| A6 Stackup (planned, #1554) | None. No step asks for a layer count or layer roles. | None today. Plan: RF nets, fast pairs, current, pin density, net count. | None today. Plan: layer data file and stack image. | A7. [none] | None. `set_stackup.ts:1-12` writes a stackup into the board, but no stage requires it. `kicad_happy_gate.ts:171` fails only a missing return dielectric. | `implicit` (planned) |
| A7 Layout plan written | The CAD seal is intact. Rules and route plan files exist. | Intents (`id`, `statement`, `rule_ids`), `route_plan` path, `placement-constraints.json`. | `layout-plan.json` with `approval: null`. | A8. [state `invalid` with the problem list; `missing`] | `lib/layout-plan.ts:53-111` (inspect), `:118-136` (status). `pcb-layout.ts:44`. | `enforced` |
| A8 Layout plan approved (person gate) | A valid plan. An intact seal. The route plan matches the board nets. | Name, reason, image the person saw (PNG or SVG in the project). | `approval` with hashes of rules, route plan, schematic and image. Copy of the image. | A9. [`layout_plan_stale` when rules, route plan, schematic or image change: go to A7 or A8; `layout_plan_missing`] | `lib/layout-plan.ts:129-135`, `:139-149`, `:174-193`. `lib/pcb-candidate-screens.ts:76-83`. `pcb-place.ts:105-109`. `lib/pcb-next.ts:261-266`. Bypass: exemption (B1). The person check is in a hook only (D1). | `enforced` |
| A9 Placement seeds | `admitPlace`: seal intact and plan approved. | Board, `--seeds N`, placement rules. | One spec file per seed `.gate/place/BOARD-seedN.json`. A table with legality, misses and estimates. | A10. [`NO LEGAL CANDIDATE`, exit 3: go to A7] | `pcb-place.ts:41`, `:80-90`, `:92-101`, `:105-109`. `lib/placement-rules.ts:37`. | `enforced` |
| A10 Placement seed choice | The spec of a place edit is a row of `.gate/place/BOARD-candidates.json`, or the call names an origin (`--origin hand` or `--origin move`). | The table and the spec files. | The spec file that a person or an agent passes to `edit --kind place`. | A11. [`the place spec is not a row of ...`: run `pcb place BOARD --seeds N`, or pass `--origin`] | `pcb-place.ts:77-85`, `:96` (the record). `lib/place-record.ts`. `lib/pcb-candidate-admission.ts:49` (`place_choice` in `run.json`: the row and the whole table, so a new `pcb place` call does not erase the reason). | `enforced` |
| A11 Place edit (candidate run) | Design stage `schematic`. Approved plan. Seal intact. The action is admitted. | Spec `{"place": {...}}`, optional part review. | Isolated candidate. `operation/source.json`. `images/top.svg` and `images/bottom.svg`. | A18 gate, then A19 adopt. [`engineering_preflight`; `candidate_place_check`; failed gate: go to A9 or A10] | `lib/pcb-candidate-run.ts:351-362` (order), `:205-240`. `lib/pcb-action.ts:29-33`. `lib/stage-contracts.ts:14`. `pcb-check-finalize.ts:107-108`. | `enforced` |
| A12 Board placed check (before route) | Placement rules fail on the board. | Board, `placement-constraints.json`. | Report `placement-rules-preflight.json`. | A13. [`board_unplaced` and state `needs_place`: go to A9] | `lib/pcb-candidate-run.ts:105-130`. `lib/pcb-next.ts:268-269`. A waiting candidate comes first: `next` names the adoption. | `enforced` |
| A13 RF route | The board is placed. `rf-lines.json` and the `rf` gate check exist. | Route plan stage for RF nets, `rf-lines.json` (width, gap, reference, length). | RF copper in a candidate. `rf` check result. | A14. [`rf_failures` fail the gate: go to A14 or A11] | `rf_lines.ts:1-20`. `lib/gate-core.mjs:38` (`rf` is optional, `:53` does not require it). `lib/route-plan-schema.ts:101-110` (stage names only). The rule "RF first" is the order of the stage list: no tool checks it. | `recorded` |
| A14 Staged route | Approved plan. Placed board. Route not repeated. Design stage `placement`. | `route.json` stages, or a policy, or an explicit spec. | Routed candidate. Or `operation/stuck.json`. | A18 gate. [stuck: A15; failed run: A18 finding] | `lib/pcb-check-start.ts:66`. `lib/route-repeat.ts:22-39`. `lib/pcb-candidate-screens.ts:76-83`. `lib/pcb-candidate-run.ts:105-130`, `:156`, `:178`, `:286-341`. `lib/pcb-action.ts:32`. | `enforced` |
| A15 Route stuck and decision | The last route of the board ended stuck. | `stuck.json`, reviewed rules, a recorded move. | A route decision (`reroute_stuck`, `change_setting`, `move_part`, `move_cluster`, `swap_pins`, `widen_region`, `ask_user`). | A14 with new inputs, A16, or A11. [a rerun with the same inputs stops] | `lib/route-repeat.ts:22-39`. `lib/route-moves.ts:21`, `:61`, `:185`. `lib/route-stuck.ts:10`, `:41`. `lib/pcb-next.ts:306-312`. | `enforced` |
| A16 Diagnose and repair | Native evidence supports one bounded repair. | Diagnosis, repair plan, optional `--from-run`. | Repair candidate with images. | A18 gate. [`repair guard` failure; state `needs_diagnosis`] | `lib/pcb-candidate-run.ts:132-138`. `lib/pcb-next.ts:294-298`, `:336`. `lib/pcb-candidate-screens.ts:76-83`. | `enforced` |
| A17 Finishing edits (stitching, silk, test points, courtyards) | The seal is intact. | Routed board, options such as `--skip`, `--via`, `--through-pours`. | Edited board. Seal log line. Stitch report with the options. | A18. [a failed net names `FAILED` and exits 1; `NOROOM` nets are listed] | `stitch_all.ts:34`, `:69`. `lib/cad-seal.ts:157-169` (`sealedWrite`). `lib/pcbtool-write.ts:187`, `:447`. No stage and no run record. | `recorded` |
| A18 Gate (G3, G4, G5) | The seal is intact. The checks of `gate.json` are valid. | Board CAD, `gate.json`, check data files. | `gate/result.json`, `findings.json`, ERC and DRC reports with hashes. | A19, A20 or A21. [`gate_finding`; `operation_failed`; `evidence_not_current`] | `lib/gate-core.mjs:35-39`, `:47-58`. `lib/pcb-candidate-run.ts:244-258`. `lib/pcb-next.ts:316-319`, `:329-341`. The gate configuration is not sealed (D2). | `enforced` |
| A19 Adopt | A passed, settled candidate from this checkout. Seal intact. | Candidate run, `--baseline` and `--defect` for a frozen board. | Canonical PCB replaced. Backup. `adoption.json`. New seal. | A12 or A21. [refuse: stale inputs, changed identity, no defect; interrupted adoption keeps a journal] | `lib/pcb-candidate.ts:151-165`, `:195-213`, `:215-255`, `:257-270`. `lib/pcb-next.ts:344-345`. `checkAdoptable` calls `contractProblem`; `next` shows the image paths. | `enforced` |
| A20 Build (pipeline) | Design stage `architecture`. Approved plan. Seal intact. | The `pipeline` script of `gate.json`. | Candidate with images. | A18 gate. [failed run] | `lib/pcb-workflow.ts:236-240`. `lib/pcb-action.ts:31`. `lib/pcb-candidate-screens.ts:76-83`. `lib/stage-contracts.ts:17`. | `enforced` |
| A21 Release candidate | Design stage `routing`. Fresh gate. Board checks pass. | Board, release recipe in `gate.json`. | Staged Gerber, BOM, CPL. `release-manifest.json`. File `VERIFIED`. | A23. [`FAIL: release stopped`, evidence kept; destination exists] | `fab-workflow.sh:16-71`. `lib/pcb-action.ts:30`. `check-release-gate.mjs:21-24`. `check-release-fab.mjs:12-26`. `publish-release.mjs:32-46`. | `enforced` |
| A22 Release approval G5 (person gate) | None. | A person reviews the candidate. | None. The manifest says `g5_ready: false`. | A23. [none] | None. `check-release-fab.mjs:23` and `lib/release-readiness.mjs:122` write `false` always. | `implicit` |
| A23 Readiness (stock, assembly, orientation) | A release candidate. A stock receipt of the order day. | Candidate folder, stock receipt, `--boards`. | Readiness report with `ordered: false`. | A24. [`needs_review`; `needs_stock_refresh` when the UTC day changes] | `lib/release-readiness.mjs:83`, `:118`, `:122`. `lib/pcb-next.ts:278`, `:286-292`, `:347`. | `recorded` |
| A24 Fabrication order and assembly | None. | The release candidate and the JLC submission notes. | Ordered boards, assembled boards. | A25. [none] | None. `fab-workflow.sh:2` says it never orders or uploads. `lib/board-packets.mjs:9` checks only that `JLC-SUBMISSION.md` exists. | `implicit` |
| A25 Bring-up | A contract stage `prototype` with a bench check. | Approved test plan, raw measured data, instruments, board serial. | Bench receipt. Block level 2. | End. [none] | `lib/block-qualification.ts:399-405`. `blocks.ts:23-24`. `lib/board-packets.mjs:9` (`BRINGUP-TEST-PLAN.md` exists). No tool requires bench data before release. | `recorded` |

## B. States in the code that are not in the list above

| State | Entry check | Input | Output | Next states (fail paths in brackets) | Enforced by | Status |
|---|---|---|---|---|---|---|
| B1 Exemption (`design_contract_exempt`, `layout_plan_exempt`) | A row in `registry/boards.json` with a non-empty reason. | Free text reason. | Event `design.exempt` or `layout_plan.exempt` on each run. | The run continues with no contract or no plan. [an empty reason stops the command] | `lib/design-exemption.ts:11-21`. `lib/pcb-candidate-screens.ts:41-43`. `lib/layout-plan.ts:141`. `hooks/claude-cad-guard.mjs:29`, `:32`. Nothing reads the events. | `recorded` |
| B2 Board lifecycle (`planned`, `active`, `historical`, `obsolete`) | A registry row. | `registry/boards.json`. | Packet and layout rules by lifecycle. | Any. [`unregistered_board`, `invalid classification`] | `lib/board-packets.mjs:18`, `:24`. `lib/project-layout.ts:28`, `:159`. | `recorded` |
| B3 CAD seal (`sealed`, `changed`, `missing`, `not_canonical`) | The CAD files match `cad-seal.json`. | `.kicad_pcb`, `.kicad_sch`, `.kicad_pro`, `.kicad_dru`, `placement-constraints.json`. | `cad-seal.json`. Log `.gate/cad-seal/BOARD.jsonl`. | `sealed`. [`changed` or `missing`: `cad_unsealed`, all CAD commands stop] | `lib/cad-seal.ts:15`, `:21`, `:52-71`, `:74-82`, `:157-169`. `lib/pcb-next.ts:259-260`. | `enforced` |
| B4 Seal accept (person gate) | A reason text. A canonical root. | `--accept --reason TEXT`. | A new seal with the reason in the log. | B3 `sealed`. [empty reason stops] | `lib/cad-seal.ts:131-135`. `hooks/claude-cad-guard.mjs:35-36`. The person check is in a hook only (D1). | `enforced` |
| B5 Placement rules (`placement-constraints.json`) | The seal is intact. Source hashes are valid. | `pcb constraints --add SPEC --reason TEXT`, or `--remove ID`. | Rules file. A new seal line with the reason. | A7 (the approval becomes stale). [bad reference or hash stops] | `pcb-constraints.ts:33`, `:65`. `lib/cad-seal.ts:15`. `hooks/claude-cad-guard.mjs:34`. | `enforced` |
| B6 Run status (`starting`, `running`, `stopping`, `passed`, `failed`, `error`, `cancelled`, `timeout`) | A run folder with `run.json`. | The owned supervisor. | `state.json`, `result.json` with sealed evidence. | A terminal status. [an unknown status gives `invalid_run_state`] | `lib/pcb-next.ts:25`, `:27`, `:248`, `:250`. | `enforced` |
| B7 Stage contract (source record and two images) | A passed `place`, `edit`, `route`, `build` or `repair` run. | `operation/source.json`, `images/top.svg`, `images/bottom.svg`. | Run sealed as `error` when a file is missing. | A passed run. [`stage contract not met`] | `lib/stage-contracts.ts:13-20`, `:25-41`. `pcb-check-finalize.ts:107-108`. `lib/pcb-candidate-run.ts:261-266`, `:335`. | `enforced` |
| B8 Candidate action (`iot-lab.candidate-action.v1`) | The source revision and parameters at admission. | The request of `edit`, `route`, `repair`. | Action record in `run.json`. | The run. [source change, wider scope or wrong prerequisite stage stops the run] | `lib/pcb-action.ts:93-108`. `lib/pcb-candidate-run.ts:310`, `:356`. | `enforced` |
| B9 Adoption journal (intent, replaced, receipt) | A claim lock on the board. | Candidate hashes, target hash. | `.gate/board-locks/BOARD.adoption.json`. `adoption.json`. | A19 end. [a crash keeps the journal; the next adopt settles it or stops] | `lib/pcb-candidate.ts:167`, `:181-213`, `:223-226`, `:250-254`. | `enforced` |
| B10 Routing loop round (experimental) | A loop context with id, round 1 to 8, deadline. | Loop context. | One route run per round. | A14. [an invalid or expired context stops] | `lib/pcb-check-start.ts:61-65`. | `enforced` |
| B11 Engineering cycle (`open`, `recorded`) | An open cycle that belongs to this checkout. | `pcb cycle start`, activities, attached runs. | Cycle record with timings. It grants no qualification. | `recorded`. [a closed cycle stops new work] | `lib/pcb-cycle.ts:12-13`, `:42`, `:89`, `:98`. `lib/pcb-check-start.ts:53`. | `recorded` |
| B12 Production evidence (contract stage) | A contract that reaches the stage `production`. | Sourced applicability of assembly, test coverage, yield. | A `blocked` stage: the controls are unsupported. | None. [always `blocked`] | `lib/design-contract.ts:122`. `lib/design-contract-load.ts:13`. | `recorded` |
| B13 Agent trial (`run.pending.json` then `run.json`) | One trial runs once. | A trial case. | `run.json` or a settled crash record. | `collect`. [a crashed runner gives a failed verdict] | `lib/agent-trial-run.ts:42-60`. | `enforced` |
| B14 Frozen board | The line `- BOARD` under `## Frozen` in `FOCUS.md`. | `FOCUS.md` text. | `frozen: true` in `context`. Adopt then needs `--baseline` and `--defect`. | A19. [a missing file or heading reads as not frozen] | `lib/pcb-workflow.ts:138-139`, `:187-188`, `:202`. `lib/pcb-candidate.ts:268-269`. | `implicit` |
| B15 Person approval (who approves) | None. | `--by NAME` is any text. | The name in the approval. | A8, B4, B5. [none] | A regex in a Claude Code hook only: `hooks/claude-cad-guard.mjs:33-36`. `lib/layout-plan.ts:175`. | `implicit` |
| B16 Gate configuration and check data files | None. | `gate.json` (`stage`, `checks`), `reference-planes.json`, `diff-pairs.json`, `current-paths.json`, `rf-lines.json`. | None. | A18. [none] | None. The seal pattern covers `.kicad_*` and `placement-constraints.json` only (`lib/cad-seal.ts:15`). | `implicit` |
| B17 Route environment settings | None. | `ROUTE_FEATURES`, `ROUTE_FEATURES_FILE`, `ROUTE_BOARD` in the environment. | None. | A14. [none] | `lib/pcb-candidate-run.ts:278` copies `process.env`. `lib/pcb-action.ts:34` does not record them. | `implicit` |
| B18 Route dispatch fallback | None. | Exit code 2 and the stderr text. | A local route when the text says "the daemon took no job". | A14. [none] | `router/route-dispatch.mjs:353`. | `implicit` |

## C. The states and codes of `pcb next`

`pcb next` only recommends a command. It never runs it (`lib/pcb-next.ts:1`).
It is a view of the states in section A, not a second state machine.
A run that is not finished gives the state `observe` first.

| Path | State | Code | Line | Recommended command |
|---|---|---|---|---|
| design | `needs_check` | `design_assessment_missing`, `design_assessment_stale` | `lib/pcb-next.ts:189`, `:218` | `design check` |
| design | `observe` | `run_in_progress` | `lib/pcb-next.ts:192` | `events --wait` |
| design | `stuck` | `repeated_unchanged_failure` | `lib/pcb-next.ts:213` | `explain` |
| design | `blocked` | first blocker code of the assessment | `lib/pcb-next.ts:213` | `explain` |
| design | `review` | `design_stage_review` | `lib/pcb-next.ts:213` | `explain` |
| board | `blocked` | `pending_gate` | `lib/pcb-next.ts:240` | `context` |
| board | `blocked` | `design_contract_missing` | `lib/pcb-next.ts:241` | `context` |
| board | `observe` | `run_in_progress` | `lib/pcb-next.ts:251` | `events --wait` |
| board | `blocked` | `invalid_run_state` | `lib/pcb-next.ts:254` | `status` |
| board | `blocked` | `missing_native_input`, `missing_context_source` | `lib/pcb-next.ts:257` | `context` |
| board | `cad_unsealed` | `cad_seal_missing`, `cad_changed` | `lib/pcb-next.ts:259-260` | `seal` |
| board | `blocked` | `layout_plan_missing`, `layout_plan_stale` | `lib/pcb-next.ts:264` | `layout` |
| board | `needs_place` | `board_unplaced` | `lib/pcb-next.ts:269` | `place` |
| board | `needs_check` | `current_check_missing`, `evidence_not_current` | `lib/pcb-next.ts:270`, `:354` | `check` |
| board | `blocked` | `run_not_completed` | `lib/pcb-next.ts:273` | `explain` |
| board | `review` | `readiness_requires_current_review` | `lib/pcb-next.ts:278` | `explain` |
| board | `needs_stock_refresh` | `stock_day_expired` | `lib/pcb-next.ts:290`, `:292` | `parts stock` |
| board | `needs_route_move` | `route_move_accepted` | `lib/pcb-next.ts:296` | the accepted move |
| board | `needs_repair` | `bounded_route_repair` | `lib/pcb-next.ts:298` | `repair` |
| board | `review` or `blocked` | engineering blocker code | `lib/pcb-next.ts:300` | `explain` |
| board | `stuck` | `route_stuck` | `lib/pcb-next.ts:312` | the move from the fixed list |
| board | `blocked` | `operation_failed_before_gate` | `lib/pcb-next.ts:314` | `explain` |
| board | `stuck` | `engine_search_exhausted` | `lib/pcb-next.ts:334` | `explain` |
| board | `needs_diagnosis` | `candidate_connectivity_open` | `lib/pcb-next.ts:336` | `routing diagnose` |
| board | `blocked` | `gate_finding` and the rule code | `lib/pcb-next.ts:339` | `explain` |
| board | `blocked` | `operation_failed` | `lib/pcb-next.ts:341` | `explain` |
| board | `review` | `frozen_candidate_needs_named_defect` | `lib/pcb-next.ts:344` | `explain` |
| board | `review` | `candidate_not_adopted` | `lib/pcb-next.ts:345` | `adopt` |
| board | `needs_review` | `assembly_readiness_unverified` | `lib/pcb-next.ts:347` | `readiness` |
| board | `needs_release` | `release_evidence_missing` | `lib/pcb-next.ts:348` | `release` |
| board | `review` | `next_stage_unverified` | `lib/pcb-next.ts:349` | `context` |

## D. Implicit states, the loss, and the smallest enforcement

The list is sorted by the possible loss. The task numbers are the findings of CIP task #1555.
Finding 1 (frozen board) is skipped on purpose: the lab removed `FOCUS.md`, so no board can be frozen.
Findings 3, 4, 6, 7, 10, 11 and 12 are fixed in the code and are not listed.

| No. | Implicit state | Loss it can cause | Smallest enforcement |
|---|---|---|---|
| D1 | B15 Person approval | An agent that is not Claude Code approves its own plan (`--by NAME` takes any text). Place and route then run on a plan that no person saw. The same holds for `seal --accept` and `constraints --add`. (#1555 finding 2) | `pcb layout` prints a one-time code in the terminal of the person. `--approve` needs that code. Use the same code for `seal --accept`. |
| D2 | B16 Gate configuration and check data files | The stage is set to G3, or the `rf` key is removed. The gate passes with fewer checks. No record says who changed it. (#1555 finding 5) | Add `gate.json` and the check data files to the seal and the hook. Let the stage go up only, with a reason in the seal log. |
| D3 | A22 Release approval G5 and A24 Order | A person orders boards without a recorded approval. Nobody can show what the person saw. The manifest always says `g5_ready: false`. | Add a release approval record, like the layout approval: name, reason, hash of the release manifest. `readiness` checks it. |
| D4 | A6 Stackup (planned, #1554) | The layer count and the layer roles are chosen by habit. A wrong choice shows only after fabrication, as a wrong impedance or as false plane gaps. | Add the stage of #1554: a data file with layers and roles. The layout plan and the route plan must agree with it. |
| D5 | B17 Route environment settings | Two runs with the same recorded inputs give different routes. A trial cannot be repeated. (#1555 finding 8) | Remove these keys in `workEnvironment`. Take features only from `gate.json` `route_features` or the route plan. |
| D7 | B18 Route dispatch fallback | An error after the daemon took the job matches the rule. A local route runs while the daemon job also runs. Two results exist. (#1555 finding 9) | The client uses a distinct exit code only when it proved that nothing was sent. The dispatch matches only that code. |
| D9 | A13 RF route order | RF nets route after other nets and lose their clear paths. The gate finds the loss late. | A check in the layout plan approval: the first route stage holds all nets of `rf-lines.json`. |
| D10 | B14 Frozen board (skipped on purpose) | `pcb adopt` overwrites a frozen board with no baseline run. No board can be frozen now. (#1555 finding 1) | A `frozen` field in the registry with a reason. Fail closed when `FOCUS.md` has a Frozen heading that the registry does not list. |

Top four by possible loss: D1, D2, D3, D4.

## E. Count of states

The counts are for the rows of sections A and B.

| Status | Section A | Section B | Total |
|---|---|---|---|
| `enforced` | 16 | 9 | 25 |
| `recorded` | 6 | 4 | 10 |
| `implicit` | 3 | 5 | 8 |
| Total | 25 | 18 | 43 |

## F. How the diagram is made

The DOT file and the SVG file come from one node list. Graphviz was not on the machine when they were made.
The SVG was written by a script. If Graphviz is present, you can render the DOT file again:

```sh
dot -Tsvg tools/PCB-STATE-MACHINE.dot -o tools/PCB-STATE-MACHINE.svg
```

The diagram shows all states A1 to A25 and the states B1, B3, B4, B14, B15, B16, B17 and B18.
The other B states are in the tables only.

Colors: green is `enforced`, amber is `recorded`, red is `implicit`.
A dashed edge is a failure path or a loop. A double border is a gate where a person decides.
