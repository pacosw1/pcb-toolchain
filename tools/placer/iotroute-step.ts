// Compaction router backend `iotroute` (milestone M4, tools/router/DESIGN.md): one step = tools/router/run.py on the step
// board, then the board gate on the routed copy. The step score is measured, never the router claim:
//
//   score = DRC errors + unconnected + parity   (run.py: kicad-cli pcb drc --schematic-parity on the saved board)
//         + every other gate metric with a target (erc_errors, planes, pairs, viapads, paths_low, kicad_happy, ...)
//
// The gate runs only when the DRC part is 0 (a cheaper check that fails first). A step passes only at score 0 with a
// complete gate. A gate metric that did not run makes the score NO_RESULT. The gate runs in one isolated snapshot of the
// repo per compaction run (tools + the board folder + its dependencies); each step copies its routed board into the
// snapshot's project path, then `node tools/gate.mjs BOARD --fresh --evidence-dir`.
import { spawn } from 'node:child_process';
import { closeSync, copyFileSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kiCadPaths } from '../lib/env-paths.mjs';
import { readPyJson, parseTyped, readTyped } from '../lib/json-file.ts';
import { defaultCpu } from '../lib/lean-resources.ts';
import { Float, jsonDumps, number, osError, processText, PyError, pyStr, splitlines } from '../lib/py-compat.mjs';
import { round } from '../lib/py-numbers.ts';
import { caught, isFile, joinPath } from '../lib/py-path.ts';
import { type Dict, need } from '../lib/py-values.ts';
import type { Measure } from './compact-rank.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const NO_RESULT = 10 ** 6;
const INFO_METRICS = new Set(['erc_warnings', 'drc_warnings']);   // tools/lib/gate-core.mjs METRICS without a target
const DRC_METRICS = new Set(['drc_errors', 'drc_unconnected', 'drc_parity']);   // measured by run.py on the saved board
const THREAD_MARKS = ['std::thread', 'thread::spawn', 'thread::scope', 'rayon', 'available_parallelism', 'crossbeam'];
const DRC_TOKENS = 1;   // run.py ends with kicad-cli pcb drc on the saved board: one more token for that phase
const MEASURE_SOURCE = 'tools/router/run.py copper_counts: pcbnew track lengths and via count of the saved board';

export type Metrics = Record<string, unknown>;
/** Starts a command with its output captured, stderr into stdout. The driver's owned stage goes here. */
export type RunStage = (command: string[], stage: string, options: { cwd: string }) => Promise<{ stdout?: string | null }> | { stdout?: string | null };
/** Runs a command with stdout and stderr on the open file `log`. */
export type LogRunner = (command: string[], options: { cwd: string; log: number }) => Promise<unknown> | unknown;
/** tools/pcb_operations.py snapshot: a new folder with the tools, the board folder and its dependencies. */
export type Snapshot = (root: string, workspace: string, board: string) => Promise<unknown> | unknown;
export interface Gate { run(routed: string, evidence: string, log: string): Promise<Metrics | null> | Metrics | null }

function sourceText(core: string): string[] {
  const source = joinPath(core, 'src');
  let names: string[] = [];
  try {
    names = readdirSync(source, { recursive: true, encoding: 'utf8' }).filter(name => name.endsWith('.rs'));
  } catch (error) {
    if (!caught(error, 'OSError')) throw error;   // no src folder: only the manifest counts
  }
  return [joinPath(core, 'Cargo.toml'), ...names.map(name => joinPath(source, name))].map(path => readFileSync(path, 'utf8'));
}

/** CPU tokens for one run.py job from the router's real thread use: 1 + DRC_TOKENS when the core sources (Cargo.toml and
 *  src/) use no thread or parallel crate (the binary runs on one thread), else `full` (the resource default). A core that
 *  cannot be read gets `full` (fail safe). */
export function routerCpu(full: number = defaultCpu(), core: string = joinPath(REPO, 'tools/router/core')): number {
  let files: string[];
  try {
    files = sourceText(core);
  } catch (error) {
    if (caught(error, 'OSError')) return full;
    throw error;
  }
  const text = files.join('\n');
  if (files.length < 2 || THREAD_MARKS.some(mark => text.includes(mark))) return full;
  return Math.min(full, 1 + DRC_TOKENS);
}

/** hardware-design/boards/<ID>[/cad/...] -> ID. */
export function boardId(boardDir: string): string {
  const parts = resolve(boardDir).split(sep);
  const at = parts.findIndex((part, index) => part === 'hardware-design' && parts[index + 1] === 'boards' && index + 2 < parts.length);
  if (at < 0) throw new PyError('ValueError', `--board-dir is not below hardware-design/boards: ${boardDir}`);
  return parts[at + 2];
}

/** [sum of the non-DRC gate metrics with a target, complete]. A metric that is no int makes it incomplete. */
export function gatePart(metrics: Metrics | null | undefined): [number, boolean] {
  const rows = Object.entries(metrics ?? {}).filter(([name]) => !INFO_METRICS.has(name) && !DRC_METRICS.has(name));
  const counts = rows.map(([, value]) => value).filter(value => Number.isInteger(value)) as number[];
  return [counts.reduce((sum, value) => sum + value, 0), counts.length === rows.length && Object.keys(metrics ?? {}).length > 0];
}

const finished = (rec: Dict): boolean => rec.status === 'PASS' || rec.status === 'FAIL';
const drcPart = (rec: Dict): number => ['drc_errors', 'unconnected', 'parity'].reduce((sum, key) => sum + number(need(rec, key)), 0);

/** Step score from the run.py record and the gate metrics (null = gate not run). */
export function score(rec: Dict, metrics: Metrics | null): number {
  if (!finished(rec)) return NO_RESULT;
  const drc = drcPart(rec);
  if (drc) return drc;
  if (metrics === null) return NO_RESULT;
  const [total, complete] = gatePart(metrics);
  return complete ? total : NO_RESULT;
}

const exited = (child: ReturnType<typeof spawn>, command: string[]): Promise<void> => new Promise((done, failed) => {
  child.on('error', error => failed(osError(error, command[0])));
  child.on('close', () => done());
});

const writeToLog: LogRunner = (command, { cwd, log }) =>
  exited(spawn(command[0], command.slice(1), { cwd, stdio: ['inherit', log, log] }), command);

/** subprocess.run(stdout=PIPE, stderr=STDOUT, text=True). */
async function captured(command: string[], stage: string, { cwd }: { cwd: string }): Promise<{ stdout: string }> {
  const child = spawn(command[0], command.slice(1), { cwd, stdio: ['inherit', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  child.stdout?.on('data', chunk => chunks.push(chunk));
  child.stderr?.on('data', chunk => chunks.push(chunk));
  await exited(child, command);
  return { stdout: processText(Buffer.concat(chunks)) };
}

/** One repo snapshot for the gate runs of a compaction call (made at the first clean step). */
export class GateWorkspace implements Gate {
  readonly path: string;
  readonly board: string;
  project: string | null = null;
  config = 'gate.json';
  private readonly snapshot: Snapshot;
  private readonly runner: LogRunner;

  constructor(outdir: string, board: string, snapshot: Snapshot, runner: LogRunner = writeToLog) {
    this.path = joinPath(resolve(outdir), 'gate-workspace');
    this.board = board;
    this.snapshot = snapshot;
    this.runner = runner;
  }

  async ensure(): Promise<this> {
    if (this.project !== null) return this;
    await this.snapshot(REPO, this.path, this.board);
    const folder = joinPath(this.path, 'hardware-design/boards', this.board);
    this.config = isFile(joinPath(folder, 'gate.json')) ? 'gate.json' : 'gate.pending.json';
    this.project = joinPath(folder, need<string>(readPyJson(joinPath(folder, this.config)), 'project'));
    return this;
  }

  async run(routed: string, evidence: string, log: string): Promise<Metrics | null> {
    await this.ensure();
    copyFileSync(routed, `${this.project}.kicad_pcb`);
    const config = this.config === 'gate.json' ? [] : ['--config', this.config];
    const command = ['node', joinPath(this.path, 'tools/gate.mjs'), this.board, '--fresh', '--evidence-dir', evidence, ...config];
    const file = openSync(log, 'w');
    try {
      await this.runner(command, { cwd: this.path, log: file });
    } finally {
      closeSync(file);
    }
    const result = joinPath(evidence, 'result.json');
    if (!isFile(result)) return null;
    return readTyped<Dict>(result).metrics as Metrics | null ?? null;
  }
}

const numeric = (value: unknown): number | null => (typeof value === 'number' || typeof value === 'bigint' || value instanceof Float ? number(value) : null);

/** Measure from a repair score key (DRC part, gate part, length, vias) of the board `routed`; null without a finite length. */
export function measureKey(key: readonly unknown[], routed: string | null, source = 'route'): Measure | null {
  const [length, vias] = [numeric(key[2]), numeric(key[3])];
  if (length === null || vias === null || !Number.isFinite(length) || !Number.isFinite(vias)) return null;
  return { length_mm: new Float(round(length, 1)), vias: Math.trunc(vias), routed, source: `${source}: ${MEASURE_SOURCE}` };
}

function savedRun(d: string): Dict | null {
  try {
    return (readTyped<Dict>(joinPath(d, 'route-0/score.json')).run || {}) as Dict;
  } catch (error) {
    if (caught(error, 'OSError', 'ValueError')) return null;
    throw error;
  }
}

/** Measure of the step route d/route-0/score.json: the routed length (mm) and via count that run.py measured on the saved
 *  board (never the router core claim). Null when the record has no measure. */
export function measure(d: string): Measure | null {
  const rec = savedRun(d);
  if (rec === null || !finished(rec) || (rec.track_length_mm ?? null) === null || (rec.vias ?? null) === null) return null;
  return measureKey([null, null, rec.track_length_mm, rec.vias], (rec.board_file ?? null) as string | null, 'route');
}

function runRecord(output: string): Dict {
  const line = splitlines(output).findLast(text => text.startsWith('{'));
  return line === undefined ? { status: 'ERROR', cause: 'run.py printed no JSON record' } : parseTyped<Dict>(line);
}

/** Route the step board `path` into d/route-0 with run.py, gate it, write d/route-0/score.json; gives [score]. */
export async function routeStep(path: string, d: string, board: string, gate: Gate, iters: number, extra: readonly string[] = [], runStage: RunStage = captured): Promise<number[]> {
  const folder = joinPath(d, 'route-0');
  mkdirSync(folder, { recursive: true });
  const out = joinPath(folder, `${parse(basename(path)).name}.kicad_pcb`);
  const python = kiCadPaths(process.platform, homedir(), process.env).kicadPython;
  const command = [python, joinPath(REPO, 'tools/router/run.py'), board, out, '--pcb', path, '--iters', String(iters), '--json', ...extra];
  const { stdout } = await runStage(command, 'routing', { cwd: REPO });
  writeFileSync(joinPath(d, 'route-0.log'), stdout ?? '');
  const rec = runRecord(stdout ?? '');
  const clean = finished(rec) && drcPart(rec) === 0;
  const metrics = clean ? await gate.run(out, joinPath(folder, 'gate'), joinPath(d, 'gate.log')) : null;
  const s = score(rec, metrics);
  const summary = {
    router: 'iotroute', score: s, run: rec, gate_metrics: metrics, gate: metrics === null ? 'not run: DRC part not 0 or no record' : 'run',
    passed: s === 0, qualified: false,
  };
  writeFileSync(joinPath(folder, 'score.json'), jsonDumps(summary, 1));
  const gateText = metrics === null ? 'n/a' : gatePart(metrics)[0];
  const field = (key: string) => pyStr(rec[key]);
  console.log(`IOTROUTE ${s === 0 ? 'PASS' : 'FAIL'} score ${s} drc ${field('drc_errors')} unconnected ${field('unconnected')} parity ${field('parity')} gate ${gateText} length ${field('track_length_mm')} mm vias ${field('vias')}`);
  return [s];
}
