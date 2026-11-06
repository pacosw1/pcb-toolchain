# Benchmark and compare (`tools/pcb bench`)

Decides whether a placer or router change is better, with paired statistics, instead of one-board n=15 counts.
It runs nothing special: every trial is an ordinary `pcb` run (daemon job, owned supervisor, durable run record),
the sealed runs go to `placement_outcomes.ts` for native acceptance and equal-control checks, and `bench` adds the
statistics and the comparison. It never edits canonical CAD and never qualifies a design.

```sh
tools/pcb bench plan SUITE.json
tools/pcb bench run SUITE.json --out DIR [--runs-dir DIR] [--no-analyze]
tools/pcb bench analyze DIR
tools/pcb bench compare DIR_A/result.json DIR_B/result.json [--arm-a ID] [--arm-b ID]
```

## Suite (`iot-lab.bench-suite.v1`)

```json
{"schema": "iot-lab.bench-suite.v1", "suite_id": "placer-edge",
 "arms": [{"id": "base", "argv": ["tools/pcb", "route", "{board}", "--router", "iotroute", "--spec", "policies/{board}-base.json", "--timeout", "{timeout_s}", "--json"]},
          {"id": "edge", "argv": ["tools/pcb", "route", "{board}", "--router", "iotroute", "--spec", "policies/{board}-edge.json", "--timeout", "{timeout_s}", "--json"],
           "toolchain_sha256": "<bundle sha, optional>"}],
 "boards": [{"family": "env", "board": "ENV-SENSE", "split": "development", "input": {"path": "hardware-design/boards/ENV-SENSE/cad/ENV-SENSE/ENV-SENSE.kicad_pcb", "sha256": "..."}},
            {"family": "relay", "board": "RELAY-4", "split": "holdout", "input": {"path": "...", "sha256": "..."}}],
 "seeds": [1, 2, 3, 4, 5, 6, 7, 8], "budget": {"timeout_s": 240, "cpus": 2, "memory_gb": 4}}
```

- Exactly two arms: the first is the baseline, the second the proposal. Positive differences favor the proposal.
- `"metric"`: `"gate"` (default, the full configured gate passed) or `"native"` (native DRC errors, unconnected and parity all 0). The other one is reported as `secondary`.
- `"treatment"`: `"placement"` (default: routing held fixed; arms must route with identical tools and specs) or `"router"` (the router build or route spec is what is compared; the evaluator's `unequal_case_or_execution` blocker is then expected, tolerated and counted as `tolerated_blockers`). Give each arm its own router build with `"env": {"BENCH_TOOLCHAIN": DIR}`.
- Placeholders in `argv`: `{board} {seed} {timeout_s} {cpus} {memory_gb} {input}`. Unknown ones are refused.
- An arm gives either one `argv` or ordered `steps` (see Chained arms).
- Both a development and a holdout board are required; a family cannot be in both. Input hashes are checked against the files before anything runs.
- The same seeds run for both arms, interleaved per pair. Trials run one at a time (they share the machine); a finished trial's record in `DIR/trials/` is kept, so rerunning `run` resumes.
- Each arm's argv (or last step) must end in a `--json` pcb run that prints its `run_id`; the sealed result is read from `PCB_RUNS_DIR` (default `.gate/cli`).

## Chained arms (`steps`)

A placer arm needs a chain: placer, then the placement applied as a candidate run, then a route that continues from it.
Give the arm `steps` instead of `argv`: each step is its own argv, run in order in the project.

```json
{"id": "placer", "steps": [
  ["tools/placer/iotplace", "run", "{board}", "--seed", "{seed}", "--out", "{work}/placement.json"],
  ["tools/pcb", "edit", "{board}", "--kind", "place", "--spec", "{work}/placement.json", "--json"],
  ["tools/pcb", "route", "{board}", "--router", "iotroute", "--from-run", "{prev_run}", "--timeout", "{timeout_s}", "--json"]]}
```

- Besides the suite placeholders, steps may use `{work}` (a scratch folder per trial, `DIR/work/<trial>`), and from the second step on
  `{prev_run}` (run id) and `{prev_run_path}` (run folder) of the latest earlier step that sealed a run.
- Only the last step must seal a run. Earlier steps need to print a `--json` `run_id` only if a later step uses `{prev_run}`;
  a step that fails (or cannot supply `{prev_run}`) makes the trial a failure with no sealed run.
- The whole trial shares one deadline, `budget.timeout_s`, placer time included.
- The trial record stores the final sealed run, its `parent_run` `{path, sha256}` (the latest earlier sealed run) and a per-trial
  `placement_input` `{path, sha256}`: that parent's candidate file in its workspace. `analyze` writes both into the study, and the
  evaluator checks `placement_input` against the sealed parent's candidate bytes (a mismatch is a blocker). Single-`argv` arms keep
  the board's pinned input and have no parent.
- Arms must be comparable: put the baseline's chain in the same shape if it also places; the evaluator checks equal controls.

## What the result says

`DIR/result.json` is sealed (its `result_sha256` covers the rest). Per trial: verified or not (`full_gate_success`: DRC 0,
unconnected 0, parity 0, fresh configured gate), seconds, length and vias for verified trials. A trial with no sealed run
(no start, deadline) counts as a failure, never as an omission. Paired analysis, overall and per split and case:

- verified rate per arm with a Wilson 95% interval
- paired difference with a bootstrap 95% interval (fixed seed, so reruns agree) and the exact sign test on the discordant pairs
- verdict `better`, `worse` or `inconclusive`, and for inconclusive results about how many pairs would settle it at the observed effect
- median paired difference of seconds, length and vias over pairs verified on both sides

`evidence_complete` is false when the evaluator reports blockers or any outcome is unknown; read the verdicts as provisional then.
Exit 0 means complete evidence, 1 incomplete.

`compare A B` takes two sealed results and pairs one arm of each over the same cases and seeds. It refuses results that fail
their own hash, or that come from different suite files (boards, input hashes, seeds, budget, arm commands) or budgets.

# Agent trial (`tools/pcb trial`)

`pcb bench` compares two tool variants. `pcb trial` measures one coding agent that works a frozen board with many `pcb` commands. It records
wall time, tokens, tool calls, the `pcb` runs, the CAD seal, interventions, files changed outside our tools, and a verdict. Three commands:

```sh
tools/pcb trial prepare CASE.json --lab LAB_DIR --out DIR [--bin TOOLCHAIN_BIN_DIR] [--json]
tools/pcb trial run DIR [--wait] [--no-lock] [--json]
tools/pcb trial collect DIR [--json]        # exit 0 for verdict passed, 1 for failed
```

**The lab path is a flag.** `--lab` names any checkout of the lab; it is read only through `git ls-tree` and `git archive` at the commit of
the case, never changed. The lab is not at a fixed place (`~/Documents/iot-lab` does not exist on every Mac), so no path is built in.
`--bin` copies the `iotroute-*` and `iotplace-*` binaries of an installed toolchain into `DIR/project/bin`; `run` then sets `IOTROUTE_BIN`.

## Case (`iot-lab.agent-case.v1`)

```json
{
  "schema": "iot-lab.agent-case.v1",
  "case_id": "env-sense-baseline",
  "board": "ENV-SENSE",
  "lab": { "commit": "27660119" },
  "inputs": [{ "path": "hardware-design/boards/ENV-SENSE/cad/ENV-SENSE/ENV-SENSE.kicad_pcb", "sha256": "<64 hex>" }],
  "prompt": { "path": "prompt.md", "sha256": "<64 hex>" },
  "agent": {
    "argv": ["claude", "-p", "--output-format", "stream-json", "--verbose", "--max-turns", "{max_turns}", "--permission-mode", "acceptEdits", "@{prompt_file}"],
    "parser": "claude-stream-json",
    "env": { "REMOTE_NO_DAEMON": "1", "JOBD_URL": "" }
  },
  "budget": { "timeout_s": 1800, "max_turns": 60 },
  "design_contract_exempt": true
}
```

- `inputs` are paths relative to the lab. They must include the `.kicad_pcb` of the board. `prepare` checks every hash against the extracted file.
- `prompt.path` is relative to the case file. `prepare` checks its hash and copies it to `DIR/prompt.txt`.
- argv placeholders: `{prompt_file}`, `{root}` (the scratch project), `{board}`, `{max_turns}`, `{timeout_s}`. An unknown placeholder is refused.
  `{max_turns}` needs `budget.max_turns`. `agent.env` cannot set `IOT_LAB` or `PCB_RUNS_DIR`; the trial sets both.
- `parser`: `claude-stream-json` or `codex-jsonl`. The codex parser follows the documented `codex exec --json` events and is not yet checked against a recorded run.
- `design_contract_exempt: true` writes `design_contract_exempt: {reason: "agent trial baseline"}` into the scratch registry row of the board.
  The lab is not changed. The result records `design_contract_exempt_applied`. Without it, a board with no design contract fails with `design_contract_missing`.

## What `prepare` does

It builds `DIR/project` with `git archive` of the lab commit: the board folder, the small shared registry files (`boards.json`, `components.json`,
`courtyard-bodies.json`, `ibis`, `part-reviews`, `reviews`, `design-contracts`), and `blocks`. Then it archives, until nothing new is named, every gate
input that exists in the lab commit (the `cad-assets/Cnnn` folders the board uses, datasheets and IBIS files that the rule files and driver tables name).
Gate inputs that the lab commit does not hold are listed in `prepare.json` as `missing_gate_inputs`, not hidden. It copies `tools/` of this
toolchain checkout (no `node_modules`, no `target`, no `toolchain.lock`), writes `.claude/settings.json` with the CAD guard hook, makes the first
seal (writer `trial-prepare`, reason `trial baseline`), and records `DIR/prepare.json` with the case hash, lab commit, toolchain git sha and the hash of every
file under `hardware-design/`. `prepare.json` holds no time, so the same case, lab and toolchain give the same file. A failed `prepare` removes the half-built project.

## What `run` does

It starts the agent argv in `DIR/project` with `IOT_LAB` and `PCB_RUNS_DIR=DIR/project/.gate/cli`, no stdin, and saves the streams to `DIR/agent.stdout.jsonl` and
`DIR/agent.stderr.log`. One deadline, `budget.timeout_s`: SIGINT, then SIGKILL after 60 s. It holds the benchmark lock (`BENCH_LOCK`, see `bench-local.md`)
and writes `DIR/run.json` (wall seconds, exit code, signal, `timed_out`, timestamps). A DIR runs once.

## The result (`iot-lab.agent-trial.v1`)

`DIR/result.json` is sealed: `result_sha256` covers the rest, as in a bench result.

| Field | Source |
|---|---|
| `wall_s`, `exit_code`, `signal`, `timed_out` | `run.json` |
| `agent.tokens_in`, `tokens_out`, `cost_usd`, `turns`, `tool_calls`, `tool_calls_failed`, `tokens_known` | The agent stream. A value the parser cannot find is `null`, never 0, and `tokens_known` is false. `tokens_in` counts input, cache-creation and cache-read tokens. |
| `pcb_runs` | The runs under `project/.gate/cli`: count, count by status, failed, blocked and error checks, cache hits, and the `summarize` output of `pcb benchmark`. A run folder with no result counts as `no_receipt`. |
| `seal` | `writes_by_tool` and `accepted_edits` (`seal-accept`) from the seal log after the baseline line; `violations` is the seal status if the CAD differs from the seal at collect time, else `null`. |
| `interventions` | `notes.jsonl` entries of kind `intervention` and `rework` across the runs. |
| `outside_tools` | Files under `hardware-design/` that changed, were added or were removed since `prepare`, minus the sealed CAD files that the seal accounts for. Listed by path. |
| `verdict`, `cause`, `detail`, `final_run` | `passed` only when the newest sealed `check` run verifies (`verify`), its inputs are fresh (`verifyCurrentInputs`) and the full configured gate passed. Otherwise `failed`. |

Causes, in the order they are checked: `agent_not_started`, `timeout`, `design_contract_missing`, `no_sealed_run`, `evidence_invalid`, `gate_failed`, `stale_inputs`.
A candidate run (`edit`, `route`, `repair`) does not decide: only a `check` run of the canonical board does. Files that a gate or release step writes
under `hardware-design/` also show in `outside_tools`; read the list before you blame the agent.
