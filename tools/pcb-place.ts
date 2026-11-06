// tools/pcb place BOARD: a starting placement from the automatic placer, as a spec for `tools/pcb edit --kind place`.
// It writes only the spec. The placer does not know the board's own placement rules: adjust the spec, and let `edit` check it.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMain, UsageError } from './lib/cli.ts';
import { footprints } from './lib/native-board.ts';
import { boardConfig } from './lib/pcb-workflow.ts';
import { projectRoot } from './lib/project-root.mjs';
import { jsonDumps } from './lib/py-compat.mjs';
import { withSuffix } from './lib/py-path.ts';
import { parseOptions } from './placer/options.ts';
import { placementSpec } from './placer/place-spec.ts';

const USAGE = 'usage: pcb [--project DIR] place BOARD [--out SPEC.json] [--seed N] [--epochs N] [--steps N] [--json]';
const PLACER = join(dirname(fileURLToPath(import.meta.url)), 'placer/place.ts');

export type Placer = (args: string[]) => void;
export interface PlaceOptions { out?: string; seed: number; epochs: number; steps: number }

const placer: Placer = args => {
  execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', PLACER, ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
};

export function placeBoard(root: string, board: string, options: PlaceOptions, run: Placer = placer): { board: string; spec: string; moved: number; edit: string } {
  const native = withSuffix(boardConfig(root, board).project, '.kicad_pcb');
  const folder = mkdtempSync(join(tmpdir(), 'pcb-place-'));
  try {
    const problem = join(folder, 'problem.json'), result = join(folder, 'result.json'), output = join(folder, 'candidates');
    run(['read', native, '-o', problem]);
    run(['run', problem, '-o', result, '--top', '1', '--seed', String(options.seed), '--epochs', String(options.epochs), '--steps', String(options.steps)]);
    run(['write', native, problem, result, '--outdir', output]);
    const spec = placementSpec(footprints(native), footprints(join(output, 'cand0', basename(native))));
    const moved = Object.keys(spec.place).length;
    if (!moved) throw new Error(`the automatic placer moved no parts on ${board}`);
    const path = resolve(options.out ?? join(root, '.gate/place', `${board}.json`));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${jsonDumps(spec)}\n`);
    return { board, spec: path, moved, edit: `tools/pcb edit ${board} --kind place --spec ${path} --json` };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

function main(given: string[]): number {
  const argv = [...given];
  let explicit: string | undefined;
  if (argv[0] === '--project') { explicit = argv[1]; argv.splice(0, 2); }
  else if (argv[0]?.startsWith('--project=')) { explicit = argv[0].slice(10); argv.shift(); }
  argv.shift();   // the command word
  const a = parseOptions(argv, { '--out': 'text', '--seed': 'int', '--epochs': 'int', '--steps': 'int', '--json': 'switch' }, USAGE);
  const [board] = a.positionals;
  if (!board) throw new UsageError(USAGE);
  const report = placeBoard(projectRoot(explicit), board, { out: a.text('--out'), seed: a.int('--seed') ?? 1, epochs: a.int('--epochs') ?? 8, steps: a.int('--steps') ?? 20000 });
  console.log(jsonDumps(report));
  return 0;
}

runMain(import.meta.url, main);
