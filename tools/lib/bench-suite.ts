// A benchmark suite: pinned boards, two arms, shared seeds and one budget. Expands to the ordered trial list.
import { resolve } from 'node:path';
import { sha256File } from './json-file.ts';

export const SUITE = 'iot-lab.bench-suite.v1';
const PLACEHOLDER = /\{([a-z_]+)\}/g;
const KNOWN = new Set(['board', 'seed', 'timeout_s', 'cpus', 'memory_gb', 'input']);
/** Filled while a trial runs: the trial's scratch folder, and the run id and folder of the previous step that sealed a run. */
const RUNTIME = new Set(['work', 'prev_run', 'prev_run_path']);
const SHA = /^[0-9a-f]{64}$/;

/** route_input: when earlier steps build a project copy with its own board (a placer arm), the file the final route reads, e.g.
 *  "{work}/proj/{input}". The trial's placement input is then that file's bytes, not the suite board. */
export interface Arm { id: string; argv?: string[]; steps?: string[][]; env?: Record<string, string>; toolchain_sha256?: string; route_input?: string }
export interface SuiteBoard { family: string; board: string; split: 'development' | 'holdout'; input: { path: string; sha256: string } }
export interface Budget { timeout_s: number; cpus: number; memory_gb: number }
/** gate: the full configured gate passed (default). native: native DRC errors, unconnected and parity all 0, the placer studies' 'verified'. */
export type Metric = 'gate' | 'native';
/** placement (default): routing is held fixed, so arms must route with identical tools and specs. router: the router build or
 *  route spec is the thing compared, so the evaluator's unequal_case_or_execution blocker is expected and tolerated (still reported). */
export type Treatment = 'placement' | 'router';
export interface Suite { schema: typeof SUITE; suite_id: string; arms: [Arm, Arm]; boards: SuiteBoard[]; seeds: number[]; budget: Budget; metric?: Metric; treatment?: Treatment }

export interface PlannedTrial {
  id: string; arm: string; family: string; board: string; split: string; case: string; replicate: number; seed: number;
  argv: string[]; steps: string[][]; env: Record<string, string>; input: { path: string; sha256: string }; route_input?: string;
}

export const armSteps = (arm: Arm): string[][] => arm.steps ?? (arm.argv ? [arm.argv] : []);

const fail = (message: string): never => { throw new Error(`suite: ${message}`); };

export function validateSuite(value: unknown): Suite {
  const suite = value as Partial<Suite> | null;
  if (!suite || suite.schema !== SUITE) fail(`schema must be ${SUITE}`);
  const s = suite as Suite;
  if (typeof s.suite_id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(s.suite_id)) fail('suite_id must be letters, digits, . _ -');
  if (!Array.isArray(s.arms) || s.arms.length !== 2) fail('exactly two arms (baseline first, proposal second)');
  if (s.arms[0].id === s.arms[1].id) fail('arm ids must differ');
  for (const arm of s.arms) {
    if (!/^[A-Za-z0-9._-]+$/.test(arm.id ?? '')) fail('arm id must be letters, digits, . _ -');
    if ((arm.argv === undefined) === (arm.steps === undefined)) fail(`arm ${arm.id}: give either argv or steps`);
    const steps = armSteps(arm);
    if (!steps.length || steps.some(step => !Array.isArray(step) || !step.length || step.some(part => typeof part !== 'string'))) fail(`arm ${arm.id}: argv or each step must be a nonempty string array`);
    steps.forEach((step, index) => {
      for (const part of step) for (const [, name] of part.matchAll(PLACEHOLDER)) {
        if (KNOWN.has(name!)) continue;
        if (RUNTIME.has(name!) && arm.steps) { if (index === 0 && name !== 'work') fail(`arm ${arm.id}: {${name}} needs an earlier step`); continue; }
        fail(`arm ${arm.id}: unknown placeholder {${name}}`);
      }
    });
    if (arm.toolchain_sha256 !== undefined && !SHA.test(arm.toolchain_sha256)) fail(`arm ${arm.id}: toolchain_sha256 must be a SHA-256`);
    if (arm.route_input !== undefined) {
      if (typeof arm.route_input !== 'string' || !arm.steps) fail(`arm ${arm.id}: route_input needs steps and a path template`);
      for (const [, name] of arm.route_input!.matchAll(PLACEHOLDER)) if (!KNOWN.has(name!) && name !== 'work') fail(`arm ${arm.id}: route_input may use {work} and suite placeholders only`);
    }
  }
  if (!Array.isArray(s.boards) || !s.boards.length) fail('boards must be nonempty');
  const cases = new Set<string>();
  for (const board of s.boards) {
    if (!board.family || !board.board || !['development', 'holdout'].includes(board.split)) fail('each board needs family, board and a development or holdout split');
    if (!SHA.test(board.input?.sha256 ?? '') || !board.input?.path) fail(`board ${board.board}: input needs path and SHA-256`);
    if (cases.has(board.board)) fail(`board ${board.board} listed twice`);
    cases.add(board.board);
  }
  const splitOf = (name: string) => new Set(s.boards.filter(board => board.split === name).map(board => board.family));
  const development = splitOf('development'), holdout = splitOf('holdout');
  if (!development.size || !holdout.size) fail('both a development and a holdout board are required');
  if ([...development].some(family => holdout.has(family))) fail('a family cannot be in both splits');
  if (!Array.isArray(s.seeds) || s.seeds.length < 2 || s.seeds.some(seed => !Number.isInteger(seed)) || new Set(s.seeds).size !== s.seeds.length) {
    fail('seeds must be at least two distinct integers');
  }
  if (s.metric !== undefined && s.metric !== 'gate' && s.metric !== 'native') fail('metric must be gate or native');
  if (s.treatment !== undefined && s.treatment !== 'placement' && s.treatment !== 'router') fail('treatment must be placement or router');
  const b = s.budget;
  if (!b || ![b.timeout_s, b.cpus, b.memory_gb].every(x => Number.isFinite(x) && x > 0)) fail('budget needs positive timeout_s, cpus and memory_gb');
  return s;
}

/** Fail when an input file is missing or differs from its pinned hash. */
export function verifyInputs(suite: Suite, root: string): void {
  for (const board of suite.boards) {
    let digest: string;
    try { digest = sha256File(resolve(root, board.input.path)); } catch { return fail(`board ${board.board}: input ${board.input.path} cannot be read`); }
    if (digest !== board.input.sha256) fail(`board ${board.board}: input ${board.input.path} differs from its pinned SHA-256`);
  }
}

function substitute(part: string, values: Record<string, string>): string {
  return part.replace(PLACEHOLDER, (whole, name: string) => values[name] ?? (RUNTIME.has(name) ? whole : fail(`no value for {${name}}`)));
}

/** One trial per arm, board and seed. Arms interleave inside each pair so slow drift hits both alike. */
export function expandTrials(suite: Suite): PlannedTrial[] {
  const trials: PlannedTrial[] = [];
  for (const board of suite.boards) {
    suite.seeds.forEach((seed, index) => {
      for (const arm of suite.arms) {
        const values = {
          board: board.board, seed: String(seed), timeout_s: String(suite.budget.timeout_s), cpus: String(suite.budget.cpus),
          memory_gb: String(suite.budget.memory_gb), input: board.input.path,
        };
        const planned = armSteps(arm).map(step => step.map(part => substitute(part, values)));
        trials.push({
          id: `${board.board}.r${index + 1}.${arm.id}`, arm: arm.id, family: board.family, board: board.board, split: board.split, case: board.board,
          replicate: index + 1, seed,
          steps: planned, argv: planned[planned.length - 1]!, env: arm.env ?? {}, input: board.input,
          ...(arm.route_input ? { route_input: substitute(arm.route_input, values) } : {}),
        });
      }
    });
  }
  return trials;
}
