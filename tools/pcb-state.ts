// tools/pcb change BOARD: appends an event to the committed change log of BOARD.
import { recordChange } from './lib/change-log.ts';
import { parseFlags, runMain, UsageError } from './lib/cli.ts';
import { projectRoot } from './lib/project-root.mjs';
import { jsonDumps } from './lib/py-compat.mjs';

const USAGE = 'usage: pcb [--project DIR] change BOARD --kind KIND --reason TEXT --by NAME [--refs A,B] [--json]';

async function main(given: string[]): Promise<number> {
  const argv = [...given];
  let explicit: string | undefined;
  if (argv[0] === '--project') { explicit = argv[1]; argv.splice(0, 2); }
  else if (argv[0]?.startsWith('--project=')) { explicit = argv[0].slice(10); argv.shift(); }
  argv.shift();   // the command word
  const a = parseFlags(argv, { json: { type: 'boolean' }, kind: { type: 'string' }, reason: { type: 'string' }, by: { type: 'string' }, refs: { type: 'string' } }, USAGE);
  const [board, ...rest] = a.positionals;
  const { json, kind, reason, by, refs } = a.values;
  if (!board || rest.length || kind === undefined || reason === undefined || by === undefined) throw new UsageError(USAGE);
  const event = recordChange(projectRoot(explicit), board, { kind, reason, by, refs: refs ? refs.split(',').filter(Boolean) : [] });
  console.log(json ? jsonDumps(event) : `PASS: ${event.id} ${event.kind} recorded for ${board}. The event makes no evidence valid: run tools/pcb next ${board}`);
  return 0;
}
runMain(import.meta.url, main);
