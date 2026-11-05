// Verify declared schematic functions against reviewed facts and native CAD.
//
// This does not run ERC/DRC, simulate a circuit, select parts or prove firmware operating state. Unstated requirements
// and unsupported quantities remain unknown.
//
//   tools/schematic_contract.ts check BOARD --contract FILE [--root ROOT] [--output REPORT] [--json]
// Exit 0 when every declared assertion passed, else 1; 2 on bad usage.
import { parseArgs } from 'node:util';
import { runMain, UsageError } from './lib/cli.ts';
import { atomicJson } from './lib/json-file.ts';
import { sha } from './lib/pcb-workflow.ts';
import { projectRoot } from './lib/project-root.mjs';
import { jsonDumps } from './lib/py-compat.mjs';
import { resolvePath } from './lib/py-path.ts';
import { checkContract } from './lib/schematic-contract.ts';

const USAGE = 'usage: tools/schematic_contract.ts check BOARD --contract FILE [--root ROOT] [--output REPORT] [--json]';
const OPTIONS = { contract: { type: 'string' }, root: { type: 'string' }, output: { type: 'string' }, json: { type: 'boolean' } } as const;

function parseCommand(argv: string[]) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    throw new UsageError(`${USAGE}\nerror: ${(error as Error).message}`);
  }
  const [command, board, ...rest] = parsed.positionals;
  if (command !== 'check' || board === undefined || rest.length || parsed.values.contract === undefined) throw new UsageError(USAGE);
  return { board, contract: parsed.values.contract, ...parsed.values };
}

async function main(argv: string[]): Promise<number> {
  const { board, contract, root, output, json } = parseCommand(argv);
  const report = await checkContract(root ?? projectRoot(), board, contract, output);
  const passed = report.status === 'passed';
  if (output !== undefined) atomicJson(output, report);
  const pointer = output === undefined ? report : {
    schema: report.schema, status: report.status, board: report.board, qualified: false, blockers: report.blockers.length,
    report: { path: resolvePath(output), sha256: sha(output) },
  };
  if (json) console.log(jsonDumps(pointer));
  else console.log(`${passed ? 'PASS' : 'FAIL'}: schematic functional contract; ${passed ? 'all declared assertions passed' : report.blockers[0]?.detail}`);
  return passed ? 0 : 1;
}

runMain(import.meta.url, main);
