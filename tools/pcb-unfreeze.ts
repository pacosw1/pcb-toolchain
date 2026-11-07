// tools/pcb unfreeze BOARD [--json] [--record --by NAME --reason TEXT]: shows the freeze state of a board, or records an unfreeze.
// The registry row of a frozen board has `frozen: {reason}`. The record lets the CAD of that board change (lib/board-freeze.ts).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { freezeStatus, recordUnfreeze } from './lib/board-freeze.ts';
import { isCanonicalRoot } from './lib/cad-seal.ts';
import { parseFlags, runMain, UsageError } from './lib/cli.ts';
import { projectRoot } from './lib/project-root.mjs';
import { jsonDumps } from './lib/py-compat.mjs';

const USAGE = 'usage: pcb [--project DIR] unfreeze BOARD [--json] [--record --by NAME --reason TEXT]';

async function main(given: string[]): Promise<number> {
  const argv = [...given];
  let explicit: string | undefined;
  if (argv[0] === '--project') { explicit = argv[1]; argv.splice(0, 2); }
  else if (argv[0]?.startsWith('--project=')) { explicit = argv[0].slice(10); argv.shift(); }
  argv.shift();   // the command name
  const a = parseFlags(argv, { json: { type: 'boolean' }, record: { type: 'boolean' }, by: { type: 'string' }, reason: { type: 'string' } }, USAGE);
  const [board, ...rest] = a.positionals;
  if (!board || rest.length) throw new UsageError(USAGE);
  const { json, record, by, reason } = a.values;
  if (record ? typeof by !== 'string' || typeof reason !== 'string' : by !== undefined || reason !== undefined) throw new UsageError(USAGE);
  const root = projectRoot(explicit);
  if (!existsSync(join(root, 'hardware-design/boards', board))) throw new Error(`unknown board ${board}: no folder hardware-design/boards/${board}`);
  if (record) {
    if (!isCanonicalRoot(root)) throw new Error(`${root} is a run workspace or candidate copy, not canonical; it is never unfrozen`);
    recordUnfreeze(root, board, { by: by as string, reason: reason as string });
  }
  const status = freezeStatus(root, board);
  if (json) console.log(jsonDumps(status));
  else if (status.state === 'not_frozen') console.log(`${board} is not frozen`);
  else if (status.state === 'frozen') console.log(`${board} is frozen: ${status.frozen_reason}\nA person records an unfreeze: tools/pcb unfreeze ${board} --record --by NAME --reason TEXT`);
  else if (status.state === 'unfrozen') console.log(`${board} is unfrozen by ${status.record!.by}: ${status.record!.reason}\nThe registry still says frozen: ${status.frozen_reason}`);
  else console.log(`${board} is frozen: ${status.frozen_reason}\nThe unfreeze record is not valid: ${status.problems.join('; ')}`);
  return status.state === 'frozen' || status.state === 'invalid' ? 1 : 0;
}
runMain(import.meta.url, main);
