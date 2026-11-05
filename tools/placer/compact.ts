// Compaction mode (easy to hard): place with large routing halos, route, shrink the halos while it routes.
//
// Pure core (no pcbnew, no network): the shrink/bisect schedule, the verdict and the step loop. The halo and area model
// is in compact-geometry.ts, the rank of the passing steps in compact-rank.ts. The driver runs search and routing.
import { now } from '../lib/lean-clock.ts';
import { fixed, Float, floatRepr, number, PyError, pyStr } from '../lib/py-compat.mjs';
import { round } from '../lib/py-numbers.ts';
import { bareScale, blockBoxSum, boardScale, deepCopy, type Num, outlineS, type Pose, type Problem, sFit, virtual, withHalos } from './compact-geometry.ts';
import { choose, lengthStop, type Measure, minBy, type Rank } from './compact-rank.ts';

export * from './compact-geometry.ts';
export * from './compact-rank.ts';

export const REAL_S = [1.0, 0.5, 0.25, 0.0];   // real phase: halo scales tried on the real outline, the largest first
export const GROW = 1.15;                      // an illegal search result: same s again on a 15 % larger virtual board,
export const TRIES = 3;                        // up to 3 tries
export const K_TOL = 0.02;                     // the outline phase stops when the board scale gap is below 2 %
const REAL_K_TOL = 1e-9;
const SCHEDULE_DONE = 'schedule done';
const LENGTH_STOP = 'length stop';

type Dict = Record<string, unknown>;
type Maybe<T> = T | Promise<T>;

/** A stage ran out of time. The placement and routing effects throw it; a step that gets it fails with status timeout. */
export class TimeoutExpired extends Error {
  readonly command: unknown;
  readonly seconds: number;
  constructor(command: unknown, seconds: number) {
    super(`Command ${pyStr(command)} timed out after ${seconds} seconds`);
    this.command = command;
    this.seconds = seconds;
  }
}

/** s0 first; on a pass shrink by `shrink` until the first fail, then bisect between the last pass and the last fail.
 *  Done when the gap is below tol of the pass value, at sMin, or at a fail with no pass. */
export class Schedule {
  s: number;
  best: number | null = null;   // smallest passing s
  fail: number | null = null;   // largest failing s below best
  done = false;
  readonly shrink: number;
  readonly tol: number;
  readonly sMin: number;

  constructor(s0: number, shrink = 0.85, tol = 0.05, sMin = 0.05) {
    this.s = s0;
    this.shrink = shrink;
    this.tol = tol;
    this.sMin = sMin;
  }

  report(passed: boolean): void {
    if (passed) this.best = this.s;
    else this.fail = this.s;
    const next = this.next();
    if (next === null || next < this.sMin) this.done = true;
    else this.s = next;
  }

  private next(): number | null {
    if (this.best === null) return null;
    if (this.fail === null) return this.s * this.shrink;
    return (this.best - this.fail) / this.best < this.tol ? null : (this.best + this.fail) / 2;
  }
}

export interface StepSummary { s: number; k: number; unrouted: number; passed: boolean }

/** `steps` in run order; `size` is the real board in mm. */
export function verdict(steps: StepSummary[], size: readonly number[]): string {
  if (!steps.length) return 'no step ran (time budget?)';
  const ok = steps.filter(t => t.passed);
  if (!ok.length) return noPassVerdict(steps[0]);
  const real = ok.filter(t => t.k <= 1 + REAL_K_TOL);
  if (real.length) {
    const t = minBy(real, row => [row.s]);
    return `fits in ${fixed(size[0], 1)} x ${fixed(size[1], 1)} mm at halo scale s = ${fixed(t.s, 2)} (unrouted ${t.unrouted})`;
  }
  const t = minBy(ok, row => [row.k]);
  return `needs ${fixed(size[0] * t.k, 1)} x ${fixed(size[1] * t.k, 1)} mm (board scale ${fixed(t.k, 3)}) at halo scale s = ${fixed(t.s, 2)}; it does not route on the real outline`;
}

function noPassVerdict(t: StepSummary): string {
  if (t.unrouted < 0) {
    return `no legal placement at the largest halo scale s = ${fixed(t.s, 2)} (board scale ${fixed(t.k, 2)}): lower --s0 or give the search more steps`;
  }
  return `does not route fully even at the largest halo scale s = ${fixed(t.s, 2)} (unrouted ${t.unrouted}): the cause is not established; inspect congestion, pin escape and effective rules`;
}

const KNOWN_FINDINGS = new Set(['native_open', 'escape_failure', 'model_enclosed', 'router_miss', 'no_routing_defect']);
const FEEDBACK_ACTIONS = new Set(['inspect_escape', 'diagnose_selected_connections']);

export interface OutcomeOptions { candidate?: unknown; geometryFeedback?: boolean; scopedSkippedOpens?: boolean; measure?: Measure | null }

/** Counts plus a diagnostic handoff. A clean routing-step count may advance the schedule. A failed route may advance only
 *  when its driver has attributed a concrete bounded geometry update. This is routing-search evidence, never a configured
 *  gate or qualification. */
export class RouteOutcome {
  readonly counts: number[];
  readonly decision: Dict;
  readonly candidate: unknown;
  readonly routingStepClean: boolean;
  readonly stop: boolean;
  readonly measure: Measure | null;

  constructor(counts: number[], decision: Dict, { candidate = null, geometryFeedback = false, scopedSkippedOpens = false, measure = null }: OutcomeOptions = {}) {
    this.counts = [...counts];
    this.decision = deepCopy(decision);
    this.candidate = deepCopy(candidate);
    this.measure = measure;
    const kinds = new Set(((decision.findings ?? []) as Dict[]).map(row => row.classification));
    const only = (kind: string) => kinds.size === 1 && kinds.has(kind);
    const known = decision.status === 'diagnosed' && kinds.size > 0 && [...kinds].every(kind => KNOWN_FINDINGS.has(kind as string));
    const complete = only('no_routing_defect') && decision.action === 'continue_native_validation';
    const scoped = scopedSkippedOpens && only('native_open') && decision.action === 'diagnose_selected_connections';
    this.routingStepClean = counts.length > 0 && Math.min(...counts) === 0 && known && (complete || scoped);
    const feedback = geometryFeedback && known && FEEDBACK_ACTIONS.has(decision.action as string);
    this.stop = !(this.routingStepClean || feedback);
  }
}

/** Router counts plus the copper measured on the routed board of the step (a driver with a measure, for example
 *  iotroute: iotroute run counts the tracks and vias of the saved board). */
export class Measured {
  readonly counts: number[];
  readonly measure: Measure | null;
  constructor(counts: number[], measure: Measure | null = null) {
    this.counts = [...counts];
    this.measure = measure && Object.keys(measure).length ? { ...measure } : null;
  }
}

export interface Candidate { pose: Pose | null; cost: Num; illegal: string[]; [key: string]: unknown }
export interface SearchResult { candidates: Candidate[]; history?: unknown[]; [key: string]: unknown }
export type RouteResult = number[] | RouteOutcome | Measured;

/** The injected work of a step. search gets the virtual problem; null is no result (a remote timeout), a failed step. */
export interface Effects {
  search(problem: Problem, step: number): Maybe<SearchResult | null | undefined>;
  write(problem: Problem, pose: Pose, k: number, step: number): Maybe<string>;
  route(board: string, step: number): Maybe<RouteResult>;
}

export interface LoopOptions {
  s0?: number; budget?: number; clock?: () => number; target?: number; shrink?: number; tol?: number;
  log?: ((line: string) => void) | null; sMin?: number; realFirst?: boolean; diagnosticBudget?: number | null;
  kCap?: number | null; rank?: Rank; lengthPatience?: number | null;
}

export interface Step {
  s: number; k: number; tries: number; cost: Num | null; illegal: string[]; phase: string; history: unknown[]; pose: Pose | null;
  halo: Num[]; runs: number[]; unrouted: number | null; passed: boolean; board: string | null; status?: string;
  measure?: Measure; box_sum?: Num | null; route_decision?: Dict; routed_candidate?: unknown; next_action?: unknown;
}

export interface LoopResult {
  steps: Step[]; best: Step | null; best_step: number | null; best_reason: string; rank: Rank; verdict: string; stop: string;
  next_action: unknown; retained_candidate: unknown; qualified: false;
}

const noRoute = () => ({ runs: [] as number[], unrouted: null, passed: false });

const NO_RESULT: SearchResult = { candidates: [{ pose: null, cost: new Float(NaN), illegal: ['no search result'] }] };

/** %.1f: 'nan' and 'inf' too, which a search with no result reports. */
const cost1 = (value: number): string => (Number.isFinite(value) ? fixed(value, 1) : floatRepr(value));

function smallest(values: number[]): number {
  if (!values.length) throw new PyError('ValueError', 'min() arg is an empty sequence');
  return Math.min(...values);
}

function boxSum(pr: Problem, pose: Pose): Float | null {
  try {
    return new Float(round(blockBoxSum(pr, pose), 1));
  } catch (error) {
    if (error instanceof TypeError || error instanceof PyError) return null;
    throw error;
  }
}

function terminalStop(result: Step): string | null {
  if (result.status === 'routing-decision') return `routing diagnosis: ${result.route_decision?.action ?? 'inspect_evidence'}`;
  return null;
}

interface Placed { k: number; tries: number; res: SearchResult; candidate: Candidate }

class Loop {
  readonly steps: Step[] = [];
  readonly clock: () => number;
  readonly started: number;
  budget: number;
  private readonly pr: Problem;
  private readonly size: readonly number[];
  private readonly effects: Effects;
  private readonly target: number;
  private readonly log: ((line: string) => void) | null;
  private readonly rank: Rank;

  constructor(pr: Problem, size: readonly number[], effects: Effects, options: LoopOptions) {
    this.pr = pr;
    this.size = size;
    this.effects = effects;
    this.clock = options.clock ?? now;
    this.started = this.clock();
    this.budget = options.budget ?? 2700;
    this.target = options.target ?? 0;
    this.log = options.log ?? null;
    this.rank = options.rank ?? 'halo';
  }

  over(): boolean {
    return this.clock() - this.started >= this.budget;
  }

  budgetStop(): string {
    return `time budget ${fixed(this.budget, 0)} s`;
  }

  passed(): Step[] {
    return this.steps.filter(t => t.passed);
  }

  async step(s: number, firstK: number, grow: boolean, phase: string): Promise<Step> {
    const n = this.steps.length;
    const q = withHalos(this.pr, s);
    const placed = await this.place(q, s, firstK, grow, phase, n);
    if (!('candidate' in placed)) {
      this.steps.push(placed);
      return placed;
    }
    const { k, tries, res, candidate } = placed;
    const t = {
      s, k, tries, cost: candidate.cost, illegal: candidate.illegal, phase, history: res.history ?? [], pose: candidate.pose,
      halo: q.units.map(unit => (unit.rects.length ? unit.rects[0][4] : new Float(0))),
    } as Step;
    if (candidate.illegal.length) Object.assign(t, noRoute(), { board: null });
    else await this.routed(t, q, candidate.pose as Pose, n);
    this.steps.push(t);
    this.report(t, n);
    return t;
  }

  /** Search, on a board that grows while the result is illegal. A timed out search is a finished failed step. */
  private async place(q: Problem, s: number, firstK: number, grow: boolean, phase: string, n: number): Promise<Placed | Step> {
    let k = firstK;
    for (let tries = 1; ; tries++) {
      let res: SearchResult | null | undefined;
      try {
        res = await this.effects.search(virtual(q, k), n);
      } catch (error) {
        if (!(error instanceof TimeoutExpired)) throw error;
        return {
          s, k, tries, cost: null, illegal: ['placement deadline'], phase, history: [], pose: null, halo: [], ...noRoute(), board: null,
          status: 'timeout',
        };
      }
      if (res === null || res === undefined) return { k, tries, res: NO_RESULT, candidate: deepCopy(NO_RESULT.candidates[0]) };
      const candidate = res.candidates[0];
      if (!candidate.illegal.length || !grow || tries === TRIES || this.over()) return { k, tries, res, candidate };
      k *= GROW;
    }
  }

  private async routed(t: Step, q: Problem, pose: Pose, n: number): Promise<void> {
    t.board = await this.effects.write(q, pose, t.k, n);
    try {
      if (this.over()) throw new TimeoutExpired('routing', 0);
      this.record(t, q, pose, await this.effects.route(t.board, n));
    } catch (error) {
      if (error instanceof TimeoutExpired) Object.assign(t, noRoute(), { status: 'timeout' });
      else throw error;
    }
  }

  private record(t: Step, q: Problem, pose: Pose, outcome: RouteResult): void {
    t.runs = Array.isArray(outcome) ? [...outcome] : [...outcome.counts];
    t.unrouted = smallest(t.runs);
    t.passed = t.unrouted <= this.target;
    if (!Array.isArray(outcome) && outcome.measure) {
      t.measure = outcome.measure;
      t.box_sum = boxSum(q, pose);
    }
    if (!(outcome instanceof RouteOutcome)) return;
    t.route_decision = outcome.decision;
    t.routed_candidate = outcome.candidate;
    t.passed = t.passed && outcome.routingStepClean;
    if (outcome.stop) Object.assign(t, { status: 'routing-decision', passed: false, next_action: outcome.decision });
  }

  private report(t: Step, n: number): void {
    if (!this.log) return;
    const copper = t.measure ? ` length ${pyStr(t.measure.length_mm)} mm vias ${pyStr(t.measure.vias)} box ${pyStr(t.box_sum)} mm2` : '';
    this.log(`step ${n} ${t.phase} s ${fixed(t.s, 3)} k ${fixed(t.k, 3)} cost ${cost1(number(t.cost))} illegal ${t.illegal.length} runs ${pyStr(t.runs)} -> ${t.passed ? 'PASS' : 'FAIL'}${copper}`);
  }

  finish(stop: string): LoopResult {
    const summary = this.steps.map(({ s, k, unrouted, passed }) => ({ s, k, unrouted: unrouted ?? -1, passed }));
    const handoff = this.steps.findLast(t => t.status === 'routing-decision');
    const [best, reason] = choose(this.steps, this.rank);
    return {
      steps: this.steps, best, best_step: best ? this.steps.indexOf(best) : null, best_reason: reason, rank: this.rank,
      verdict: handoff ? stop : verdict(summary, this.size), stop,
      next_action: handoff?.next_action ?? null, retained_candidate: handoff?.routed_candidate ?? null, qualified: false,
    };
  }
}

/** The area model (fill 0.5) is conservative: DOOR-RELAY and MC-MAIN give sFit(k = 1) = 0, but a search on the real outline
 *  is legal. So the real phase tries a short list of halo scales, the largest first, and keeps the first legal placement
 *  that routes. An illegal or failed step goes to the next smaller s. */
async function realPhase(loop: Loop, pr: Problem, s0: number, sMin: number): Promise<string> {
  const first = sFit(pr, 1, s0);
  const scales = [...(first >= sMin ? [first] : []), ...REAL_S.filter(s => s < Math.max(first, sMin) || first < sMin)];
  for (const s of scales) {
    if (loop.over()) return loop.budgetStop();
    const result = await loop.step(s, 1, false, 'real');
    const stop = terminalStop(result);
    if (stop) return stop;
    if (result.passed) break;
  }
  return SCHEDULE_DONE;
}

async function haloPhase(loop: Loop, pr: Problem, schedule: Schedule, kCap: number | null, patience: number | null): Promise<string> {
  while (!schedule.done) {
    if (loop.over()) return loop.budgetStop();
    const k = boardScale(withHalos(pr, schedule.s));
    const result = await loop.step(schedule.s, kCap === null ? k : Math.min(k, kCap), kCap === null, 'halo');
    const stop = terminalStop(result);
    if (stop) return stop;
    schedule.report(result.passed);
    if (result.passed && !schedule.done && lengthStop(loop.steps, patience)) {
      const best = choose(loop.steps, 'length')[0] as Step;
      return `${LENGTH_STOP}: the ${patience} passing steps after step ${loop.steps.indexOf(best)} (s ${fixed(best.s, 3)}, ${pyStr(best.measure?.length_mm)} mm) rank after it`;
    }
  }
  return SCHEDULE_DONE;
}

/** The real board (k = 1) first, when the bare parts fit it, then bisect k between the last fail and the best pass. */
async function outlinePhase(loop: Loop, pr: Problem, stop: string): Promise<string> {
  const best = minBy(loop.passed(), t => [t.k, t.s]);
  const floor = bareScale(pr);
  let [high, low] = [best.k, Math.max(1, floor)];
  let k = floor < 1 ? 1 : (low + high) / 2;
  while (high > 1 + REAL_K_TOL && (high - low) / high >= K_TOL) {
    if (loop.over()) return loop.budgetStop();
    const t = await loop.step(outlineS(pr, k, best, floor), k, false, 'outline');
    const terminal = terminalStop(t);
    if (terminal) return terminal;
    if (t.passed) high = k;
    else low = k;
    k = (low + high) / 2;
  }
  return stop;
}

/** Easy-to-hard loop. search, write and route are the injected effects; route gives counts, a Measured or a RouteOutcome.
 *  Halo phase: s from s0, board scale k from the grown area (larger on an illegal result). A step passes when the best
 *  router run leaves <= target unrouted. Outline phase (when the best pass has k > 1): the real board (k = 1) first, then
 *  bisect k between the last fail and the best pass; s = outlineS. When the bare parts do not fit the real board
 *  (bareScale > 1), the bisection starts between bareScale and the best pass. Stops when both phases are done or when
 *  `budget` seconds have passed before a step starts.
 *  kCap (2026-11-01): the halo phase uses at most this board scale and does not grow it (kCap 1: every step on the real
 *  outline). Reason: a rigid block counts its whole border box in the area model, so NET-CORE with its spread blocks got
 *  k 1.02-1.05 at every halo, and a virtual-board step is not a candidate for the real board.
 *  realFirst (2026-10-03): a real phase goes first. It places on the real outline (k = 1) with the largest halo that gives
 *  a legal placement (sFit, then REAL_S) and routes it. The first step that routes ends the loop (no virtual board). If no
 *  step routes, the halo and outline phases follow and tell how much larger the board must be.
 *  Reason: DOOR-RELAY routed on its real outline, but the virtual phases said that it needs 112 x 80 mm; on a virtual board
 *  the fixed connectors stay at their places, so the added area is an empty band.
 *  diagnosticBudget: the seconds the low-density and virtual diagnostics get after the real phase. */
export async function runLoop(pr: Problem, size: readonly number[], effects: Effects, options: LoopOptions = {}): Promise<LoopResult> {
  const { s0 = 4.0, shrink = 0.85, tol = 0.05, sMin = 0.05, realFirst = false, diagnosticBudget = null, kCap = null, lengthPatience = null } = options;
  const loop = new Loop(pr, size, effects, options);
  if (realFirst) {
    const stop = await realPhase(loop, pr, s0, sMin);
    if (loop.passed().length || stop !== SCHEDULE_DONE) return loop.finish(stop);
  }
  if (diagnosticBudget !== null) loop.budget = Math.min(loop.budget, loop.clock() - loop.started + diagnosticBudget);
  let stop = await haloPhase(loop, pr, new Schedule(s0, shrink, tol, sMin), kCap, lengthPatience);
  if (loop.passed().length && (stop === SCHEDULE_DONE || stop.startsWith(LENGTH_STOP))) stop = await outlinePhase(loop, pr, stop);
  return loop.finish(stop);
}

/** A run for json.dump. s and k are floats in Python, so a whole value keeps its .0 in run.json. */
export function runJson(run: LoopResult): Dict {
  const step = (t: Step) => ({ ...t, s: new Float(t.s), k: new Float(t.k) });
  return { ...run, steps: run.steps.map(step), best: run.best && step(run.best) };
}
