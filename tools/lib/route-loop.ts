// Experimental, durable decision boundaries around ordinary supervised candidates.
// The CLI/Studio agent supplies a typed move; this module never executes model text.
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, isAbsolute } from 'node:path';
import { durableJson, durableAppend } from './pcb-check-durable.ts';

export type Fields = Record<string, unknown>;
export const LOOP_SCHEMA = 'iot-lab.route-loop.v1';
export const LOOP_TERMINAL = new Set(['passed', 'stopped', 'blocked', 'error', 'cancelled', 'expired']);
export type LoopOpenStatus = 'starting' | 'launching' | 'running' | 'stopping' | 'decision_required';
export type LoopStatus = LoopOpenStatus | 'passed' | 'stopped' | 'blocked' | 'error' | 'cancelled' | 'expired';
/** The open statuses and the open statuses each may become. Every open status may also become a terminal one; a terminal status has no next. */
export const LOOP_OPEN_NEXT: Record<LoopOpenStatus, readonly LoopOpenStatus[]> = {
  starting: ['launching'],
  launching: ['running', 'stopping', 'decision_required'],
  running: ['stopping', 'decision_required'],
  stopping: [],
  decision_required: ['launching']
};
export interface LoopPolicy {
  experimental: true;
  max_rounds: number;
  deadline_s: number;
  done_when: 'verified' | 'budget';
  route: Fields;
}
export interface LoopChild {
  id: string;
  folder: string;
}
export interface LoopEvidence {
  state: string;
  cleanup: boolean;
  receipt_sha256?: string;
  verified?: boolean;
  identity_preserved?: boolean;
  candidate?: string;
  search_candidate?: string;
  report_path?: string;
  wire_mm?: number;
  vias?: number;
  report?: Fields;
  report_sha256?: string;
  quality_unknown?: Fields;
  checkpoint?: { path: string; sha256: string; resumable: true };
  cause?: string;
  cpu_s?: number | null;
}
export interface LoopRound {
  round: number;
  launch_id: string;
  policy: Fields;
  child?: LoopChild;
  evidence?: LoopEvidence;
  decision?: LoopDecision;
  from?: LoopChild;
}
export interface LoopDecision {
  reason: string;
  move: Fields;
}
export interface LoopState {
  schema: typeof LOOP_SCHEMA;
  id: string;
  root: string;
  board: string;
  created_ms: number;
  deadline_ms: number;
  policy: LoopPolicy;
  source_sha256: string;
  binding_sha256: string;
  revision: number;
  status: LoopStatus;
  cause: string;
  created_clock_ms?: number;
  deadline_clock_ms?: number;
  rounds: LoopRound[];
  best_search: number | null;
  best_verified: number | null;
  decisions: { revision: number; sha256: string; reason: string; move: Fields }[];
  stop_requested?: 'cancelled' | 'expired';
}
export interface LoopBackend {
  source(root: string, board: string): string;
  validatePolicy(policy: Fields): void;
  start(state: LoopState, round: LoopRound, timeoutS: number): Promise<LoopChild>;
  recover(state: LoopState, round: LoopRound): LoopChild | null;
  inspect(state: LoopState, child: LoopChild): LoopEvidence;
  cancel(child: LoopChild): void;
  propose(
    state: LoopState,
    round: LoopRound,
    move: Fields
  ): Promise<{ status: string; cause?: string; policy?: Fields }>;
  lock<T>(path: string, work: () => Promise<T>): Promise<T>;
  now?: () => number;
  clock?: () => number;
}
const object = (v: unknown): v is Fields => !!v && typeof v === 'object' && !Array.isArray(v);
const stable = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(stable)
    : object(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, stable(v[k])])
        )
      : v;
export const loopHash = (v: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(stable(v)) ?? 'null')
    .digest('hex');
const now = (b: LoopBackend) => b.now?.() ?? Date.now();
const immutable = (s: LoopState) => ({
  schema: s.schema,
  id: s.id,
  root: s.root,
  board: s.board,
  created_ms: s.created_ms,
  deadline_ms: s.deadline_ms,
  created_clock_ms: s.created_clock_ms,
  deadline_clock_ms: s.deadline_clock_ms,
  policy: s.policy,
  source_sha256: s.source_sha256
});
const remainingMs = (s: LoopState, b: LoopBackend): number => {
  const wall = s.deadline_ms - now(b);
  if (!b.clock || s.created_clock_ms === undefined || s.deadline_clock_ms === undefined) return wall;
  const clock = b.clock();
  return clock < s.created_clock_ms ? 0 : Math.min(wall, s.deadline_clock_ms - clock);
};
const idOK = (id: string) => typeof id === 'string' && id.length === 21 && /^loop-[a-f0-9]{16}$/.test(id);
export function loopFolder(root: string, id: string): string {
  if (!idOK(id)) throw Error('Use the loop ID returned by start.');
  const base = join(realpathSync(root), '.gate', 'loops'),
    folder = join(base, id);
  // A loop store cannot be redirected outside the project by a symlink.
  let ancestor = folder;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  const rel = relative(realpathSync(root), realpathSync(ancestor));
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw Error('Loop folder leaves the project.');
  return folder;
}
function save(folder: string, s: LoopState, type: string): void {
  s.revision++;
  durableJson(join(folder, 'state.json'), s);
  durableAppend(
    join(folder, 'events.jsonl'),
    JSON.stringify({
      type,
      revision: s.revision,
      status: s.status,
      cause: s.cause,
      round: s.rounds.length,
      time_ms: Date.now()
    }) + '\n'
  );
}
function read(folder: string, root: string): LoopState {
  const s = JSON.parse(readFileSync(join(folder, 'state.json'), 'utf8')) as LoopState;
  if (
    s.schema !== LOOP_SCHEMA ||
    s.root !== realpathSync(root) ||
    !idOK(s.id) ||
    s.id !== basename(folder) ||
    s.binding_sha256 !== loopHash(immutable(s)) ||
    !(s.status in LOOP_OPEN_NEXT || LOOP_TERMINAL.has(s.status)) ||
    !Number.isSafeInteger(s.revision) ||
    s.rounds.length > s.policy.max_rounds
  )
    throw Error('Loop state or its source binding changed.');
  return s;
}
export function validateLoopPolicy(value: unknown, b: LoopBackend): LoopPolicy {
  if (JSON.stringify(value).length > 65536) throw Error('Loop policy exceeds 64 KiB.');
  if (
    !object(value) ||
    Object.keys(value).some((k) => !['experimental', 'max_rounds', 'deadline_s', 'done_when', 'route'].includes(k))
  )
    throw Error('Loop policy has unknown fields.');
  if (value.experimental !== true)
    throw Error('Enable the experimental routing loop explicitly. Benchmarks have not shown a speed advantage.');
  const p = {
    experimental: true,
    max_rounds: value.max_rounds ?? 3,
    deadline_s: value.deadline_s ?? 900,
    done_when: value.done_when ?? 'verified',
    route: value.route
  } as LoopPolicy;
  if (!Number.isSafeInteger(p.max_rounds) || p.max_rounds < 1 || p.max_rounds > 8) throw Error('Choose 1 to 8 rounds.');
  if (!Number.isSafeInteger(p.deadline_s) || p.deadline_s < 30 || p.deadline_s > 7200)
    throw Error('Choose a total time limit from 30 to 7200 seconds.');
  if (!['verified', 'budget'].includes(p.done_when) || !object(p.route))
    throw Error('Provide a routing policy and a verified or budget stop rule.');
  b.validatePolicy(p.route);
  return p;
}
/** The only writer of `status`. A terminal loop never becomes active again, and an open status takes only the steps in LOOP_OPEN_NEXT. */
function move(s: LoopState, next: LoopStatus): void {
  const open = s.status in LOOP_OPEN_NEXT ? LOOP_OPEN_NEXT[s.status as LoopOpenStatus] : null;
  if (!open || !(s.status === next || LOOP_TERMINAL.has(next) || open.includes(next as LoopOpenStatus)))
    throw Error(`Loop ${s.id} cannot change from ${s.status} to ${next}.`);
  s.status = next;
}
function stop(folder: string, s: LoopState, status: LoopStatus, cause: string): LoopState {
  move(s, status);
  s.cause = cause;
  save(folder, s, 'loop.end');
  return s;
}
function score(e: LoopEvidence): number[] {
  const r = e.report ?? {};
  return [
    Number(r.parity ?? Infinity),
    Number(r.drc_errors ?? Infinity),
    Number(r.unconnected ?? Infinity),
    Number(e.wire_mm ?? Infinity),
    Number(e.vias ?? Infinity)
  ];
}
const less = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]!;
  }
  return false;
};
function failureKey(e: LoopEvidence): string {
  const r = e.report ?? {};
  return loopHash({
    cause: e.cause ?? '',
    nets: r.open_nets ?? [],
    rows: r.rows ?? [],
    drc_errors: r.drc_errors,
    unconnected: r.unconnected,
    parity: r.parity,
    unknown: r.unknown
  });
}
async function reconcile(folder: string, s: LoopState, b: LoopBackend): Promise<LoopState> {
  if (LOOP_TERMINAL.has(s.status)) return s;
  const last = s.rounds.at(-1);
  if (s.status === 'starting' && !last)
    return stop(folder, s, 'blocked', 'Loop admission was interrupted before its first launch. No round was repeated.');
  if (s.status === 'launching' && last && !last.child) {
    const recovered = b.recover(s, last);
    if (!recovered)
      return stop(
        folder,
        s,
        'blocked',
        'A round launch was interrupted. Inspect its recorded launch before starting another loop.'
      );
    last.child = recovered;
    move(s, 'running');
    save(folder, s, 'loop.recovered');
  }
  if (b.source(s.root, s.board) !== s.source_sha256) {
    if (last?.child) b.cancel(last.child);
    s.stop_requested = 'cancelled';
    s.cause = 'Source inputs changed. No further rounds may start.';
  }
  if (remainingMs(s, b) <= 0 && !s.stop_requested) {
    s.stop_requested = 'expired';
    s.cause = 'Total loop time limit reached.';
    if (last?.child) b.cancel(last.child);
  }
  if (last?.child && (!last.evidence || ['running', 'stopping', 'launching'].includes(s.status))) {
    const evidence = b.inspect(s, last.child);
    if (!['passed', 'failed', 'error', 'cancelled', 'timeout'].includes(evidence.state)) {
      if (s.stop_requested && s.status !== 'stopping') {
        move(s, 'stopping');
        save(folder, s, 'loop.stopping');
      }
      return s;
    }
    if (last.evidence?.receipt_sha256 && last.evidence.receipt_sha256 !== evidence.receipt_sha256)
      return stop(folder, s, 'error', 'A recorded round receipt changed.');
    last.evidence = evidence;
    if (!evidence.cleanup)
      return stop(folder, s, 'error', 'Child cleanup or its terminal receipt is unconfirmed. Review the recorded run.');
    if (evidence.verified && evidence.identity_preserved && evidence.state === 'passed') {
      if (!evidence.receipt_sha256 || !evidence.candidate)
        return stop(folder, s, 'error', 'The verified candidate is missing its bound receipt.');
      const old = s.best_verified === null ? undefined : s.rounds[s.best_verified - 1]?.evidence;
      const complete = (e: LoopEvidence) =>
        typeof e.wire_mm === 'number' &&
        Number.isFinite(e.wire_mm) &&
        e.wire_mm >= 0 &&
        Number.isSafeInteger(e.vias) &&
        e.vias! >= 0;
      if (
        !old ||
        (complete(evidence) && complete(old) && less([evidence.wire_mm!, evidence.vias!], [old.wire_mm!, old.vias!]))
      )
        s.best_verified = last.round;
    }
    if (evidence.report) {
      const old = s.best_search === null ? undefined : s.rounds[s.best_search - 1]?.evidence;
      if (!old || less(score(evidence), score(old))) s.best_search = last.round;
    }
    save(folder, s, 'loop.round.end');
    if (s.stop_requested) return stop(folder, s, s.stop_requested, s.cause);
    if (s.best_verified !== null && s.policy.done_when === 'verified')
      return stop(folder, s, 'passed', 'A candidate passed the complete fresh gate. Review it before adoption.');
    if (evidence.state !== 'passed' && evidence.state !== 'failed')
      return stop(folder, s, 'blocked', evidence.cause ?? 'The round did not finish with usable evidence.');
    if (!evidence.verified && !evidence.report)
      return stop(folder, s, 'blocked', 'The failed round has no bound stuck report. Diagnose it before retrying.');
    if (Number(evidence.report?.parity ?? 0) > 0)
      return stop(folder, s, 'blocked', 'Resolve schematic parity before another routing round.');
    if (
      !evidence.verified &&
      s.rounds.filter((r) => r.evidence && !r.evidence.verified && failureKey(r.evidence) === failureKey(evidence))
        .length >= 2
    )
      return stop(
        folder,
        s,
        s.best_verified === null ? 'blocked' : 'passed',
        'The same failure cause occurred twice. No unchanged retry was launched.'
      );
    if (s.rounds.length >= s.policy.max_rounds)
      return stop(
        folder,
        s,
        s.best_verified === null ? 'stopped' : 'passed',
        'Round limit reached. Verified and search results remain separate.'
      );
    move(s, 'decision_required');
    s.cause = 'Choose a validated move or stop, and record the reason.';
    save(folder, s, 'loop.decision_required');
  } else if (s.stop_requested) return stop(folder, s, s.stop_requested, s.cause);
  return s;
}
async function launch(
  folder: string,
  s: LoopState,
  b: LoopBackend,
  policy: Fields,
  from?: LoopChild,
  decision?: LoopState['decisions'][number]
): Promise<LoopState> {
  // Memory only until the first save below: a launch that throws first leaves no decision record.
  if (decision) s.decisions.push(decision);
  const remaining = Math.floor(remainingMs(s, b) / 1000) - 8;
  if (remaining < 10)
    return stop(
      folder,
      s,
      s.best_verified === null ? 'expired' : 'passed',
      'Too little time remains to start and clean up another round.'
    );
  const route: Fields = { ...policy };
  if (object(route.sprints)) {
    const minimum = Math.max(
      30,
      Number(route.sprints.verify_reserve_s ?? Math.min(30, Number(route.sprints.deadline_s ?? 120) / 2)) + 10
    );
    if (remaining < minimum)
      return stop(
        folder,
        s,
        s.best_verified === null ? 'expired' : 'passed',
        'Too little time remains for another sprint.'
      );
    route.sprints = { ...route.sprints, deadline_s: Math.min(Number(route.sprints.deadline_s ?? 120), remaining) };
    delete route.max_time_s;
  } else route.max_time_s = Math.min(Number(policy.max_time_s ?? 120), Math.max(1, remaining - 10));
  b.validatePolicy(route);
  const round: LoopRound = {
    round: s.rounds.length + 1,
    launch_id: randomBytes(12).toString('hex'),
    policy: route,
    ...(from ? { from } : {}),
    ...(decision ? { decision: { reason: decision.reason, move: decision.move } } : {})
  };
  s.rounds.push(round);
  move(s, 'launching');
  s.cause = 'Starting a supervised candidate round.';
  save(folder, s, 'loop.round.intent');
  try {
    round.child = await b.start(s, round, remaining);
  } catch (e) {
    s.cause = `Round launch needs recovery: ${e instanceof Error ? e.message : String(e)}`;
    save(folder, s, 'loop.launch_uncertain');
    throw e;
  }
  move(s, 'running');
  s.cause = `Round ${round.round} is running.`;
  save(folder, s, 'loop.round.start');
  return s;
}
export async function startLoop(rootPath: string, board: string, value: unknown, b: LoopBackend): Promise<LoopState> {
  const root = realpathSync(rootPath),
    policy = validateLoopPolicy(value, b);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(board)) throw Error('Choose a board gate name.');
  const source = b.source(root, board),
    id = 'loop-' + randomBytes(8).toString('hex'),
    folder = loopFolder(root, id);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const created = now(b),
    clock = b.clock?.();
  const s: LoopState = {
    schema: LOOP_SCHEMA,
    id,
    root,
    board,
    created_ms: created,
    deadline_ms: created + policy.deadline_s * 1000,
    ...(clock === undefined ? {} : { created_clock_ms: clock, deadline_clock_ms: clock + policy.deadline_s * 1000 }),
    policy,
    source_sha256: source,
    binding_sha256: '',
    revision: 0,
    status: 'starting',
    cause: 'Experimental loop enabled.',
    rounds: [],
    best_search: null,
    best_verified: null,
    decisions: []
  };
  s.binding_sha256 = loopHash(immutable(s));
  // The first state is saved under the controller lock: a status poll cannot reconcile a loop that is still starting.
  return b.lock(join(folder, 'controller.lock'), () => {
    save(folder, s, 'loop.start');
    return launch(folder, s, b, policy.route);
  });
}
export async function statusLoop(root: string, id: string, b: LoopBackend): Promise<LoopState> {
  const folder = loopFolder(root, id);
  return b.lock(join(folder, 'controller.lock'), () => reconcile(folder, read(folder, root), b));
}
export async function decideLoop(
  root: string,
  id: string,
  revision: number,
  value: unknown,
  b: LoopBackend
): Promise<LoopState> {
  if (
    !object(value) ||
    Object.keys(value).some((k) => !['reason', 'move'].includes(k)) ||
    typeof value.reason !== 'string' ||
    !value.reason.trim() ||
    value.reason.length > 2000 ||
    !object(value.move) ||
    typeof value.move.kind !== 'string'
  )
    throw Error('Provide one move and a reason of 1 to 2000 characters.');
  const decision = { reason: value.reason.trim(), move: value.move } as LoopDecision,
    hash = loopHash(decision),
    folder = loopFolder(root, id);
  return b.lock(join(folder, 'controller.lock'), async () => {
    const s = await reconcile(folder, read(folder, root), b);
    const old = s.decisions.find((d) => d.revision === revision);
    if (old) {
      if (old.sha256 !== hash) throw Error('A different decision already used this revision.');
      return s;
    }
    if (s.revision !== revision || s.status !== 'decision_required')
      throw Error('The loop changed. Read its current decision boundary.');
    const current = s.rounds.at(-1)!;
    // The decision is recorded in the same save as its action, after every check: a refused decision leaves no record.
    const recorded = { revision, sha256: hash, ...decision };
    if (decision.move.kind === 'stop') {
      if (Object.keys(decision.move).some((k) => k !== 'kind')) throw Error('Stop takes no additional fields.');
      s.decisions.push(recorded);
      return stop(folder, s, s.best_verified === null ? 'stopped' : 'passed', decision.reason);
    }
    if (decision.move.kind === 'ask_user') {
      if (
        Object.keys(decision.move).some((k) => !['kind', 'question'].includes(k)) ||
        typeof decision.move.question !== 'string' ||
        !decision.move.question.trim()
      )
        throw Error('Ask one clear question.');
      s.decisions.push(recorded);
      return stop(folder, s, 'blocked', decision.move.question);
    }
    const choice = s.best_search === null ? current : s.rounds[s.best_search - 1]!;
    if (!choice.child || !choice.evidence) throw Error('No retained candidate is available for this move.');
    const proposed = await b.propose(s, choice, decision.move);
    if (proposed.status === 'rejected') {
      s.decisions.push(recorded);
      move(s, 'decision_required');
      s.cause = proposed.cause ?? 'Move rejected. Choose another validated action or stop.';
      save(folder, s, 'loop.decision.rejected');
      return s;
    }
    if (proposed.status !== 'accepted' || !proposed.policy) {
      s.decisions.push(recorded);
      return stop(folder, s, 'blocked', proposed.cause ?? 'This move requires review outside the routing loop.');
    }
    const base = s.policy.route,
      next = proposed.policy;
    for (const key of new Set([...Object.keys(base), ...Object.keys(next)]))
      if (
        !['iters', 'max_time_s', 'layers', 'reuse', 'reuse_nets', 'sprints'].includes(key) &&
        loopHash(base[key]) !== loopHash(next[key])
      )
        throw Error(`Move changes the admitted ${key} policy.`);
    const allowedLayers = Array.isArray(base.layers) ? base.layers : [];
    if (allowedLayers.length && (!Array.isArray(next.layers) || next.layers.some((l) => !allowedLayers.includes(l))))
      throw Error('Move exceeds the admitted trace layers.');
    const allowed = Array.isArray(base.nets) ? base.nets : [];
    if (allowed.length && Array.isArray(next.reuse_nets) && next.reuse_nets.some((n) => !allowed.includes(n)))
      throw Error('Move exceeds the admitted net scope.');
    if (loopHash(next.sprints) !== loopHash(current.policy.sprints)) {
      const admitted = current.policy.sprints;
      if (
        decision.move.kind !== 'single_reuse' ||
        !object(admitted) ||
        next.sprints !== undefined ||
        Number(admitted.parallelism ?? 2) < 2 ||
        Number(admitted.mem_gb ?? 4) < 4
      )
        throw Error('A model decision cannot expand or silently change the admitted sprint resource policy.');
    }
    return launch(folder, s, b, next, choice.child, recorded);
  });
}
export async function cancelLoop(root: string, id: string, b: LoopBackend): Promise<LoopState> {
  const folder = loopFolder(root, id);
  return b.lock(join(folder, 'controller.lock'), async () => {
    const s = await reconcile(folder, read(folder, root), b);
    if (LOOP_TERMINAL.has(s.status)) return s;
    s.stop_requested = 'cancelled';
    s.cause = 'Loop cancelled. Retained candidates are available for review.';
    const last = s.rounds.at(-1);
    if (last?.child && !last.evidence) {
      b.cancel(last.child);
      move(s, 'stopping');
      save(folder, s, 'loop.stopping');
      return s;
    }
    return stop(folder, s, 'cancelled', s.cause);
  });
}
export function listLoops(root: string): LoopState[] {
  const base = join(realpathSync(root), '.gate', 'loops');
  try {
    return readdirSync(base)
      .filter((id) => idOK(id) && existsSync(join(base, id, 'state.json')))
      .map((id) => read(loopFolder(root, id), root))
      .sort((a, b) => b.created_ms - a.created_ms)
      .slice(0, 50);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}
