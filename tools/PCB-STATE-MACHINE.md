# PCB state machine

This file maps the state machine of one board, from the first idea to the assembled board.
It lists each state, the check that lets a board enter it, and the tool that enforces it.
It also lists the states that no tool enforces. The diagram is in
[PCB-STATE-MACHINE.svg](PCB-STATE-MACHINE.svg). Its source is
[PCB-STATE-MACHINE.dot](PCB-STATE-MACHINE.dot).

This file maps what exists. It adds no new rule and no new state.
Section J is a proposal only: the code does not have it.
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
| A4 Schematic | A3 passed for a board with a contract. The CAD seal is intact. | `.kicad_sch`, `.kicad_pro`, schematic contract manifest. | Sealed schematic. ERC result. `schematic_sha256`. | A5. [ERC errors fail the gate at G3; `cad_changed`; the layout approval becomes stale] | `lib/gate-core.mjs:51-54` (G3 needs `erc`). `lib/cad-seal.ts:15`, `:52-71`. `lib/pcb-check-start.ts:44`. `lib/pcb-next.ts:259-260`. The `schematic` passthrough has no stage check (`DESIGN-CONTRACT.md:159-160`). | `enforced` |
| A5 BOM | `BOM-VERIFIED.csv` and its scope file exist. | `BOM-VERIFIED.csv`, `BOM-VERIFIED.scope.json`, registry BOM owner. | Coverage findings. Verified BOM. | A6. [`missing_context_source` (file absent); coverage finding in `check-packets` and `check-consistency`] | `lib/pcb-workflow.ts:18`, `:198`. `lib/pcb-next.ts:257`. `lib/board-packets.mjs:9`. `lib/bom-ownership.mjs` (`revisionBoms`). The lab runs the coverage check, not `pcb next`. | `recorded` |
| A6 Stackup (planned, #1554) | None. No step asks for a layer count or layer roles. | None today. Plan: RF nets, fast pairs, current, pin density, net count. | None today. Plan: layer data file and stack image. | A7. [none] | None. `set_stackup.ts:1-12` writes a stackup into the board, but no stage requires it. `kicad_happy_gate.ts:171` fails only a missing return dielectric. | `implicit` (planned) |
| A7 Layout plan written | The CAD seal is intact. Rules and route plan files exist. | Intents (`id`, `statement`, `rule_ids`), `route_plan` path, `placement-constraints.json`. | `layout-plan.json` with `approval: null`. | A8. [state `invalid` with the problem list; `missing`] | `lib/layout-plan.ts:53-111` (inspect), `:118-136` (status). `pcb-layout.ts:44`. | `enforced` |
| A8 Layout plan approved (person gate) | A valid plan. An intact seal. The route plan matches the board nets. | Name, reason, image the person saw (PNG or SVG in the project). | `approval` with hashes of rules, route plan, schematic and image. Copy of the image. | A9. [`layout_plan_stale` when rules, route plan, schematic or image change: go to A7 or A8; `layout_plan_missing`] | `lib/layout-plan.ts:129-135`, `:139-149`, `:174-193`. `lib/pcb-candidate-screens.ts:76-83`. `pcb-place.ts:105-109`. `lib/pcb-next.ts:261-266`. Bypass: exemption (B1). The person check is in a hook only (D1). | `enforced` |
| A9 Placement seeds | `admitPlace`: seal intact and plan approved. | Board, `--seeds N`, placement rules. | One spec file per seed `.gate/place/BOARD-seedN.json`. A table with legality, misses and estimates. | A10. [`NO LEGAL CANDIDATE`, exit 3: go to A7] | `pcb-place.ts:41`, `:80-90`, `:92-101`, `:105-109`. `lib/placement-rules.ts:37`. | `enforced` |
| A10 Placement seed choice | None. | The table and the spec files. | The spec file that a person or an agent passes to `edit --kind place`. | A11. [none] | None. The next call of `pcb place` overwrites the specs (`pcb-place.ts:86`). The place edit does not check that its spec came from the table. | `implicit` |
| A11 Place edit (candidate run) | Design stage `schematic`. Approved plan. Seal intact. The action is admitted. | Spec `{"place": {...}}`, optional part review. | Isolated candidate. `operation/source.json`. `images/top.svg` and `images/bottom.svg`. | A18 gate, then A19 adopt. [`engineering_preflight`; `candidate_place_check`; failed gate: go to A9 or A10] | `lib/pcb-candidate-run.ts:351-362` (order), `:205-240`. `lib/pcb-action.ts:29-33`. `lib/stage-contracts.ts:14`. `pcb-check-finalize.ts:107-108`. | `enforced` |
| A12 Board placed check (before route) | Placement rules fail on the board. | Board, `placement-constraints.json`. | Report `placement-rules-preflight.json`. | A13. [`board_unplaced` and state `needs_place`: go to A9] | `lib/pcb-candidate-run.ts:105-130`. `lib/pcb-next.ts:268-269`. A waiting candidate comes first: `next` names the adoption. | `enforced` |
| A13 RF route | The board is placed. `rf-lines.json` and the `rf` gate check exist. | Route plan stage for RF nets, `rf-lines.json` (width, gap, reference, length). | RF copper in a candidate. `rf` check result. | A14. [`rf_failures` fail the gate: go to A14 or A11] | `rf_lines.ts:1-20`. `lib/gate-core.mjs:38` (`rf` is optional, `:53` does not require it). `lib/route-plan-schema.ts:101-110` (stage names only). The rule "RF first" is the order of the stage list: no tool checks it. | `recorded` |
| A14 Staged route | Approved plan. Placed board. Route not repeated. Design stage `placement`. | `route.json` stages, or a policy, or an explicit spec. | Routed candidate. Or `operation/stuck.json`. | A18 gate. [stuck: A15; failed run: A18 finding] | `lib/pcb-check-start.ts:66`. `lib/route-repeat.ts:22-39`. `lib/pcb-candidate-screens.ts:76-83`. `lib/pcb-candidate-run.ts:105-130`, `:156`, `:178`, `:286-341`. `lib/pcb-action.ts:32`. | `enforced` |
| A15 Route stuck and decision | The last route of the board ended stuck. | `stuck.json`, reviewed rules, a recorded move. | A route decision (`reroute_stuck`, `change_setting`, `move_part`, `move_cluster`, `swap_pins`, `widen_region`, `ask_user`). | A14 with new inputs, A16, or A11. [a rerun with the same inputs stops] | `lib/route-repeat.ts:22-39`. `lib/route-moves.ts:21`, `:61`, `:185`. `lib/route-stuck.ts:10`, `:41`. `lib/pcb-next.ts:306-312`. | `enforced` |
| A16 Diagnose and repair | Native evidence supports one bounded repair. | Diagnosis, repair plan, optional `--from-run`. | Repair candidate with images. | A18 gate. [`repair guard` failure; state `needs_diagnosis`] | `lib/pcb-candidate-run.ts:132-138`. `lib/pcb-next.ts:294-298`, `:336`. `lib/pcb-candidate-screens.ts:76-83`. | `enforced` |
| A17 Finishing edits (stitching, silk, test points, courtyards) | The seal is intact. | Routed board, options such as `--skip`, `--via`, `--through-pours`. | Edited board. Seal log line. Stitch report with the options. | A18. [a failed net names `FAILED` and exits 1; `NOROOM` nets are listed] | `stitch_all.ts:34`, `:69`. `lib/cad-seal.ts:157-169` (`sealedWrite`). `lib/pcbtool-write.ts:187`, `:447`. No stage and no run record. | `recorded` |
| A18 Gate (G3, G4, G5) | The seal is intact. The checks of `gate.json` are valid. | Board CAD, `gate.json`, check data files. | `gate/result.json`, `findings.json`, ERC and DRC reports with hashes. | A19, A20 or A21. [`gate_finding`; `operation_failed`; `evidence_not_current`] | `lib/gate-core.mjs:35-39`, `:47-58`. `lib/pcb-candidate-run.ts:244-258`. `lib/pcb-next.ts:316-319`, `:329-341`. The gate configuration is not sealed (D2). | `enforced` |
| A19 Adopt | A passed, settled candidate from this checkout. Seal intact. | Candidate run, `--baseline` and `--defect` for a frozen board. | Canonical PCB replaced. Backup. `adoption.json`. New seal. | A12 or A21. [refuse: stale inputs, changed identity, no defect; interrupted adoption keeps a journal] | `lib/pcb-candidate.ts:151-165`, `:195-213`, `:215-255`, `:257-270`. `lib/pcb-next.ts:344-345`. It does not read the stage contract (D6). | `enforced` |
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
Findings 3, 4, 6, 7 and 11 are fixed in the code and are not listed.

| No. | Implicit state | Loss it can cause | Smallest enforcement |
|---|---|---|---|
| D1 | B15 Person approval | An agent that is not Claude Code approves its own plan (`--by NAME` takes any text). Place and route then run on a plan that no person saw. The same holds for `seal --accept` and `constraints --add`. (#1555 finding 2) | `pcb layout` prints a one-time code in the terminal of the person. `--approve` needs that code. Use the same code for `seal --accept`. |
| D2 | B16 Gate configuration and check data files | The stage is set to G3, or the `rf` key is removed. The gate passes with fewer checks. No record says who changed it. (#1555 finding 5) | Add `gate.json` and the check data files to the seal and the hook. Let the stage go up only, with a reason in the seal log. |
| D3 | A22 Release approval G5 and A24 Order | A person orders boards without a recorded approval. Nobody can show what the person saw. The manifest always says `g5_ready: false`. | Add a release approval record, like the layout approval: name, reason, hash of the release manifest. `readiness` checks it. |
| D4 | A6 Stackup (planned, #1554) | The layer count and the layer roles are chosen by habit. A wrong choice shows only after fabrication, as a wrong impedance or as false plane gaps. | Add the stage of #1554: a data file with layers and roles. The layout plan and the route plan must agree with it. |
| D5 | B17 Route environment settings | Two runs with the same recorded inputs give different routes. A trial cannot be repeated. (#1555 finding 8) | Remove these keys in `workEnvironment`. Take features only from `gate.json` `route_features` or the route plan. |
| D6 | Adopt and `next` skip the stage contract | A run sealed by an older toolchain, with no images, can be adopted. `next` shows no image path to the person. (#1555 finding 10) | Call `contractProblem` in `checkAdoptable` and in the candidate branch of `next`. Print the image paths in `next`. |
| D7 | B18 Route dispatch fallback | An error after the daemon took the job matches the rule. A local route runs while the daemon job also runs. Two results exist. (#1555 finding 9) | The client uses a distinct exit code only when it proved that nothing was sent. The dispatch matches only that code. |
| D8 | A10 Placement seed choice | The reason for the chosen seed and the rejected seeds is lost. A new call replaces the specs. (#1555 finding 12) | Write `.gate/place/BOARD-candidates.json` with the table and the spec hashes. The place edit records whether its spec hash is in the table. |
| D9 | A13 RF route order | RF nets route after other nets and lose their clear paths. The gate finds the loss late. | A check in the layout plan approval: the first route stage holds all nets of `rf-lines.json`. |
| D10 | B14 Frozen board (skipped on purpose) | `pcb adopt` overwrites a frozen board with no baseline run. No board can be frozen now. (#1555 finding 1) | A `frozen` field in the registry with a reason. Fail closed when `FOCUS.md` has a Frozen heading that the registry does not list. |

Top five by possible loss: D1, D2, D3, D4, D6.

## E. Count of states

The counts are for the rows of sections A and B.

| Status | Section A | Section B | Total |
|---|---|---|---|
| `enforced` | 15 | 9 | 24 |
| `recorded` | 6 | 4 | 10 |
| `implicit` | 4 | 5 | 9 |
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

## G. Backward transitions

A backward transition is a return to an earlier state, after a change or a failure.
The code has no such transition as a named thing. It has hashes that go stale.
A stale hash stops one command. No table says what else must be redone.

### G.1 Marks

| Mark | Meaning |
|---|---|
| `stops` | A tool refuses the next affected command. All evidence that the change makes false goes stale. |
| `partial` | A tool stops some paths. Other evidence, an approval, or a data file stays valid and should not. Or the stop comes late. |
| `silent` | No tool stops the process and no tool records the change. |

Count: 8 `stops`, 10 `partial`, 2 `silent`, of 20 change kinds.

### G.2 Facts that apply to all rows

| No. | Fact | Proof |
|---|---|---|
| X1 | `pcb next` on a board with a design contract shows only the design assessment. It returns before it reads the seal, the layout plan, the runs, the stock or the release. A board with no contract must be exempt, or it stops at `design_contract_missing`. So the board path of section C runs only for exempt boards. A normal board finds a stale approval when a command fails. | `lib/pcb-next.ts:224-228`, `:241`. `lib/pcb-next.test.ts:73-74`. The board path tests use an exempt fixture (`:20`). |
| X2 | The layout approval binds four hashes: placement rules, route plan, schematic, image. It does not bind `.kicad_pcb` or `.kicad_dru`. A change of stackup, outline or design rule leaves the approval valid. The image then shows an old board. | `lib/layout-plan.ts:186`. |
| X3 | A sealed tool write has no reason. The seal moves with the write. Only `seal --accept` has a reason, and the reason goes to a local log that is not committed. | `lib/cad-seal.ts:29`, `:81`, `:165`, `:134`. |
| X4 | No tool puts a schematic change into the board. A candidate cannot change a part, a pad, a net, the outline or a rule. A person does this in KiCad. | `lib/pcb-identity.ts:1`. `lib/pcb-candidate-run.ts:328`. |
| X5 | The source state of a candidate holds all of `tools/`. Any file change there, also a document, makes each candidate stale. This fails closed. The cost is a repeated run, not a wrong board. | `lib/pcb-sources.ts:60`, `:37`. `lib/pcb-candidate.ts:219`, `:228`. |
| X6 | A stale code says what stopped. It does not say the reason of the change or the earliest state to re-enter. | Section C. `lib/pcb-next.ts:264`, `:354`. |

### G.3 Table of change kinds

"Today" holds the proof. "Should" holds the change that the process needs.
The next four columns are the required result: the earliest state, the invalid states, the evidence that survives, and who approves again.
"Person" means a person who is not the agent that made the change. Today only a hook enforces this (D1).

| No. | Change | Today | Should | Re-enter | Invalid | Survives | Approve again | Mark |
|---|---|---|---|---|---|---|---|---|
| T1 | Part swapped, pin compatible, same footprint | The person edits in KiCad (X4). The seal stops all CAD commands (`lib/cad-seal.ts:65-71`). `seal --accept` passes it. The approval goes stale (`lib/layout-plan.ts:132`). The part review fails only if a run binds the manifest or a contract check reads it (`lib/part-review.ts:293`, `lib/pcb-candidate-run.ts:86`). The BOM and the ledger stale shows only at readiness (`lib/board-selections.mjs:58-59`, `lib/release-readiness.mjs:97`). | Name the swap. Ask for part review and BOM before the layout approval. Show the copper as kept. | A3 | A3 report, A5, A8, A18, A21, A23 | A9 to A17 copper and placement, A7 rules, route plan | Person: part review and layout approval | `partial` |
| T2 | Part swapped, not pin compatible, or other footprint | As T1. The candidate refuses the change (`lib/pcb-candidate-run.ts:328`). A gate parity defect stops an old board (`gate.mjs:173`, `:260`). Placement rules for that reference stay valid: their source hash does not change (`lib/engineering-constraints.ts:107`). The route plan is compared to the nets only at approval (`lib/layout-plan.ts:96`). | Mark each rule, rigid group and route stage that names the reference. Ask for a review of each one. | A3 | A3 to A5, A7 rows for the part, A8 to A23 | Requirements, parts not touched, rules for other parts | Person: part review, layout approval | `partial` |
| T3 | Part value changed | As T1 for seal and approval. The native identity compares `mpn`, `lcsc`, `footprint` and `dnp`, not the value (`lib/part-native.ts:266-267`). A value change with the same `mpn` and `lcsc` passes the part review. The only remaining check is KiCad parity. This audit did not test if parity reports a value change. | Compare the value with the BOM row and the review. Ask for a new `lcsc` when the value changes. | A3 | A3 row of the part, A5, A8, A18, A21, A23 | All layout | Person: part review. Layout approval only for a re-approval of the hash. | `partial` |
| T4 | Schematic net change | The seal stops a hand edit (`lib/cad-seal.ts:65-71`). A sealed tool has no seal stop (`add_testpoints.ts:134`), but the approval goes stale (`lib/layout-plan.ts:132`). The gate fails on parity (`gate.mjs:260`). Adopt refuses an old candidate (`lib/pcb-candidate.ts:228`). | Keep the stops. Show the net names that changed and the route stages that use them. | A4 | A4 ERC, A7 route plan for the net, A8 to A23 | A3, A5 if no part changed, placement | Person: layout approval | `stops` |
| T5 | New datasheet revision or new part-record fact | A changed file at the same path gives `stale_source` (`lib/part-review.ts:185`). A changed profile gives `stale_profile_review` (`:261`). A contract source stops (`lib/design-contract-load.ts:38`). A new file beside the old one changes no hash. No manifest bound: no stop (`lib/pcb-candidate-run.ts:86`). `registry/datasheets` is not in the source state, except for exact gate dependencies (`lib/pcb-sources.ts:14`, `:37`). | Record the new source as an event. Point the manifest at the new file. Show each board that uses the part. | A3 | A3 report of each board that uses the part. A4 to A23 only if the fact changes the use. | All else, if the review says the use holds | Person: part review | `partial` |
| T6 | Supplier out of stock | `parts stock` stops on a missing or ambiguous code (`lib/part-stock.ts:182`). Readiness blocks (`lib/release-readiness.mjs:118`). This is at the end of the process. No path goes back to A3. The control `substitutions` is only a contract field (`lib/design-contract-load.ts:19`). The stock day code is on the exempt path only (X1). | Name the part and the state to re-enter. Then treat the swap as T1 or T2. | A3 | A23 now. T1 or T2 list after the swap. | All, until a swap is chosen | Person: choice of substitute | `partial` |
| T7 | Stackup change | `set_stackup.ts:134` writes with a sealed write: no stop and no reason (X3). The approval stays valid (X2). The gate goes stale. A new gate can pass, because `h_mm` and `er` in `rf-lines.json` are hand data and the check does not compare them with the board (`lib/rf-lines.ts:42`, `:70`). | Bind the stackup in the approval (D4). Compare `h_mm` and `er` with the board. | A6 | A7 route plan, A8, A13, A14 for controlled nets, A18 to A23 | A3 to A5, placement if the layer count is the same | Person: layout approval | `partial` |
| T8 | Board outline change | The candidate refuses it (`lib/pcb-identity.ts:1`). A person edits in KiCad, and the seal stops it. After `seal --accept` the approval stays valid (X2) and the image is old. The gate goes stale. Placement rules run again at the gate. `MECHANICAL.md` is only checked for presence (`lib/board-packets.mjs:9`). | Bind the outline in the approval. | A7 | A8 to A23 | A1 to A5, schematic | Person: layout approval | `partial` |
| T9 | A rule added, removed or changed | Placement rule: the seal log has the reason and the approval goes stale (`pcb-constraints.ts:33`, `lib/layout-plan.ts:130`). Reviewed rule: `stale_review` (`lib/part-review.ts:474`). `.kicad_dru`: sealed, the approval stays valid (X2). Check data file: the gate goes stale, with no reason and no approval (`lib/gate-inputs.mjs:96`). `gate.json`: the gate goes stale (`lib/pcb-next.ts:303`), but a lower stage passes the next gate (D2). | One path for all rule files: a reason, then a stale approval. Stage goes up only. | A7 | A8 to A23. A9 to A14 only if the board fails the new rule. | A1 to A5 | Person: layout approval | `partial` |
| T10 | Route plan change | The approval goes stale (`lib/layout-plan.ts:131`). A candidate goes stale if the plan is in the board folder (`lib/pcb-sources.ts:60`). After a new approval, the old copper is not linked to the old plan: the gate judges only the copper. | Keep the stops. Show which stages changed. | A7 | A8, A14 to A23 | A1 to A5, placement | Person: layout approval | `stops` |
| T11 | Layout approval withdrawn | No command exists. A person sets `approval` to null by hand. Only a Claude Code hook asks (`hooks/claude-cad-guard.mjs:25`). No reason is recorded. Place and route stop (`lib/layout-plan.ts:128`). Release does not read the layout gate (`lib/pcb-candidate-screens.ts:77`, `lib/pcb-candidate-run.ts:360`). The gate stale needs only a new `check`. | Add a withdraw command with a reason. Release reads the layout gate. | A8 | A9 to A23 | A1 to A7 | Person: layout approval | `partial` |
| T12 | Route stuck | A route with the same inputs stops (`lib/route-repeat.ts:22-39`). `next` gives one move from the fixed list on the exempt path (`lib/pcb-next.ts:306-312`). `swap_pins` is only a proposal for a person (`lib/route-moves.ts:193`). Its path back to A4 has no name. | Keep the stops. Map `swap_pins` to T4, and `ask_user` to a recorded answer. | A15 | A14 run | All | Agent for a move. Person for `swap_pins` and `ask_user`. | `stops` |
| T13 | Gate failed | Adopt refuses (`lib/pcb-candidate.ts:154`). Release needs a fresh gate. `next` gives `gate_finding` and `explain` on the exempt path (`lib/pcb-next.ts:339`). No map goes from a finding to a state. | Add a map from the check name to the state to re-enter. | The state that made the failed item: A4 for ERC, A9 or A14 for layout | A18 and all after it | All before the failed item | Agent, unless the fix is a rule (T9) | `stops` |
| T14 | DRC failed | As T13. Open nets give `needs_diagnosis` (`lib/pcb-next.ts:336`). A parity defect has no state of its own: it reaches `ask_user` only from a stuck route (`lib/route-moves.ts:62`). | Parity goes to A4. Clearance goes to A9 or A14. Open nets go to A16. | A4, A9, A14 or A16 | A18 and all after it | All before the failed item | Agent, unless parity needs a person | `stops` |
| T15 | Fabrication defect | No record exists. `--defect` on adopt is for a frozen board only (`lib/pcb-candidate.ts:269`), and no board can be frozen (D10). No state follows A24. | Record the defect with the release hash and the serial numbers. Decide reorder or new revision. | A21 for a supplier error. A7, A14 or A4 for a design cause. | The released revision for new orders | Measured data of other boards | Person: decision | `silent` |
| T16 | Bring-up failure | A failed `bench` check blocks the stage `prototype` (`lib/design-contract-verifiers-async.ts:305`), if the contract has that check. Candidates need only stages to `routing` (`lib/pcb-action.ts:29-33`), so nothing stops the next layout. A board with no bench check has no record. | Record the failure with the requirement. Link it to the new revision. Release of that revision needs the cause. | The state of the cause: A1 to A14 | The prototype stage, block level 2 | Requirements not touched, other measured data | Person: cause and decision | `partial` |
| T17 | Toolchain version change | Version probes stop `next`, adopt and release (`pcb_snapshot_inputs.mjs:27`, `:29`). Gate tools are hashed (`lib/gate-inputs.mjs:165`). Routers and placers are not gate inputs (`lib/gate-inputs.mjs:18`), but all of `tools/` is in the candidate source (X5). A part review has `stale_tool` (`lib/part-review.ts:515`). | Keep the stops. Show which tool changed. | A18 | A18 to A23 | All design and copper, until the new gate reports a finding | Nobody, if the gate passes | `stops` |
| T18 | A human edit in KiCad | The seal stops all CAD commands (`lib/cad-seal.ts:65-71`, `lib/pcb-check-start.ts:44`). `seal --accept` needs a reason (`lib/cad-seal.ts:132`), but it does not show what changed. A hook is the only person check (D1). | Keep the stops. Sort the diff into schematic, outline, stackup, rule, placement and copper. Then use the row of that kind. | The row of the kind | The row of the kind | The row of the kind | Person: accept | `stops` |
| T19 | Requirement or spec change | A changed source stops the contract load (`lib/design-contract-load.ts:38`). `next` gives `design_assessment_stale` (`lib/pcb-next.ts:173`, `:218`). A run needs a pass of the earlier stage (`lib/pcb-candidate-screens.ts:63-66`). An exempt board has no such stop. | Keep the stops. | A1 | The stages whose checks name the requirement | Stages with no link to it | Person: review of the assessment | `stops` |
| T20 | CAD changed after an order | No record of the order exists: `ordered` is always false (`check-release-fab.mjs:23`, `lib/release-readiness.mjs:122`). Adopt can replace the board of an ordered revision (D10). Nothing asks for a new revision. | Record the order. After it, adopt refuses until the revision increases. | A7 of the new revision | Nothing of the old revision: it stays as ordered | The old revision files and evidence | Person: new revision | `silent` |

## H. Input and output audit

A row is here only if it has a gap. States not listed have no gap: A1, A11, A12, A16, A20, A21, B2, B3, B5 to B13.
`Defined` means a schema or the table `lib/stage-contracts.ts:13-20` names it. That table has only `place`, `edit`, `route`, `build`, `repair` and `layout`.
`Checked` means a tool stops when it is absent or wrong. `Visible` means a person can open an image or a readable report.

| State | Input defined | Output defined | Checked | Visible | Gap |
|---|---|---|---|---|---|
| A2 Architecture | partial | yes | partial | yes | `architecture` may be null, and the check then returns (`lib/design-contract-load.ts:141-142`). |
| A3 Part selection | yes | yes | partial | partial | A board with no bound manifest passes (`lib/pcb-candidate-run.ts:86`). The report is JSON only. |
| A4 Schematic | partial | partial | partial | no | No schematic image or PDF is made. No person sees the schematic at a gate. |
| A5 BOM | partial | partial | partial | partial | The CSV has no stage check. `next` asks only for the file. |
| A6 Stackup | no | no | no | no | Planned in #1554. |
| A7 Layout plan written | yes | yes | yes | partial | The tool shows the newest run image (`pcb-layout.ts:13-16`). A new board has no run, so it has no image. |
| A8 Layout approval | yes | yes | partial | partial | The image can be any PNG or SVG in the project (`lib/layout-plan.ts:162-171`). No check ties it to this plan. `--by` is free text (D1). |
| A9 Placement seeds | yes | yes | yes | partial | Only a table. Images exist only after a place edit (`lib/pcb-candidate-run.ts:261`). |
| A10 Seed choice | no | no | no | no | D8. |
| A13 RF route | partial | no | partial | no | No RF stage in `STAGE_CONTRACTS`. `rf-lines.json` is not sealed. No image shows the RF copper alone. |
| A14 Staged route, stuck exit | yes | partial | partial | partial | The contract checks a passed run only (`lib/stage-contracts.ts:30`). A stuck run has `stuck.json`, and images are not required. |
| A15 Route decision | yes | partial | yes | partial | The answer to `ask_user` has no field (`lib/route-moves.ts:192`). |
| A17 Finishing edits | no | no | partial | no | No stage, no run record, no image. Only the seal line. |
| A18 Gate | partial | yes | partial | partial | Configuration not sealed (D2). A `check` run has no image (`lib/stage-contracts.ts:25-27`). |
| A19 Adopt | yes | yes | partial | no | Adopt does not read the stage contract (D6). `next` shows no image. |
| A22 Release approval | no | no | no | no | D3. |
| A23 Readiness | yes | yes | partial | yes | No later step reads the report. |
| A24 Order | no | no | no | no | T20. |
| A25 Bring-up | yes | partial | partial | partial | Bench data is not needed before a release. Failure has no link back (T16). |
| B1 Exemption | partial | yes | partial | no | Nothing reads the events. |
| B4 Seal accept | yes | yes | partial | no | The accept shows no diff. The log is local (X3). |
| B14 Frozen board | no | yes | no | no | Text heading in a removed file (D10). |
| B15 Person approval | no | yes | no | no | D1. |
| B16 Gate configuration | partial | no | no | no | D2. |
| B17 Route environment | no | no | no | no | D5. |
| B18 Route fallback | no | no | no | no | D7. |

Count: 26 of 43 states have a gap. 7 of the 26 have no defined input and no defined output: A6, A10, A17, A22, A24, B17, B18.

## I. Missing steps

Each candidate was tested against the code. The list is sorted by possible loss.

| Rank | Step | In the code today | Loss if absent | Real gap? |
|---|---|---|---|---|
| 1 | Order record and revision increment | No. `ordered` is always false. Revisions are registry rows that a person edits. No command makes a new revision. The state between A24 and A25, boards received, also has no record. | Files change after an order. Nobody can say what the boards in hand are. Bring-up data goes to the wrong files. A repeat order can send changed files. | Yes. T20. |
| 2 | Schematic review by a person | Partial. The part review has a reviewer (`lib/part-review.ts:464-475`). A requirement may have an acceptance of kind `review` (`lib/design-contract-load.ts:92`). The layout approval holds the schematic hash, but the person sees a layout image. No schematic image exists (section H, A4). | A wrong circuit passes ERC and all layout gates. The loss is a full board spin. | Yes. |
| 3 | Change record | Partial. The seal log has a reason for an accepted edit only, and it is local (X3). | Nobody can tell why a state went back. A redo list comes from memory. Work is skipped or repeated. | Yes. Section J. |
| 4 | Mechanical fit | Partial. Rules `fixed` and `connector_access`, and `assembly_dependencies`, exist (`lib/part-review.ts:26-27`). `MECHANICAL.md` is checked for presence only. No check compares the outline, the holes or the height with an enclosure. | A board does not fit. The loss is a spin. | Yes, for a board with an enclosure. |
| 5 | Thermal review | Partial. Copper current capacity and thermal spokes are checked (`lib/power-graph.ts:152`). Part ratings are reviewed. No step estimates dissipation or temperature. Thermal in `lib/outcome-thermal.ts` is for the placement study. | A regulator runs hot. This shows at bring-up. | Yes, for a board with power parts. Small for a low power board. |
| 6 | DFM check | Partial. DRC uses `.kicad_dru`. The default kicad-happy rules have no DFM rule (`kicad_happy_gate.ts:45`). The sample data has a `dfm` field and no gate reads it. | The fabricator rejects a file, or the yield is low. The fabricator also runs its own check. The loss is usually a delay. | Small. |
| 7 | Firmware pinout check | No. `lib/schematic-contract.ts:3` says that it does not prove firmware state. No pin map file exists. No code names strapping pins. A pin swap stops at a person (`lib/route-moves.ts:193`). | A signal goes to a pin that the firmware cannot use, or a strapping pin stops the boot. | Small now. It grows if `swap_pins` becomes automatic. |

Tested and not a gap:

| Step | Why it is not a gap |
|---|---|
| Power budget | `lib/part-review.ts:418`, `lib/schematic-contract.ts:423` and `lib/power-graph.ts` check it. A manifest must declare it (`lib/part-review.ts:559`). |
| Test plan | The contract has `test_plans` (`lib/design-contract-load.ts:111-122`). Test access has a check before route (`lib/pcb-candidate-screens.ts:100-106`). |
| Design review before an order | This step is on the map already: A22 and D3. |

## J. Proposal: one explicit transition table

This section is a design. The code does not have it.

### J.1 Rules of the design

1. State still comes from hashes and sealed evidence. The table holds no state.
2. The table says what a change invalidates. The current hash says if the work is done.
3. A change event adds the reason. It never makes evidence valid.
4. With no event, the tool uses the widest row of the changed group. This fails closed.

### J.2 The table

The file is `tools/pcb-transitions.json`, schema `iot-lab.transitions.v1`. It is data, as `route-features.json` is. A new module `lib/transitions.ts` loads and validates it. `pcb next` and a new command `pcb change` read it.

```json
{
  "schema": "iot-lab.transitions.v1",
  "groups": {
    "schematic": ["*.kicad_sch", "*.kicad_pro"],
    "board_shape": ["*.kicad_pcb#outline", "*.kicad_pcb#stackup", "*.kicad_dru"],
    "rules": ["placement-constraints.json", "reference-planes.json", "gate.json"]
  },
  "kinds": [
    {
      "id": "part_swap_same_footprint",
      "group": "schematic",
      "reenter": "A3",
      "redo": ["part_review", "bom", "layout_approval", "gate", "release", "readiness"],
      "keep": ["placement", "copper", "route_plan"],
      "approve": ["part_review", "layout_approval"]
    }
  ]
}
```

- `groups` sorts files. A group has one hash. `#outline` and `#stackup` read that form of the board.
- `kinds` holds one row per line of table G.3.
- The first row of a group is the widest row. `lib/transitions.ts` checks that it redoes all that the other rows of the group redo.
- `redo` names evidence classes. One reader for each class gives `current`, `stale` or `missing`. The readers wrap code that exists: `verifyManifest`, `layoutPlanStatus`, `engineeringInputsCurrent`, `verifyCurrentInputs`, `verifyFab`, `releaseReadiness`.

### J.3 The change event

`pcb change BOARD --kind KIND --reason TEXT --by NAME` appends one line to `hardware-design/boards/BOARD/changes.jsonl`. The file is committed, unlike the seal log.

```json
{"id":"c-0007","at":"2026-11-06T10:00:00Z","by":"NAME","kind":"part_swap_same_footprint","reason":"U3 out of stock","refs":["U3"],"groups":{"schematic":{"before":"...","after":"..."}},"prev_sha256":"..."}
```

- `prev_sha256` is the hash of the line before. A hand edit breaks the chain.
- A kind with no file change, such as `fab_defect`, `bringup_failure`, `out_of_stock`, `approval_withdrawn` or `ordered`, has an empty `groups`.
- The file is not a gate input and not a candidate source, as `cad-seal.json` is not (`lib/gate-inputs.mjs:93`, `lib/pcb-sources.ts:41`).

### J.4 What `pcb next` shows

`next` compares the current hash of each group with `after` of the last event. A difference with no event gives `change_unrecorded` and the widest row. Then `next` calls the reader of each class in `redo`, in order, and it adds one block to the decision:

```text
change: c-0007 part_swap_same_footprint, U3, by NAME: U3 out of stock
re-enter: A3
redo: part_review stale; bom stale; layout_approval stale; gate stale; release missing
keep: placement, copper, route_plan
next: tools/pcb parts ...
```

An item leaves the list when its reader says `current`. Nothing writes a state. The first item that is not current sets the next command.

### J.5 The smallest first step

Do these two items in one change, with no event file:

1. Add the table and `lib/transitions.ts`. Add `redo` to `next` for the codes that exist: `cad_changed`, `layout_plan_stale`, `evidence_not_current`, `design_assessment_stale`.
2. Fix X1: a contract board reaches the seal, layout and run checks of `nextAction`.

Without item 2, a normal board never sees the list.

### J.6 Code changes

| No. | Change | Cost |
|---|---|---|
| 1 | `tools/pcb-transitions.json` with the rows of table G.3. | small |
| 2 | `lib/transitions.ts`: load, validate, pure `redoFor(kind, readers)`. | small |
| 3 | `lib/pcb-next.ts`: a contract board continues to the board checks (X1). | medium |
| 4 | `lib/pcb-next.ts`: add the `change` block to `Decision`. | small |
| 5 | Readers for six evidence classes, each one around an existing function. | medium |
| 6 | `lib/change-log.ts` and `pcb change`: append, hash chain, group hashes. | medium |
| 7 | `lib/gate-inputs.mjs` and `lib/pcb-sources.ts`: leave out `changes.jsonl`. | small |
| 8 | `lib/layout-plan.ts`: add `board_shape_sha256` to the approval (X2). All approvals go stale one time, and a person approves again. | medium |
| 9 | `lib/rf-lines.ts`: compare `h_mm` and `er` with the board stackup (T7). | small |
| 10 | `lib/pcb-candidate-screens.ts:77`: release reads the layout gate (T11). | small |
| 11 | Kind `ordered`. `lib/pcb-candidate.ts` refuses adopt on an ordered revision (T20). | medium |

Not in this proposal: an automatic check of "pin compatible" from a schematic diff. That is a large change. The kind comes from a person, and the gate and the part review test the claim.
