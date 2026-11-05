// Compaction driver: each step searches, writes a board copy and routes it. The schedule is compact.ts.
//
//   compact-cli.ts PROB.json BOARD.kicad_pcb --board-dir hardware-design/boards/X/cad/X --outdir DIR --size W H
//       [--s0 4] [--budget 2700] [--routes 1] [--target 0] ...
//
// PROB.json comes from `place.ts read` on BOARD (a copy with the signal tracks removed). Each step writes DIR/step-N/ (prob.json,
// search/, b/<board>.kicad_pcb, route-K/). DIR/run.json holds the problem, every step (s, k, router runs, epoch history, pose)
// and the verdict, for the viewer (viewer.ts).
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMain, UsageError } from '../lib/cli.ts';
import { checkManifest } from '../lib/engineering-constraints.ts';
import { iotplaceBin } from '../lib/iotplace-bin.ts';
import { atomicJson, readTyped, sha256File } from '../lib/json-file.ts';
import { now } from '../lib/lean-clock.ts';
import { defaultCpu, reserve } from '../lib/lean-resources.ts';
import { runStage as ownedStage, TimeoutExpired as StageTimeout, type StageResult } from '../lib/lean-stage.ts';
import { deadlineAfter, encodeDeadline } from '../lib/lean-workflow.ts';
import { iotrouteBin } from '../lib/iotroute-bin.ts';
import { snapshot } from '../lib/pcb-sources.ts';
import { Float, PyError, jsonDumps, number } from '../lib/py-compat.mjs';
import type { Dict } from '../lib/py-values.ts';
import { observeRoute, retryKey } from '../lib/route-decision.ts';
import { generateEscapeForCandidate } from '../lib/route-decision-escape.ts';
import { scatter } from './bench.ts';
import { writeBoard } from './board-io.ts';
import { LENGTH_PATIENCE, Measured, RANKS, RouteOutcome, runJson, runLoop, TimeoutExpired, deepCopy, type Num, type Pose, type Rank, type RouteResult, type SearchResult } from './compact.ts';
import { NO_RESULT, bestLine, routeHandoff, stepOutcome } from './compact-route.ts';
import { checkProblem, reviewServices, type ReviewedProblem } from './engineering-problem.ts';
import { GateWorkspace, boardId, measure, measureKey, routeStep, routerCpu } from './iotroute-step.ts';
import { parseOptions, parseParams, shellWords, type Parsed, type Spec } from './options.ts';
import { boundedFeedback, candidateReport, compareCandidates, identity, type AuditCandidate } from './placement-audit.ts';
import { better, copySidecars, run as runRepair, type Candidate } from './repair.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NODE = ['node', '--no-warnings', '--experimental-strip-types'];
const USAGE = 'usage: compact-cli.ts PROB.json BOARD.kicad_pcb --board-dir DIR --outdir DIR --size W H [options]';
const RESTRICTED_BY_SEEDED_POLICY = ['p_swap', 'p_rot', 'global', 'rotate', 'legal_rotate'];

const SPEC: Spec = {
  '--board-dir': 'text', '--outdir': 'text', '--size': 'words', '--search': 'text', '--s0': 'float', '--budget': 'float', '--target': 'int', '--routes': 'int',
  '--workers': 'int', '--epochs': 'int', '--steps': 'int', '--seed': 'int', '--retain-candidates': 'int', '--seeded-policy': 'switch',
  '--max-displacement': 'float', '--feedback-max-mm': 'float', '--congestion-feedback': 'switch', '--param': 'words', '--scatter': 'int', '--gnd-vias': 'switch',
  '--snapshots': 'text', '--router': 'text', '--passes': 'int', '--repair': 'switch', '--repair-mode': 'text', '--repair-rank': 'text', '--repair-routes': 'int',
  '--repair-per-round': 'int', '--read-args': 'text', '--diagnostic-budget': 'float', '--route-args': 'text', '--virtual-first': 'switch',
  '--max-routes': 'int', '--k-cap': 'float', '--shrink': 'float', '--tol': 'float', '--rank': 'text', '--length-patience': 'int',
};

export interface Args {
  prob: string; board: string; board_dir: string; outdir: string; size: [number, number]; search: string; s0: number; budget: number; target: number; routes: number;
  workers: number; epochs: number; steps: number; seed: number; retain_candidates: number; seeded_policy: boolean; max_displacement: number | null;
  feedback_max_mm: number; congestion_feedback: boolean; param: string[]; scatter: number | null; gnd_vias: boolean; snapshots: string | null; router: string;
  passes: number; repair: boolean; repair_mode: string; repair_rank: string; repair_routes: number; repair_per_round: number; read_args: string;
  diagnostic_budget: number | null; route_args: string; virtual_first: boolean; max_routes: number; k_cap: number | null; shrink: number; tol: number;
  rank: Rank | null; length_patience: number;
}

function choice(a: Parsed, name: string, allowed: readonly string[], fallback: string): string {
  const value = a.text(name) ?? fallback;
  if (!allowed.includes(value)) throw new UsageError(`${name}: invalid choice ${value} (choose from ${allowed.join(', ')})`);
  return value;
}

export function parseArgs(argv: readonly string[]): Args {
  const a = parseOptions(argv, SPEC, USAGE);
  const [prob, board] = a.positionals, boardDir = a.text('--board-dir'), outdir = a.text('--outdir');
  const size = a.words('--size').map(Number);
  if (a.positionals.length !== 2 || !boardDir || !outdir || size.length !== 2 || size.some(Number.isNaN)) throw new UsageError(USAGE);
  return {
    prob: prob as string, board: board as string, board_dir: boardDir, outdir, size: size as [number, number],
    search: choice(a, '--search', ['local', 'remote'], 'local'), s0: a.float('--s0') ?? 4, budget: a.float('--budget') ?? 2700, target: a.int('--target') ?? 0,
    routes: a.int('--routes') ?? 1, workers: a.int('--workers') ?? defaultCpu(), epochs: a.int('--epochs') ?? 20, steps: a.int('--steps') ?? 12000, seed: a.int('--seed') ?? 1,
    retain_candidates: a.int('--retain-candidates') ?? 1, seeded_policy: a.has('--seeded-policy'), max_displacement: a.float('--max-displacement') ?? null,
    feedback_max_mm: a.float('--feedback-max-mm') ?? 1, congestion_feedback: a.has('--congestion-feedback'), param: [...a.words('--param')], scatter: a.int('--scatter') ?? null,
    gnd_vias: a.has('--gnd-vias'), snapshots: a.text('--snapshots') ?? null, router: choice(a, '--router', ['iotroute'], 'iotroute'),
    passes: a.int('--passes') ?? 40, repair: a.has('--repair'), repair_mode: choice(a, '--repair-mode', ['reuse', 'local', 'full'], 'reuse'),
    repair_rank: choice(a, '--repair-rank', ['term', 'hot'], 'term'), repair_routes: a.int('--repair-routes') ?? 8, repair_per_round: a.int('--repair-per-round') ?? 4,
    read_args: a.text('--read-args') ?? '', diagnostic_budget: a.float('--diagnostic-budget') ?? null,
    route_args: a.text('--route-args') ?? '', virtual_first: a.has('--virtual-first'), max_routes: a.int('--max-routes') ?? 0, k_cap: a.float('--k-cap') ?? null,
    shrink: a.float('--shrink') ?? 0.85, tol: a.float('--tol') ?? 0.05, rank: a.has('--rank') ? choice(a, '--rank', RANKS, 'halo') as Rank : null,
    length_patience: a.int('--length-patience') ?? LENGTH_PATIENCE,
  };
}

/** Checks the options and derives what they imply. Runs before anything is read or started. */
export function settle(a: Args): void {
  if (!Number.isFinite(a.budget) || a.budget <= 0) throw new Error('budget must be positive');
  if (a.routes < 1) throw new Error('--routes must be 1 or more');
  if (a.diagnostic_budget !== null && (!Number.isFinite(a.diagnostic_budget) || a.diagnostic_budget < 0)) throw new Error('diagnostic budget must be finite and nonnegative');
  if (a.retain_candidates < 1 || a.retain_candidates > 8) throw new Error('retain-candidates must be 1..8');
  if (!Number.isFinite(a.feedback_max_mm) || a.feedback_max_mm < 0 || a.feedback_max_mm > 2) throw new Error('feedback cap must be finite, 0..2mm');
  if (a.max_displacement !== null && (!Number.isFinite(a.max_displacement) || a.max_displacement <= 0)) throw new Error('displacement cap must be finite and positive');
  if (a.seeded_policy) {
    const params = parseParams(a.param);
    if (a.scatter !== null || RESTRICTED_BY_SEEDED_POLICY.some(name => params[name])) throw new Error('seeded policy prohibits scatter, global placement, swaps and turns');
    a.param.push('p_swap=0', 'p_rot=0', 'legal_rotate=0');
  }
  if (a.max_displacement !== null) {
    if (!a.seeded_policy) throw new Error('displacement cap requires seeded policy');
    a.param.push(`max_displacement=${a.max_displacement}`);
  }
  a.rank ??= 'length';
  if (a.length_patience < 0) throw new Error('--length-patience must be 0 or more');
}

const isTimeout = (error: unknown): boolean => error instanceof StageTimeout || (error instanceof PyError && error.type === 'TimeoutError');

function routeThreads(a: Args): number | null {
  const words = shellWords(a.route_args);
  let threads: number | null = null;
  words.forEach((word, i) => {
    const value = word === '--threads' ? words[i + 1] : word.startsWith('--threads=') ? word.slice('--threads='.length) : undefined;
    if (value !== undefined) threads = Number(value) || defaultCpu();
  });
  return threads;
}

/** One compaction run: the effects the schedule calls. */
export class Compaction {
  readonly a: Args;
  readonly problem: ReviewedProblem;
  deadline: number;
  readonly events: string;
  readonly name: string;
  readonly escapeHint: Record<string, number> = {};
  readonly attempts = new Map<string, Dict>();
  readonly gate: GateWorkspace;
  readonly iotrouteBoard: string;
  routesDone = 0;
  diagnosticStarted = false;
  services = reviewServices;
  generateEscape: (root: string, board: string, candidate: string, output: string) => unknown = generateEscapeForCandidate;
  checkManifest: typeof checkManifest = checkManifest;

  constructor(a: Args, problem: ReviewedProblem, deadline: number) {
    this.a = a;
    this.problem = problem;
    this.deadline = deadline;
    this.events = join(a.outdir, 'stages.jsonl');
    this.name = basename(a.board, extname(a.board));
    this.iotrouteBoard = boardId(a.board_dir);
    this.gate = new GateWorkspace(a.outdir, this.iotrouteBoard, snapshot);
  }

  stepDir(n: number): string {
    const folder = join(resolve(this.a.outdir), `step-${n}`);
    mkdirSync(folder, { recursive: true });
    return folder;
  }

  private stageCpu(stage: string): number {
    if (stage === 'placement') return this.a.workers;
    if (stage !== 'routing') return defaultCpu();
    return routeThreads(this.a) ?? routerCpu(defaultCpu());
  }

  /** A command as an admitted, owned stage. Out of time at any point is the schedule's timeout. */
  async stage(command: string[], stage: string, options: { stdout: 'pipe' | number; stderr: 'pipe' | number }): Promise<StageResult> {
    const waitS = Math.min(30, Math.max(0, this.deadline - now()));
    try {
      return await reserve(this.stageCpu(stage), { waitS, events: join(this.a.outdir, 'admission.jsonl'), label: stage }, ({ env }) => ownedStage(command, {
        stage, eventFile: this.events, deadline: this.deadline, env: { ...env, IOT_LEAN_DEADLINE: encodeDeadline(this.deadline) }, cwd: REPO, ...options,
      }));
    } catch (error) {
      if (isTimeout(error)) throw new TimeoutExpired(command, 0);
      throw error;
    }
  }

  private async logged(command: string[], stage: string, log: string): Promise<{ returncode: number; text: string }> {
    const file = openSync(log, 'w');
    try {
      const { returncode } = await this.stage(command, stage, { stdout: file, stderr: file });
      return { returncode, text: readFileSync(log, 'utf8') };
    } finally {
      closeSync(file);
    }
  }

  private searchFlags(): string[] {
    const { workers, epochs, steps, seed, retain_candidates: top, param } = this.a;
    return ['--workers', String(workers), '--epochs', String(epochs), '--steps', String(steps), '--seed', String(seed), '--top', String(top),
      ...(param.length ? ['--param', ...param] : [])];
  }

  private audited(q: ReviewedProblem, n: number, result: SearchResult): SearchResult {
    const params = (result.params ?? {}) as Dict;
    const reports = result.candidates.map(candidate => {
      let report: Dict;
      try {
        report = candidateReport(q, candidate as AuditCandidate, params, this.a.seeded_policy, this.a.max_displacement) as unknown as Dict;
        if (q.engineering) {
          const checked = checkProblem(q, candidate.pose as Pose, { services: this.services });
          report.engineering = checked;
          (report.illegal as string[]).push(...checked.blockers.map(blocker => `engineering:${String(blocker.id)}`));
        }
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        report = { illegal: ['malformed placement evidence'], qualified: false };
      }
      candidate.illegal = report.illegal as string[];
      return report;
    });
    atomicJson(join(this.stepDir(n), 'placement-audit.json'), {
      board_sha256: sha256File(this.a.board), problem_sha256: identity(q), candidates: reports, retained: reports.length, qualified: false,
    });
    result.candidates.sort(compareCandidates as never);   // An illegal or timed-out alternative cannot win on score alone.
    return result;
  }

  private withEscapeHints(q: ReviewedProblem): ReviewedProblem {
    if (!Object.keys(this.escapeHint).length) return q;
    const copy = deepCopy(q);
    for (const unit of copy.units) {
      const names = new Set([...(unit.refs ?? []), unit.name, (unit.ref as string | undefined) ?? '']);
      const extra = Math.max(0, ...[...names].map(ref => this.escapeHint[ref] ?? 0));
      if (extra) for (const rect of unit.rects) rect[4] = new Float(number(rect[4] as Num) + extra);
    }
    return copy;
  }

  /** Virtual input changes the outline: it runs only as a bounded diagnostic. */
  private bindDiagnosticBudget(q: ReviewedProblem): void {
    const { size, diagnostic_budget: budget } = this.a;
    const xs = q.board.outline.map(p => number(p[0] as Num)), ys = q.board.outline.map(p => number(p[1] as Num));
    const wide = Math.max(...xs) - Math.min(...xs) > size[0] + 1e-6, tall = Math.max(...ys) - Math.min(...ys) > size[1] + 1e-6;
    if ((wide || tall) && budget !== null && !this.diagnosticStarted) {
      this.deadline = Math.min(this.deadline, now() + budget);
      this.diagnosticStarted = true;
    }
  }

  private async runSearch(prob: string, d: string, digest: string | null): Promise<void> {
    const log = join(d, 'search.log');
    if (this.a.search === 'local') {
      mkdirSync(join(d, 'search'), { recursive: true });
      await this.logged([...NODE, join(REPO, 'tools/placer/place.ts'), 'run', prob, '-o', join(d, 'search/res.json'), ...this.searchFlags()], 'placement', log);
      return;
    }
    const frozen = digest ? ['--engineering-frozen-model-sha256', digest] : [];
    const command = ['bash', 'tools/placer/remote_run.sh', 'run', 'in/prob.json', '-o', 'out/res.json', ...this.searchFlags(), ...frozen];
    await remoteJob(this.a.board_dir, [prob, iotplaceBin('linux-x86_64')], join(d, 'search'), command, this.a.workers, log);
  }

  async search(given: ReviewedProblem, n: number): Promise<SearchResult | null> {
    if (given.engineering) checkProblem(given, null, { services: this.services });   // In particular, a virtual outline cannot bypass the reviewed source.
    if (this.a.max_routes && this.routesDone >= this.a.max_routes) {
      console.log(`search step ${n}: skipped, router cap ${this.a.max_routes} reached`);
      return null;
    }
    this.bindDiagnosticBudget(given);
    const d = this.stepDir(n);
    const hinted = this.withEscapeHints(given);
    const q = this.a.scatter === null ? hinted : scatter(hinted, this.a.scatter) as ReviewedProblem;
    const prob = join(d, 'prob.json');
    writeFileSync(prob, jsonDumps(q));
    await this.runSearch(prob, d, q.engineering ? sha256File(prob) : null);
    const result = join(d, 'search/res.json');
    if (!existsSync(result)) {
      console.log(`search step ${n}: no result, see ${join(d, 'search.log')}`);
      return null;
    }
    return this.audited(q, n, readTyped<SearchResult>(result));
  }

  write(q: ReviewedProblem, pose: Pose, k: number, n: number): string {
    const folder = join(this.stepDir(n), 'b');
    mkdirSync(folder, { recursive: true });
    const output = join(folder, `${this.name}.kicad_pcb`);
    writeBoard(this.a.board, q, pose, output, { outlineScale: k });
    copySidecars(this.a.board, output);
    return output;
  }

  private engineeringScreen(path: string, output: string): Dict {
    const contract = this.problem.engineering!;
    checkProblem(this.problem, null, { services: this.services });   // Stale sources stop before the native screen.
    let evidence: string | null = null;
    if (contract.rules.some(rule => rule.kind === 'escape')) {
      evidence = output.replace(/\.json$/, '-escape.json');
      this.generateEscape(contract.root, contract.board, path, evidence);
    }
    const checked = this.checkManifest(contract.root, contract.board, contract.manifest, this.services, { candidate: path, escapeEvidence: evidence });
    atomicJson(output, checked);
    return checked;
  }

  /** Gives the step's counts and which of its routes the evidence of the step comes from. */
  private async routeIotroute(path: string, n: number, d: string): Promise<[Measured, number]> {
    const { a } = this;
    const board = this.iotrouteBoard, gate = this.gate;
    const run = async (command: string[], stage: string) => {
      const { stdout, stderr } = await this.stage(command, stage, { stdout: 'pipe', stderr: 'pipe' });
      return { stdout: `${stdout ?? ''}${stderr ?? ''}` };
    };
    const extra = [...shellWords(a.route_args), ...(a.gnd_vias ? ['--plane-net', 'GND'] : []), '--diagnose'];
    // Plain counts: a failed step bisects the halo, it does not stop the loop. One after the other: the gate has one workspace, and
    // a route that passes ends the step. The first route keeps the run's own seed.
    let counts: number[] = [];
    for (let route = 0; route < a.routes && !counts.includes(0); route++) {
      if (route) this.routesDone += 1;
      counts.push(...await routeStep(path, d, board, gate, a.passes, route ? [...extra, '--seed', String(a.seed + route)] : extra, run, route));
    }
    const chosen = counts.indexOf(Math.min(...counts));
    let measured = measure(d, chosen);
    if (a.repair && counts[chosen]! > 0 && counts[chosen]! < NO_RESULT) {
      const rec = await runRepair(board, path, join(d, `route-${chosen}`, basename(path)), join(d, 'repair'), {
        mode: a.repair_mode as 'reuse' | 'local' | 'full', maxRoutes: a.repair_routes, perRound: a.repair_per_round, iters: a.passes, seed: a.seed, rotate: !a.seeded_policy,
        readArgs: shellWords(a.read_args), gate, log: (line: string) => console.log(line), rankMode: a.repair_rank as 'term' | 'hot',
      });
      this.routesDone += rec.attempts.length;
      const best = rec.best as Candidate;
      console.log(`REPAIR step ${n} ${rec.passed ? 'PASS' : 'FAIL'} key ${JSON.stringify(best.key)} board ${best.routed}`);
      if (better(best.key, rec.start.key)) {
        const [drc, gatePart] = best.key as [number, number];
        counts = [rec.passed ? 0 : drc || gatePart];
        measured = measureKey(best.key, best.routed, 'repair');
      }
    }
    return [new Measured(counts, measured), chosen];
  }

  /** A step that did not pass: its evidence may stop the run, keep a step whose opens are only plane nets, and teach the next search. */
  private decide(path: string, d: string, attemptKey: string, measured: Measured, route: number): RouteResult {
    const work = join(d, `route-${route}`, `${basename(path)}.iotroute`), evidence = join(d, 'route-decision.json');
    const decision = { ...observeRoute(path, work), evidence, attempt_sha256: attemptKey } as Dict;
    console.log(`ROUTE_DECISION ${String(decision.action)}; ${String(decision.reason)}; evidence=${evidence}`);
    const [hints, feedback] = boundedFeedback(this.problem, work, sha256File(path), this.escapeHint, this.a.feedback_max_mm, this.a.congestion_feedback);
    for (const key of Object.keys(this.escapeHint)) delete this.escapeHint[key];
    Object.assign(this.escapeHint, hints);
    atomicJson(join(d, 'feedback.json'), feedback);
    const result = stepOutcome(measured, decision, work);
    atomicJson(evidence, result instanceof RouteOutcome ? result.decision : decision);
    return result;
  }

  /** An identical failed source, rules and effort stops here: no blind reroute. */
  private unchangedAttempt(attemptKey: string, d: string): RouteOutcome | null {
    const prior = this.attempts.get(attemptKey);
    if (!prior) return null;
    const decision = { ...prior, status: 'unchanged_failed_attempt', action: 'inspect_prior_diagnosis', reason: 'Identical source/rules/effort already failed in this loop; no blind reroute', prior_decision: prior.evidence };
    console.log(`STUCK: unchanged failed routing input; inspect ${String(prior.evidence)}`);
    const result = routeHandoff([NO_RESULT], decision);
    atomicJson(join(d, 'route-decision.json'), result.decision);
    return result;
  }

  async route(path: string, n: number): Promise<RouteResult> {
    const { a } = this;
    const d = this.stepDir(n);
    if (this.problem.engineering) {
      const output = join(d, 'engineering-pre-route.json');
      const checked = this.engineeringScreen(path, output);
      if (checked.status !== 'passed') {
        return routeHandoff([NO_RESULT], { status: 'unverified', action: 'resolve_placement_requirements', qualified: false, reason: `Reviewed placement blocks routing: ${jsonDumps(checked.blockers)}`, evidence: output });
      }
    }
    if (a.max_routes && this.routesDone >= a.max_routes) {
      return routeHandoff([NO_RESULT], { status: 'unverified', action: 'inspect_route_budget', reason: 'Router attempt cap reached; no further search/routing', qualified: false });
    }
    const { passes, routes, gnd_vias, route_args, read_args, repair, repair_mode, repair_rank, repair_routes, repair_per_round, seed } = a;
    const attemptKey = retryKey(path, { passes, routes, gnd_vias, route_args, read_args, repair, repair_mode, repair_rank, repair_routes, repair_per_round, seed, router: a.router });
    const unchanged = this.unchangedAttempt(attemptKey, d);
    if (unchanged) return unchanged;
    this.routesDone += 1;
    const [result, route] = await this.routeIotroute(path, n, d);
    if (result.counts.includes(0)) return result;
    this.attempts.set(attemptKey, { evidence: join(d, `route-${route}/score.json`) });
    return this.decide(path, d, attemptKey, result, route);
  }
}

/** One job on the Hetzner box through tools/remote.sh. Gives the log text. */
async function remoteJob(boardDir: string, inputs: string[], results: string, command: string[], cpus: number, log: string): Promise<string> {
  const args = [boardDir, ...inputs.flatMap(file => ['--in', file]), '--results', results, '--', ...command];
  const file = openSync(log, 'w');
  try {
    const child = spawn('tools/remote.sh', args, { cwd: REPO, env: { ...process.env, REMOTE_MEM: '8g', REMOTE_CPUS: String(cpus) }, stdio: ['ignore', file, file] });
    await new Promise<void>((done, fail) => {
      child.on('error', fail);
      child.on('close', () => done());
    });
  } finally {
    closeSync(file);
  }
  return readFileSync(log, 'utf8');
}

function freshOutput(a: Args): void {
  if (existsSync(a.outdir) && statSync(a.outdir).isDirectory() && readdirSync(a.outdir).length) throw new Error('compaction output directory must be fresh');
  mkdirSync(a.outdir, { recursive: true });
  const stem = a.board.slice(0, -extname(a.board).length);
  const sidecars = Object.fromEntries(['.kicad_pro', '.kicad_dru'].filter(extension => existsSync(stem + extension)).map(extension => [extension, sha256File(stem + extension)]));
  atomicJson(join(a.outdir, 'input-manifest.json'), {
    board: resolve(a.board), board_sha256: sha256File(a.board), problem_sha256: sha256File(a.prob), configuration: a, qualified: false, sidecars,
    note: 'run attribution only; no cached result reuse or release qualification',
  });
}

function snapshots(a: Args): void {
  if (!a.snapshots) return;
  const run = join(a.outdir, 'run.json');
  mkdirSync(a.snapshots, { recursive: true });
  const tool = (name: string, ...rest: string[]) => spawnSync(NODE[0] as string, [...NODE.slice(1), join(REPO, 'tools/placer', name), ...rest], { stdio: 'inherit' });
  tool('viewer.ts', run, join(a.snapshots, 'viewer.html'), '--frames-json', join(a.snapshots, 'frames.json'));
  tool('movie.ts', run, a.snapshots, '--routed', a.outdir);
}

export async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  settle(a);
  if (a.repair_rank === 'hot') process.env.IOTROUTE_CONGESTION = '1';   // rank 'hot' reads the map of the failed route: iotroute run writes it
  const deadline = deadlineAfter(a.budget);
  const problem = readTyped<ReviewedProblem>(a.prob);
  if (problem.engineering) checkProblem(problem);   // Source/coverage errors stop before search or routing.
  freshOutput(a);
  const driver = new Compaction(a, problem, deadline);
  const run = await runLoop(problem, a.size, {
    search: (q, n) => driver.search(q as ReviewedProblem, n),
    write: (q, pose, k, n) => driver.write(q as ReviewedProblem, pose, k, n),
    route: (path, n) => driver.route(path, n),
  }, {
    s0: a.s0, budget: Math.max(0, deadline - now()), target: a.target, shrink: a.shrink, tol: a.tol, log: line => console.log(line), realFirst: !a.virtual_first,
    diagnosticBudget: a.diagnostic_budget, kCap: a.k_cap, rank: a.rank as Rank, lengthPatience: a.rank === 'length' ? a.length_patience : null,
  });
  writeFileSync(join(a.outdir, 'run.json'), jsonDumps({ ...runJson(run), problem, size: a.size }));
  console.log('VERDICT', run.verdict);
  console.log('STOP', run.stop);
  if (run.next_action) {
    console.log(`STUCK: inspect retained candidate; evidence=${String((run.next_action as Dict).evidence)}`);
    return 3;
  }
  if (run.best) console.log(bestLine({ ...run, best: run.best as unknown as Dict }));
  snapshots(a);
  return 0;
}

runMain(import.meta.url, main);
