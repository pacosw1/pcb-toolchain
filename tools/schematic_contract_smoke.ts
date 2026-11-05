// Bounded actual KiCad export proof on isolated synthetic reviewed fixtures.
//
//   tools/schematic_contract_smoke.ts --output NEW_DIRECTORY [--timeout 45] [--export-only]
// Exit 0 when the proof passed, else 1; 2 on bad usage.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { runMain, UsageError } from './lib/cli.ts';
import { deadlineAfter, encodeDeadline } from './lib/lean-workflow.ts';
import { jsonDumps } from './lib/py-compat.mjs';
import { resolvePath } from './lib/py-path.ts';
import { runProof } from './lib/schematic-smoke.ts';

const USAGE = 'usage: tools/schematic_contract_smoke.ts --output NEW_DIRECTORY [--timeout 45] [--export-only]';
const OPTIONS = { output: { type: 'string' }, timeout: { type: 'string' }, 'export-only': { type: 'boolean' } } as const;

function parseCommand(argv: string[]) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: OPTIONS }));
  } catch (error) {
    throw new UsageError(`${USAGE}\nerror: ${(error as Error).message}`);
  }
  const timeout = Number(values.timeout ?? '45');
  if (values.output === undefined) throw new UsageError(USAGE);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new UsageError(`${USAGE}\nerror: finite positive timeout required`);
  return { output: values.output, timeout, exportOnly: values['export-only'] ?? false };
}

async function main(argv: string[]): Promise<number> {
  const { output, timeout, exportOnly } = parseCommand(argv);
  const resolved = resolvePath(output);
  // Command-local workaround for the diagnosed global third-party directory scan; the global library tables stay in use.
  const thirdParty = `${resolved}-empty-third-party`;
  mkdirSync(dirname(resolved), { recursive: true });
  mkdirSync(thirdParty);
  process.env.KICAD10_3RD_PARTY = thirdParty;
  process.env.IOT_LEAN_DEADLINE = encodeDeadline(deadlineAfter(timeout));
  const result = await runProof(output, timeout, exportOnly);
  console.log(jsonDumps({ status: result.status, cause: result.cause, elapsed_s: result.elapsed_s, cases: result.cases, summary: `${resolved}/summary.json`, qualified: false }));
  return result.status === 'passed' ? 0 : 1;
}

runMain(import.meta.url, main);
