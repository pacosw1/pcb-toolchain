// tools/pcb layout BOARD: the status of the layout plan that must be approved before place and route.
import { existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { approveLayoutPlan, layoutGate, layoutPlanStatus } from './lib/layout-plan.ts';
import { parseFlags, runMain, UsageError } from './lib/cli.ts';
import { readObject } from './lib/json-file.ts';
import { projectRoot } from './lib/project-root.mjs';
import { jsonDumps } from './lib/py-compat.mjs';

const USAGE = 'usage: pcb [--project DIR] layout BOARD [--json] [--approve --by NAME --reason TEXT --image FILE]';

/** The top image of the newest run of BOARD that has one, as a path inside the project. This is what a person looks at before approval. */
function newestImage(root: string, board: string, runs: string): string | null {
  if (!existsSync(runs)) return null;
  const found = readdirSync(runs).flatMap(name => {
    const folder = join(runs, name), image = join(folder, 'images/top.png');
    try {
      const manifest = readObject<{ board?: string; created_at?: string }>(join(folder, 'run.json'));
      return manifest.board === board && existsSync(image) ? [{ created: String(manifest.created_at ?? ''), image }] : [];
    } catch { return []; }
  });
  const newest = found.sort((a, b) => a.created.localeCompare(b.created)).at(-1);
  return newest ? relative(root, newest.image).split(sep).join('/') : null;
}

async function main(given: string[]): Promise<number> {
  const argv = [...given];
  let explicit: string | undefined;
  if (argv[0] === '--project') { explicit = argv[1]; argv.splice(0, 2); }
  else if (argv[0]?.startsWith('--project=')) { explicit = argv[0].slice(10); argv.shift(); }
  argv.shift();   // the command word
  // --runs-dir names the folder of the runs. `pcb next` adds it to the commands that it names when a custom runs dir is set.
  const a = parseFlags(argv, { json: { type: 'boolean' }, approve: { type: 'boolean' }, by: { type: 'string' }, reason: { type: 'string' }, image: { type: 'string' }, 'runs-dir': { type: 'string' } }, USAGE);
  const [board, ...rest] = a.positionals;
  if (!board || rest.length) throw new UsageError(USAGE);
  const { json, approve, by, reason, image, 'runs-dir': runsDir } = a.values;
  if (approve ? by === undefined || reason === undefined || image === undefined : by !== undefined || reason !== undefined || image !== undefined) throw new UsageError(USAGE);
  const root = projectRoot(explicit);
  const status = approve ? await approveLayoutPlan(root, board, by!, reason!, image!) : layoutPlanStatus(root, board);
  const shown = status.image ?? newestImage(root, board, runsDir ?? process.env.PCB_RUNS_DIR ?? join(root, '.gate/cli'));
  const ok = status.state === 'approved' || status.state === 'exempt';
  if (json) console.log(jsonDumps({ ...status, image: shown }));
  else {
    if (!ok) console.log(`FAIL: ${layoutGate(root, board, () => {})!.message}`);
    else console.log(status.state === 'exempt' ? `PASS: ${board} is exempt from the layout plan: ${status.exempt_reason}` : `PASS: ${board} layout plan approved by ${status.approval!.by}`);
    if (shown) console.log(`image: ${shown}`);
  }
  return ok ? 0 : 1;
}
runMain(import.meta.url, main);
