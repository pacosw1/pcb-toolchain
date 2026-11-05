// Compaction router backend `iotroute` (milestone M4, tools/router/DESIGN.md): one step = iotroute run on the step
// board, then the board gate on the routed copy. The step score is measured, never the router claim:
//
//   score = DRC errors + unconnected + parity   (iotroute run: kicad-cli pcb drc --schematic-parity on the saved board)
//         + every other gate metric with a target (erc_errors, planes, pairs, viapads, paths_low, kicad_happy, ...)
//
// The gate runs only when the DRC part is 0 (a cheaper check that fails first). A step passes only at score 0 with a
// complete gate. A gate metric that did not run makes the score NO_RESULT. The gate runs in one isolated snapshot of the
// repo per compaction run (tools + the board folder + its dependencies); each step copies its routed board into the
// snapshot's project path, then `node tools/gate.mjs BOARD --fresh --evidence-dir`.
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iotrouteBin } from '../lib/iotroute-bin.ts';
import { readPyJson, parseTyped, readTyped } from '../lib/json-file.ts';
import { sha256File } from '../lib/json-file.ts';
import { defaultCpu } from '../lib/lean-resources.ts';
import { Float, jsonDumps, number, PyError, pyStr, splitlines } from '../lib/py-compat.mjs';
import { round } from '../lib/py-numbers.ts';
import { caught, isFile, joinPath } from '../lib/py-path.ts';
import { type Dict, need } from '../lib/py-values.ts';
import type { Measure } from './compact-rank.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const NO_RESULT = 10 ** 6;
const INFO_METRICS = new Set(['erc_warnings', 'drc_warnings']);   // tools/lib/gate-core.mjs METRICS without a target
const REQUIRED_METRICS = ['erc_errors', 'drc_errors', 'drc_unconnected', 'drc_parity', 'paths_low', 'viapads', 'kicad_happy_findings', 'port_label_failures'];
const GATE_METRICS = new Set([...REQUIRED_METRICS, 'planes_failures', 'pairs_failures', 'rf_failures', ...INFO_METRICS]);
const THREAD_MARKS = ['std::thread', 'thread::spawn', 'thread::scope', 'rayon', 'available_parallelism', 'crossbeam'];
const DRC_TOKENS = 1;   // iotroute run ends with kicad-cli pcb drc on the saved board: one more token for that phase
const MEASURE_SOURCE = 'iotroute run copper_counts: track lengths and via count of the saved board';

export type Metrics = Record<string, unknown>;
/** Starts a command with its output captured, stderr into stdout. The driver's owned stage goes here. */
export type RunStage = (command: string[], stage: string, options: { cwd: string }) => Promise<{ returncode: number; stdout?: string | null }> | { returncode: number; stdout?: string | null };
/** Runs a command with stdout and stderr on the open file `log`. */
export type LogRunner = (command: string[], options: { cwd: string; log: number; env: NodeJS.ProcessEnv }) => Promise<{ returncode: number }> | { returncode: number };
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

/** CPU tokens for one iotroute run job from the router's real thread use: 1 + DRC_TOKENS when the core sources (Cargo.toml and
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
  const all = Object.entries(metrics ?? {});
  const rows = all.filter(([name]) => !INFO_METRICS.has(name));
  const counts = rows.map(([, value]) => value).filter(value => Number.isSafeInteger(value) && (value as number) >= 0) as number[];
  const complete = REQUIRED_METRICS.every(name => Object.hasOwn(metrics ?? {}, name))
    && all.every(([name, value]) => GATE_METRICS.has(name) && Number.isSafeInteger(value) && (value as number) >= 0);
  return [counts.reduce((sum, value) => sum + value, 0), complete];
}

const finished = (rec: Dict): boolean => rec.status === 'PASS' || rec.status === 'FAIL';
const drcPart = (rec: Dict): number => ['drc_errors', 'unconnected', 'parity'].reduce((sum, key) => sum + number(need(rec, key)), 0);
const validDrcCounts = (rec: Dict): boolean => ['drc_errors', 'unconnected', 'parity'].every(key => {
  const value = need(rec, key);
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
});

/** Step score from the run record and the gate metrics (null = gate not run). */
export function score(rec: Dict, metrics: Metrics | null): number {
  if (!finished(rec)) return NO_RESULT;
  if (!validDrcCounts(rec)) return NO_RESULT;
  const drc = drcPart(rec);
  if (!Number.isSafeInteger(drc)) return NO_RESULT;
  if (drc) return drc;
  if (rec.status !== 'PASS') return NO_RESULT;
  if (metrics === null) return NO_RESULT;
  const [total, complete] = gatePart(metrics);
  return complete ? total : NO_RESULT;
}

/** One repo snapshot for the gate runs of a compaction call (made at the first clean step). */
export class GateWorkspace implements Gate {
  readonly path: string;
  readonly board: string;
  project: string | null = null;
  config = 'gate.json';
  private readonly snapshot: Snapshot;
  private readonly runner: LogRunner;

  constructor(outdir: string, board: string, snapshot: Snapshot, runner: LogRunner) {
    if (!/^[A-Z0-9][A-Z0-9-]*$(?![\s\S])/.test(board)) throw new Error('invalid board ID');
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
    const project = resolve(folder, need<string>(readPyJson(joinPath(folder, this.config)), 'project'));
    const rel = relative(realpathSync(folder), realpathSync(dirname(project)));
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('gate project escapes board snapshot');
    this.project = project;
    return this;
  }

  async run(routed: string, evidence: string, log: string): Promise<Metrics | null> {
    await this.ensure();
    // A pending configuration is not a release gate, and stale evidence must never be reused.
    if (this.config !== 'gate.json' || existsSync(evidence)) return null;
    const original = sha256File(routed);
    const staged = `${this.project}.kicad_pcb`;
    if (lstatSync(staged, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('gate board cannot be a symlink');
    // Replace the snapshot's path rather than writing through a symlink or a hard link to canonical CAD.
    const temporary = joinPath(dirname(staged), `.gate-board-${randomBytes(16).toString('hex')}`);
    try {
      writeFileSync(temporary, readFileSync(routed), { flag: 'wx', mode: 0o600 });
      if (sha256File(temporary) !== original) throw new Error('routed board changed while staging');
      renameSync(temporary, staged);
    } finally { rmSync(temporary, { force: true }); }
    const config = this.config === 'gate.json' ? [] : ['--config', this.config];
    const command = ['node', joinPath(this.path, 'tools/gate.mjs'), this.board, '--fresh', '--evidence-dir', evidence, ...config];
    const file = openSync(log, 'wx');
    try {
      const env = { ...process.env, IOT_LAB: this.path };
      const gateRun = await this.runner(command, { cwd: this.path, log: file, env });
      if (gateRun.returncode !== 0) return null;
      const result = joinPath(evidence, 'result.json');
      if (!isFile(result)) return null;
      const resultHash = sha256File(result);
      // Reuse the release gate's source binding, raw native reports and process-event verification.
      const verifier = ['node', joinPath(this.path, 'tools/check-release-gate.mjs'), this.board, '--gate-dir', evidence];
      const checked = await this.runner(verifier, { cwd: this.path, log: file, env });
      if (checked.returncode !== 0 || sha256File(result) !== resultHash || sha256File(staged) !== original || sha256File(routed) !== original) return null;
      const receipt = readTyped<Dict>(result);
      if (receipt.exit !== 0 || receipt.changedDuringRun !== false || !Array.isArray(receipt.preflightErrors) || receipt.preflightErrors.length) return null;
      const metrics = receipt.metrics as Metrics | null;
      return metrics && gatePart(metrics)[1] ? metrics : null;
    } finally {
      closeSync(file);
    }
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

/** Measure of the step route d/route-0/score.json: the routed length (mm) and via count that iotroute run measured on the saved
 *  board (never the router core claim). Null when the record has no measure. */
export function measure(d: string): Measure | null {
  const rec = savedRun(d);
  if (rec === null || !finished(rec) || (rec.track_length_mm ?? null) === null || (rec.vias ?? null) === null) return null;
  return measureKey([null, null, rec.track_length_mm, rec.vias], (rec.board_file ?? null) as string | null, 'route');
}

function runRecord(output: string): Dict {
  const line = splitlines(output).findLast(text => text.startsWith('{'));
  return line === undefined ? { status: 'ERROR', cause: 'iotroute run printed no JSON record' } : parseTyped<Dict>(line);
}

/** Route the step board `path` into d/route-0 with iotroute run, gate it, write d/route-0/score.json; gives [score]. */
export async function routeStep(path: string, d: string, board: string, gate: Gate, iters: number, extra: readonly string[], runStage: RunStage): Promise<number[]> {
  const folder = joinPath(d, 'route-0');
  mkdirSync(folder, { recursive: true });
  const out = joinPath(folder, `${parse(basename(path)).name}.kicad_pcb`);
  const command = [iotrouteBin(), 'run', board, out, '--pcb', path, '--iters', String(iters), '--tools', joinPath(REPO, 'tools'), '--json', ...extra];
  const { stdout, returncode } = await runStage(command, 'routing', { cwd: REPO });
  writeFileSync(joinPath(d, 'route-0.log'), stdout ?? '');
  const rec = runRecord(stdout ?? '');
  if (returncode !== 0 && rec.status === 'PASS') Object.assign(rec, { status: 'ERROR', cause: `routing process exited ${returncode}` });
  const clean = returncode === 0 && rec.status === 'PASS' && validDrcCounts(rec) && drcPart(rec) === 0;
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
