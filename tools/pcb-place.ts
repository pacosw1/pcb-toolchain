// tools/pcb place BOARD: a starting placement from the automatic placer, as a spec for `tools/pcb edit --kind place`.
// It writes specs; board rules constrain the search and screen each candidate.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMain, UsageError } from './lib/cli.ts';
import { checkPlacementRules, placementRulesPath } from './lib/placement-rules.ts';
import { verifySeal } from './lib/cad-seal.ts';
import type { Dict } from './lib/py-values.ts';
import { footprints } from './lib/native-board.ts';
import { boardConfig } from './lib/pcb-workflow.ts';
import { projectRoot } from './lib/project-root.mjs';
import { jsonDumps } from './lib/py-compat.mjs';
import { withSuffix } from './lib/py-path.ts';
import { parseOptions } from './placer/options.ts';
import { placementSpec } from './placer/place-spec.ts';

const USAGE = 'usage: pcb [--project DIR] place BOARD [--out SPEC.json] [--seed N] [--seeds N] [--epochs N] [--steps N] [--json]';
const PLACER = join(dirname(fileURLToPath(import.meta.url)), 'placer/place.ts');

export type Placer = (args: string[]) => void;
export interface PlaceOptions { out?: string; seed: number; epochs: number; steps: number }

const placer: Placer = args => {
  execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', PLACER, ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
};

interface Placement { board: string; spec: string; moved: number; edit: string }
interface Candidate extends Placement { seed: number; margins: { smallest_mm: number | null; rules: { id: string; margin_mm: number | null }[] }; wirelength: number | null }
class RuleMiss extends Error {
  readonly ids: string[];
  constructor(ids: string[]) { super('placement rule misses: ' + ids.join(', ')); this.ids = ids; }
}

function placeCandidate(root: string, board: string, options: PlaceOptions, run: Placer, allowUnmoved = false): Candidate {
  const native = withSuffix(boardConfig(root, board).project, '.kicad_pcb');
  const folder = mkdtempSync(join(tmpdir(), 'pcb-place-'));
  try {
    const problem = join(folder, 'problem.json'), result = join(folder, 'result.json'), output = join(folder, 'candidates');
    const rules = placementRulesPath(root, board);
    run(['read', native, '-o', problem, ...(existsSync(rules) ? ['--engineering-manifest', rules, '--engineering-board', board, '--engineering-root', root] : [])]);
    let failure: unknown;
    try { run(['run', problem, '-o', result, '--top', '1', '--workers', '1', '--seed', String(options.seed), '--epochs', String(options.epochs), '--steps', String(options.steps)]); }
    catch (error) { failure = error; }
    const found = existsSync(result) ? (JSON.parse(readFileSync(result, 'utf8')) as { candidates: { components?: { hpwl?: number }; engineering?: { blockers: Dict[] } }[] }).candidates[0] : undefined;
    const misses = found?.engineering?.blockers ?? [];
    if (misses.length) throw new RuleMiss(misses.map(row => String(row.id ?? row.code)));
    if (failure) throw failure;
    run(['write', native, problem, result, '--outdir', output]);
    const candidate = join(output, 'cand0', basename(native));
    const checked = checkPlacementRules(root, board, candidate);
    if (checked && checked.status !== 'passed') throw new RuleMiss((checked.blockers as Dict[]).map(row => String(row.id ?? row.code)));
    const margins = ((checked?.measurements ?? []) as Dict[]).map(row => ({ id: String(row.id), margin_mm: typeof row.margin_mm === 'number' ? row.margin_mm : null }));
    const numericMargins = margins.flatMap(row => row.margin_mm === null ? [] : [row.margin_mm]);
    const spec = placementSpec(footprints(native), footprints(candidate));
    const moved = Object.keys(spec.place).length;
    if (!moved && !allowUnmoved) throw new Error(`the automatic placer moved no parts on ${board}`);
    const path = resolve(options.out ?? join(root, '.gate/place', `${board}.json`));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${jsonDumps(spec)}\n`);
    return { seed: options.seed, margins: { smallest_mm: numericMargins.length ? Math.min(...numericMargins) : null, rules: margins }, wirelength: found?.components?.hpwl ?? null, board, spec: path, moved, edit: `tools/pcb edit ${board} --kind place --spec ${path} --json` };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

export function placeBoard(root: string, board: string, options: PlaceOptions, run: Placer = placer): Placement {
  const { spec, moved, edit } = placeCandidate(root, board, options, run);
  return { board, spec, moved, edit };
}

export function placeCandidates(root: string, board: string, options: PlaceOptions, seeds: number, run: Placer = placer): { board: string; candidates: Candidate[] } {
  if (!Number.isSafeInteger(seeds) || seeds < 1) throw new Error('--seeds must be a positive integer');
  if (options.out) throw new Error('--out cannot be combined with --seeds');
  const candidates: Candidate[] = [], misses = new Map<string, number>();
  for (let i = 0; i < seeds; i++) {
    const seed = options.seed + i;
    try { candidates.push(placeCandidate(root, board, { ...options, seed, out: join(root, '.gate/place', `${board}-seed${seed}.json`) }, run, true)); }
    catch (error) {
      if (!(error instanceof RuleMiss)) throw error;
      for (const id of new Set(error.ids)) misses.set(id, (misses.get(id) ?? 0) + 1);
    }
  }
  if (!candidates.length) {
    const worst = [...misses].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    throw new Error(`no placement candidate kept; rule ${worst?.[0] ?? 'unknown'} missed in ${worst?.[1] ?? 0} seeds`);
  }
  return { board, candidates };
}

function main(given: string[]): number {
  const argv = [...given];
  let explicit: string | undefined;
  if (argv[0] === '--project') { explicit = argv[1]; argv.splice(0, 2); }
  else if (argv[0]?.startsWith('--project=')) { explicit = argv[0].slice(10); argv.shift(); }
  argv.shift();   // the command word
  const a = parseOptions(argv, { '--out': 'text', '--seed': 'int', '--seeds': 'int', '--epochs': 'int', '--steps': 'int', '--json': 'switch' }, USAGE);
  const [board] = a.positionals;
  if (!board) throw new UsageError(USAGE);
  const root = projectRoot(explicit);
  verifySeal(root, board);
  const options = { out: a.text('--out'), seed: a.int('--seed') ?? 1, epochs: a.int('--epochs') ?? 8, steps: a.int('--steps') ?? 20000 };
  if (!a.has('--seeds')) console.log(jsonDumps(placeBoard(root, board, options)));
  else {
    const report = placeCandidates(root, board, options, a.int('--seeds')!);
    if (a.has('--json')) console.log(jsonDumps(report));
    else {
      console.log('seed  moved  margin_mm  wirelength  spec');
      for (const row of report.candidates) console.log([row.seed, row.moved, row.margins.smallest_mm ?? '-', row.wirelength ?? '-', row.spec].join('  '));
      for (const row of report.candidates) console.log(row.edit);
    }
  }
  return 0;
}

runMain(import.meta.url, main);
