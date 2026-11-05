// Advisory reference-plane void check, using KiCadRoutingTools check_impedance.
//
// KiCadRoutingTools (MIT, https://github.com/drandyhaas/KiCadRoutingTools) has routers and placers; this wrapper calls
// only its read-only check_impedance analysis. It never runs a router, a placer or any script that adds tracks or vias,
// and it never writes back to the board.
//
// check_impedance reports every place a trace's reference plane has a gap ("void") or a copper split ("split") under it.
// A void run under about 0.3 mm is usually just an antipad; this wrapper keeps void crossings of 1.0 mm or longer, one
// line per crossing. Split crossings are a plane cut, not a void, and never count, however long.
//
// Advisory only: a cross-check against tools/si_planes.py, not a pass/fail gate.
//
//   tools/krt_planes_advisory.ts BOARD.kicad_pcb [--min-length-mm 1.0]
//
// Exit 0 whatever it finds; 2 on a tool error: missing or unpinned clone (KRT_DIR, default
// ~/Documents/GitHub/KiCadRoutingTools), missing venv, bad board path, or the analysis itself failing.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fixed, get, jsonLoads, number, pyStr, strip, truthy } from './lib/py-compat.mjs';
import { runMain, UsageError } from './lib/cli.ts';

const PINNED_COMMIT = '46c90458';
const MIN_VOID_MM = 1;
const USAGE = 'usage: tools/krt_planes_advisory.ts BOARD.kicad_pcb [--min-length-mm 1.0]';

/** One crossing of a check_impedance report and the net it is on. */
export interface VoidCrossing { net: unknown; lengthMm: number; detail: unknown }

const isDirectory = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
const listOf = (value: unknown) => (truthy(value) ? value as unknown[] : []);

/** Reference-plane void crossings of at least minLengthMm. */
export function voidCrossings(report: unknown, minLengthMm = MIN_VOID_MM): VoidCrossing[] {
  return listOf(get(report, 'nets')).flatMap(net => listOf(get(net, 'crossing_detail'))
    .filter(detail => get(detail, 'kind') === 'void')
    .map(detail => ({ net: get(net, 'net_name'), lengthMm: number(get(detail, 'length_mm', 0)), detail }))
    .filter(crossing => crossing.lengthMm >= minLengthMm));
}

export function formatCrossing({ net, lengthMm, detail }: VoidCrossing): string {
  const field = (key: string) => pyStr(get(detail, key));
  return `${pyStr(net)}: ${fixed(lengthMm, 3)} mm void at (${field('x')}, ${field('y')}) ${field('layer')} / ${field('ref_layer')}`;
}

/** The error of a missing or unpinned clone, else null. */
function pinError(clone: string): string | null {
  if (!isDirectory(clone)) return `KiCadRoutingTools clone not found at ${clone}. Set KRT_DIR or clone it there.`;
  const head = spawnSync('git', ['-C', clone, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (head.status !== 0) return `KiCadRoutingTools at ${clone} is not a git repository: ${strip(head.stderr ?? '')}`;
  const commit = strip(head.stdout);
  if (commit.startsWith(PINNED_COMMIT)) return null;
  return `KiCadRoutingTools at ${clone} is at commit ${commit.slice(0, 12)}, not the pinned commit ${PINNED_COMMIT}.`;
}

/** Run check_impedance.py, read-only, and return its report. The clone's own Python does this; we only start it. */
function checkImpedance(clone: string, board: string): unknown {
  const python = ['python3', 'python'].map(name => join(clone, '.venv', 'bin', name)).find(path => existsSync(path));
  if (python === undefined) throw new Error(`KiCadRoutingTools venv not found at ${clone}/.venv (needs numpy, scipy, shapely, Pillow).`);
  const folder = mkdtempSync(join(tmpdir(), 'krt_planes_advisory_'));
  try {
    const report = join(folder, 'impedance.json');
    const script = join(clone, 'py_tools', 'check_impedance.py');
    const run = spawnSync(python, [script, board, '--json', report, '--exit-zero'], { encoding: 'utf8' });
    if (!existsSync(report)) {
      throw new Error(`check_impedance.py produced no output (exit ${run.status}): ${strip(run.stderr ?? '').slice(0, 500)}`);
    }
    return jsonLoads(readFileSync(report));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

function options(argv: string[]): { board: string; minLengthMm: number } {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { 'min-length-mm': { type: 'string' } } });
  } catch {
    throw new UsageError(USAGE);
  }
  const [board, ...rest] = parsed.positionals;
  const minLengthMm = Number(parsed.values['min-length-mm'] ?? MIN_VOID_MM);
  if (board === undefined || rest.length > 0 || Number.isNaN(minLengthMm)) throw new UsageError(USAGE);
  return { board, minLengthMm };
}

function main(argv: string[]): number {
  const { board, minLengthMm } = options(argv);
  const clone = process.env.KRT_DIR || join(homedir(), 'Documents/GitHub/KiCadRoutingTools');
  const path = resolve(board);
  const failure = pinError(clone) ?? (isFile(path) ? null : `${path} is not a file.`);
  if (failure !== null) {
    console.error(`ERROR: ${failure}`);
    return 2;
  }
  let report;
  try {
    report = checkImpedance(clone, path);
  } catch (error) {
    console.error(`ERROR: ${(error as Error).message}`);
    return 2;
  }
  const crossings = voidCrossings(report, minLengthMm);
  for (const crossing of crossings) console.log(formatCrossing(crossing));
  console.log(`${crossings.length} reference-plane void crossings >= ${fixed(minLengthMm, 1)} mm`);
  return 0;
}

runMain(import.meta.url, main);
