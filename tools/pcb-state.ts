// tools/pcb change and state: the event and the view of a board.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { boardView, viewText } from './lib/board-view.ts';
import { recordChange } from './lib/change-log.ts';
import { parseFlags, runMain, UsageError } from './lib/cli.ts';
import { nextAction } from './lib/pcb-next.ts';
import { nextReaders } from './lib/pcb-next-readers.ts';
import { projectRoot } from './lib/project-root.mjs';
import { jsonDumps } from './lib/py-compat.mjs';

const USAGE = `usage: pcb [--project DIR] change BOARD --kind KIND --reason TEXT --by NAME [--refs A,B] [--json]
       pcb [--project DIR] state BOARD [--runs-dir DIR] [--json]`;

function runsBase(root: string, given: string | undefined): string {
  const base = resolve(given ?? process.env.PCB_RUNS_DIR ?? resolve(root, '.gate/cli'));
  try { return realpathSync(base); } catch { return base; }
}

async function main(given: string[]): Promise<number> {
  const argv = [...given];
  let explicit: string | undefined;
  if (argv[0] === '--project') { explicit = argv[1]; argv.splice(0, 2); }
  else if (argv[0]?.startsWith('--project=')) { explicit = argv[0].slice(10); argv.shift(); }
  const command = argv.shift();
  const a = parseFlags(argv, command === 'change'
    ? { json: { type: 'boolean' }, kind: { type: 'string' }, reason: { type: 'string' }, by: { type: 'string' }, refs: { type: 'string' } }
    : { json: { type: 'boolean' }, 'runs-dir': { type: 'string' } }, USAGE);
  const [board, ...rest] = a.positionals, values = a.values as Record<string, string | boolean | undefined>;
  if (!board || rest.length) throw new UsageError(USAGE);
  const root = projectRoot(explicit), json = values.json === true;
  if (command === 'state') {
    const base = runsBase(root, values['runs-dir'] as string | undefined);
    const view = await boardView(root, board, base, (where, name) => nextAction(where, name, { base, readers: nextReaders }));
    console.log(json ? jsonDumps(view) : viewText(view));
    return 0;
  }
  const { kind, reason, by, refs } = values as Record<string, string | undefined>;
  if (command !== 'change' || kind === undefined || reason === undefined || by === undefined) throw new UsageError(USAGE);
  const event = recordChange(root, board, { kind, reason, by, refs: refs ? refs.split(',').filter(Boolean) : [] });
  console.log(json ? jsonDumps(event) : `PASS: ${event.id} ${event.kind} recorded for ${board}. The event makes no evidence valid: run tools/pcb next ${board}`);
  return 0;
}
runMain(import.meta.url, main);
