// Agent trial: run one coding agent on a frozen board and write a sealed record of time, tokens, tool calls, pcb runs, CAD seal and verdict.
//   tools/agent-trial.ts prepare CASE.json --lab DIR --out DIR [--bin DIR] [--json]
//   tools/agent-trial.ts run DIR [--wait] [--no-lock] [--json]
//   tools/agent-trial.ts collect DIR [--json]
// The lab is a parameter (--lab): it is read through git only, at the commit of the case. `pcb bench` compares two tool variants; this tool measures one agent.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags, runMain, UsageError } from './lib/cli.ts';
import { collectTrial } from './lib/agent-trial-collect.ts';
import { prepareTrial } from './lib/agent-trial-prepare.ts';
import { runTrial } from './lib/agent-trial-run.ts';
import { acquire, describeOwner } from './lib/bench-lock.ts';
import { verifyCurrentInputs } from './lib/pcb-next.ts';
import { nextReaders } from './lib/pcb-next-readers.ts';

const USAGE = [
  'usage: agent-trial.ts prepare CASE.json --lab DIR --out DIR [--bin DIR] [--json]',
  '       agent-trial.ts run DIR [--wait] [--no-lock] [--json]',
  '       agent-trial.ts collect DIR [--json]',
].join('\n');

const FLAGS = { lab: { type: 'string' }, out: { type: 'string' }, bin: { type: 'string' }, wait: { type: 'boolean' }, 'no-lock': { type: 'boolean' }, json: { type: 'boolean' }, project: { type: 'string' } } as const;
const TOOLCHAIN = resolve(fileURLToPath(new URL('..', import.meta.url)));

async function main(argv: string[]): Promise<number> {
  const parsed = parseFlags(argv, FLAGS, USAGE), values = parsed.values;
  const positionals = parsed.positionals[0] === 'trial' ? parsed.positionals.slice(1) : parsed.positionals;
  const [command, target] = positionals;
  if (!target || positionals.length !== 2) throw new UsageError(USAGE);
  if (command === 'prepare') {
    if (!values.lab || !values.out) throw new UsageError(USAGE);
    const record = prepareTrial({ casePath: target, lab: values.lab, out: values.out, toolchain: TOOLCHAIN, bin: values.bin });
    if (values.json) console.log(JSON.stringify(record));
    else {
      console.log(`prepared ${resolve(values.out)}/project: board ${record.board}, lab commit ${record.lab_commit}, ${Object.keys(record.files).length} files under hardware-design, seal ${record.lab_seal} -> sealed`);
      console.log(`gate inputs the lab commit does not hold: ${record.missing_gate_inputs.length ? record.missing_gate_inputs.join(', ') : 'none'}`);
      console.log(`next: tools/pcb trial run ${resolve(values.out)}`);
    }
    return 0;
  }
  if (command === 'run') {
    const lock = values['no-lock'] ? async () => () => {} : async (label: string) => acquire({ label, wait: values.wait, onWait: owner => console.error(`bench lock held by ${describeOwner(owner)}; waiting`) });
    const record = await runTrial(target, { lock });
    if (values.json) console.log(JSON.stringify(record));
    else console.log(`agent ${record.spawn_error ? `did not start (${record.spawn_error})` : `ended: exit ${record.exit_code}, signal ${record.signal}`}${record.timed_out ? ', deadline reached' : ''}, ${record.wall_s.toFixed(1)} s\nnext: tools/pcb trial collect ${resolve(target)}`);
    return record.spawn_error ? 1 : 0;
  }
  if (command === 'collect') {
    const result = await collectTrial(target, { verifyInputs: (root, board, gateDir) => verifyCurrentInputs(root, board, gateDir, nextReaders.runStage) });
    if (values.json) console.log(JSON.stringify(result));
    else {
      console.log(`${result.case_id} (${result.board}): ${result.verdict}${result.cause ? ` (${result.cause}${result.detail ? `: ${result.detail}` : ''})` : ''}`);
      console.log(`wall ${result.wall_s} s, tokens in ${result.agent.tokens_in ?? 'unknown'}, out ${result.agent.tokens_out ?? 'unknown'}, cost ${result.agent.cost_usd ?? 'unknown'}, tool calls ${result.agent.tool_calls ?? 'unknown'} (${result.agent.tool_calls_failed ?? 'unknown'} failed)`);
      console.log(`pcb runs ${result.pcb_runs.count} ${JSON.stringify(result.pcb_runs.by_status)}, seal writes ${JSON.stringify(result.seal.writes_by_tool)}, seal violations ${result.seal.violations ? 'YES' : 'none'}, interventions ${result.interventions.total}, files outside tools ${result.outside_tools.count}`);
      console.log(`sealed: ${resolve(target)}/result.json sha256 ${result.result_sha256}`);
    }
    return result.verdict === 'passed' ? 0 : 1;
  }
  throw new UsageError(USAGE);
}

runMain(import.meta.url, main);
