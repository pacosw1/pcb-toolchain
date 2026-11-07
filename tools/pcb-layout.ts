// tools/pcb layout BOARD: the status of the layout plan that must be approved before place and route.
import { approveLayoutPlan, layoutGate, layoutPlanStatus } from './lib/layout-plan.ts';
import { parseFlags, runMain, UsageError } from './lib/cli.ts';
import { projectRoot } from './lib/project-root.mjs';
import { jsonDumps } from './lib/py-compat.mjs';

const USAGE = 'usage: pcb [--project DIR] layout BOARD [--json] [--approve --by NAME --reason TEXT]';

async function main(given: string[]): Promise<number> {
  const argv = [...given];
  let explicit: string | undefined;
  if (argv[0] === '--project') { explicit = argv[1]; argv.splice(0, 2); }
  else if (argv[0]?.startsWith('--project=')) { explicit = argv[0].slice(10); argv.shift(); }
  argv.shift();   // the command word
  // --runs-dir is accepted and unused: `pcb next` adds it to the commands that it names when a custom runs dir is set.
  const a = parseFlags(argv, { json: { type: 'boolean' }, approve: { type: 'boolean' }, by: { type: 'string' }, reason: { type: 'string' }, 'runs-dir': { type: 'string' } }, USAGE);
  const [board, ...rest] = a.positionals;
  if (!board || rest.length) throw new UsageError(USAGE);
  const { json, approve, by, reason } = a.values;
  if (approve ? by === undefined || reason === undefined : by !== undefined || reason !== undefined) throw new UsageError(USAGE);
  const root = projectRoot(explicit);
  const status = approve ? await approveLayoutPlan(root, board, by!, reason!) : layoutPlanStatus(root, board);
  const ok = status.state === 'approved' || status.state === 'exempt';
  if (json) console.log(jsonDumps(status));
  else if (!ok) console.log(`FAIL: ${layoutGate(root, board, () => {})!.message}`);
  else console.log(status.state === 'exempt' ? `PASS: ${board} is exempt from the layout plan: ${status.exempt_reason}` : `PASS: ${board} layout plan approved by ${status.approval!.by}`);
  return ok ? 0 : 1;
}
runMain(import.meta.url, main);
