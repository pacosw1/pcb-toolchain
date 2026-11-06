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
