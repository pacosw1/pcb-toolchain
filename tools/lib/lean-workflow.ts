// Small local workflow controls: deadlines, attribution and candidate selection.
// No cached result is qualified here: native board and release gates stay authoritative.
// run_stage and job_slot need process ownership and flock, which live in the iotroute binary (lib/owned-stage.ts,
// lib/file-lock.ts).
import { dirname } from 'node:path';
import { atomicJson, sha256File } from './json-file.ts';
import { now as monotonic } from './lean-clock.ts';
import { Float, floatRepr, get, number, PyError, truthy } from './py-compat.mjs';
import { pyFloat } from './py-numbers.ts';
import { isFile, joinPath, jsonOf, pathExists, resolvePath } from './py-path.ts';

export const DEADLINE_PROTOCOL = 'clock-monotonic-v1:';
const TIMEOUT_ARTIFACTS = ['board.dsn', 'board.ses', 'screen.ses', 'report.json', 'run.log', 'stages.jsonl', 'effective-configuration.json'];
const FATAL_COPPER = new Set(['shorting_items', 'clearance', 'copper_edge_clearance']);
const MAX_SCORE = 10 ** 6;
const OUTLINE_TOLERANCE = 1e-9;
const STAGE_DEPTHS = ['0', '1', '2'];

type Environment = Record<string, string | undefined>;
interface Candidate { unpassed: boolean; score: number; index: number; board: string }

export function decodeDeadline(value: unknown): number {
  if (typeof value !== 'string' || !value.startsWith(DEADLINE_PROTOCOL)) throw new PyError('ValueError', 'unsupported inherited deadline protocol');
  const deadline = pyFloat(value.slice(DEADLINE_PROTOCOL.length));
  if (!Number.isFinite(deadline)) throw new PyError('ValueError', 'deadline must be finite');
  return deadline;
}

export function encodeDeadline(value: number): string {
  if (!Number.isFinite(value)) throw new PyError('ValueError', 'deadline must be finite');
  return DEADLINE_PROTOCOL + floatRepr(value);
}

export function inheritedDeadline(env: Environment = process.env): number | null {
  const value = env.IOT_LEAN_DEADLINE;
  return value === undefined ? null : decodeDeadline(value);
}

export function deadlineAfter(seconds: number, env: Environment = process.env, now = monotonic): number {
  if (!Number.isFinite(seconds) || seconds < 0) throw new PyError('ValueError', 'budget must be finite and nonnegative');
  const value = now() + seconds;
  const inherited = inheritedDeadline(env);
  return inherited === null ? value : Math.min(value, inherited);
}

/** Seconds left, never negative; null with no deadline. With no argument, the inherited deadline. */
export function remaining(deadline?: number | string | null, now = monotonic): number | null {
  const given = deadline ?? inheritedDeadline();
  const value = typeof given === 'string' ? decodeDeadline(given) : given;
  if (value === null) return null;
  if (!Number.isFinite(value)) throw new PyError('ValueError', 'deadline must be finite');
  return Math.max(0, value - now());
}

/** Root plus two nested owned supervisors; deeper nesting is rejected. */
export function stageDepth(env: Environment): number {
  const value = env.IOT_LEAN_STAGE_DEPTH ?? '0';
  if (!STAGE_DEPTHS.includes(value)) throw new PyError('ValueError', 'invalid/excessive owned stage depth');
  return Number(value);
}

export function optimizerOptions(policy: string, threads = 0): string[] {
  const enabled = `--router.optimizer.enabled=${policy === 'always'}`;
  return threads ? [enabled, `--router.autorouter.max_threads=${threads}`, `--router.optimizer.max_threads=${threads}`] : [enabled];
}

/** Only independently checked existing copper faults stop routing. Opens, placement warnings and skipped-net artifacts do not. */
export function preflightErrors(drc: unknown): unknown[] {
  return (get(drc, 'violations', []) as unknown[]).filter(violation => get(violation, 'severity') === 'error'
    && FATAL_COPPER.has(get(violation, 'type') as string) && !truthy(get(violation, 'excluded', false)));
}

export function validateDrc<T>(drc: T): T {
  const lists = drc instanceof Map && ['violations', 'unconnected_items'].every(key => Array.isArray(drc.get(key)));
  if (!lists) throw new PyError('ValueError', 'missing or malformed native DRC evidence');
  return drc;
}

/** Describe retained evidence without importing or qualifying a checkpoint. */
export function routerTimeout(outdir: string, error?: { name: string; cleanup?: unknown }): void {
  const present = TIMEOUT_ARTIFACTS.filter(name => isFile(joinPath(outdir, name)));
  atomicJson(joinPath(outdir, 'outcome.json'), {
    status: 'timeout', returncode: 124, qualified: false,
    artifacts: Object.fromEntries(present.map(name => [name, sha256File(joinPath(outdir, name))])),
    cause: error?.name ?? 'TimeoutExpired', cleanup: error?.cleanup ?? null,
    note: 'deadline reached; checkpoints are incomplete evidence, not a verified candidate',
  });
}

const isNumber = (value: unknown): boolean =>
  typeof value === 'bigint' || typeof value === 'boolean' || value instanceof Float;

const usableScore = (value: unknown): boolean => {
  if (!isNumber(value)) return false;
  const score = number(value);
  return Number.isFinite(score) && score >= 0 && score < MAX_SCORE;
};

function onAcceptedOutline(step: unknown): boolean {
  const k = get(step, 'k');
  return isNumber(k) && Number.isFinite(number(k)) && Math.abs(number(k) - 1) <= OUTLINE_TOLERANCE;
}

function verifiedOutcome(board: string): boolean {
  const outcome = joinPath(dirname(board), 'outcome.json');
  if (!pathExists(outcome)) return true;
  const evidence = jsonOf(outcome);
  return get(evidence, 'status') === 'complete' && get(evidence, 'board_sha256') === sha256File(board);
}

/** Stored absolute paths are never followed after an archive or move: the producing step sits under `root`. */
function candidateOf(step: unknown, index: number, root: string): Candidate | null {
  if (!onAcceptedOutline(step) || get(step, 'status', 'complete') !== 'complete') return null;
  const scores = get(step, 'runs');
  if (!truthy(get(step, 'board')) || !truthy(scores)) return null;
  if (!Array.isArray(scores) || !scores.every(usableScore)) return null;
  const board = joinPath(root, `step-${index}`, 'route-0', 'routed.kicad_pcb');
  if (!isFile(board) || !verifiedOutcome(board)) return null;
  return { unpassed: !truthy(get(step, 'passed', false)), score: Math.min(...scores.map(number)), index, board };
}

const better = (a: Candidate, b: Candidate): number => Number(a.unpassed) - Number(b.unpassed) || a.score - b.score || a.index - b.index;

/** Select only attributed, non-timeout candidates on the accepted outline. */
export function selectReal(run: unknown, directory: string): string {
  const root = resolvePath(directory);
  const steps = get(run, 'steps', []) as unknown[];
  const candidates = steps.map((step, index) => candidateOf(step, index, root)).filter(candidate => candidate !== null);
  if (!candidates.length) throw new PyError('ValueError', 'no verified candidate on the accepted outline; diagnostic evidence retained');
  return candidates.sort(better)[0]!.board;
}
