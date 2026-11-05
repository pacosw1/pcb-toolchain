// The fixed list of next actions after a stuck route (tools/ROUTE-DECISIONS.md): `nextMove` picks one from the stuck report, the same
// way every time, and `checkMove` says whether a move may run and writes what it needs. Nothing here touches a board: an accepted move
// is a new candidate run, so discarding that run undoes it, and only `tools/pcb adopt` changes canonical CAD.
//
// `validateMove` refuses what it can see: a part that is locked, fixed or in a rigid group it would split, a pose off the board, a pad a
// reviewed rule names, a setting that is not on the list. Rules, widths and clearances are no settings at all. Pin distances, clearances
// and connector access are measured on the moved candidate by the checks every candidate run already has.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { toMm } from './board-types.ts';
import type { Board } from './board-types.ts';
import { atomicJson, readObject, sha256File } from './json-file.ts';
import { reviewedRules } from './pcb-candidate-screens.ts';
import { boardConfig } from './pcb-workflow.ts';
import { decisionServices } from './route-decision.ts';
import { nativeInputs } from './route-decision-evidence.ts';
import type { StuckReport } from './route-stuck.ts';

export const MOVE_SCHEMA = 'iot-lab.route-move.v1';
export const STUCK_SCHEMA = 'iot-lab.stuck-report.v1';
export const MOVE_KINDS = ['reroute_stuck', 'change_setting', 'move_part', 'move_cluster', 'swap_pins', 'widen_region', 'ask_user'] as const;
/** The limits of `iters` in an iotroute policy (tools/router/core/src/run/policy.rs). */
const MAX_PASSES = 1000;
const UNDO = 'discard the run; canonical CAD changes only by tools/pcb adopt';

export type Move =
  | { kind: 'reroute_stuck' }
  | { kind: 'change_setting'; setting: 'passes' | 'time_s' | 'layers'; value: number | string[] }
  | { kind: 'move_part'; ref: string; dx_mm: number | null; dy_mm: number | null }
  | { kind: 'move_cluster'; refs: string[]; dx_mm: number | null; dy_mm: number | null }
  | { kind: 'swap_pins'; ref: string; pads: string[] }
  | { kind: 'widen_region'; nets: string[] }
  | { kind: 'ask_user'; question: string };
const FIELDS: Record<Move['kind'], string[]> = { reroute_stuck: [], change_setting: ['setting', 'value'], move_part: ['ref', 'dx_mm', 'dy_mm'], move_cluster: ['refs', 'dx_mm', 'dy_mm'],
  swap_pins: ['ref', 'pads'], widen_region: ['nets'], ask_user: ['question'] };

/** What the reviewed manifest of a board says about parts and pads. */
export interface Reviewed { fixed: Map<string, string>; groups: { id: string; refs: string[] }[]; pads: Map<string, string> }
export const NOTHING_REVIEWED: Reviewed = { fixed: new Map(), groups: [], pads: new Map() };
export interface Part { x: number; y: number; orientation: number; locked: boolean; pads: string[] }
export interface MoveContext { report: StuckReport; reviewed: Reviewed; parts: Map<string, Part>; bounds: { left: number; top: number; right: number; bottom: number } }

interface Rule { id: string; kind: string; refs?: string[]; a?: { ref: string; pad: string }; b?: { ref: string; pad: string } }
export function reviewedFrom(rules: Rule[]): Reviewed {
  const reviewed: Reviewed = { fixed: new Map(), groups: [], pads: new Map() };
  for (const rule of rules) {
    if (rule.kind === 'fixed') rule.refs!.forEach(ref => reviewed.fixed.set(ref, rule.id));
    if (rule.kind === 'rigid_group') reviewed.groups.push({ id: rule.id, refs: rule.refs! });
    for (const end of [rule.a, rule.b]) if (end) reviewed.pads.set(`${end.ref}.${end.pad}`, rule.id);
  }
  return reviewed;
}

/** This run started from an earlier one and came out worse: its copper is no place to start from again. On ENV-SENSE held to one layer a
 *  reuse kept 2 nets open but ripped GND for them, 11 open connections to 33: the count of nets did not show it. */
const reuseMadeItWorse = (report: StuckReport): boolean => report.reused && report.changed?.worse === true;
/** The same run gained nothing: not worth suggesting again (ENV-SENSE on two layers: 3 connections to 2, then 2 to 2). It may still be asked for. */
const reuseStopped = (report: StuckReport): boolean => report.reused && report.changed?.better === false;

/** The next action for this report. A part move names the part; how far is for whoever takes it, so its offsets are null. */
export function nextMove(report: StuckReport, reviewed: Reviewed = NOTHING_REVIEWED): Move {
  if (report.parity) return { kind: 'ask_user', question: 'The schematic and the board disagree. Which one is right?' };
  if (!report.open_nets.length && !report.drc_errors) return { kind: 'ask_user', question: 'The route failed with no open net and no DRC error. What should it have done?' };
  if (!report.enclosed && !report.unknown) {
    const out = report.search?.stop === 'iters' || report.search?.stop === 'max-time', improving = report.search?.passes_since_best === 0;
    const passes = Math.min(MAX_PASSES, (report.search?.max_passes ?? 0) * 2);
    if (out && improving && passes > (report.search?.max_passes ?? 0)) return { kind: 'change_setting', setting: 'passes', value: passes };
    if (!reuseStopped(report)) return { kind: 'reroute_stuck' };
  }
  if (report.blockers.layers.length && report.route_layers.length) return { kind: 'change_setting', setting: 'layers', value: report.route_layers };
  for (const ref of report.blockers.parts.filter(part => !reviewed.fixed.has(part))) {
    const group = reviewed.groups.find(row => row.refs.includes(ref));
    if (!group) return { kind: 'move_part', ref, dx_mm: null, dy_mm: null };
    if (!group.refs.some(part => reviewed.fixed.has(part))) return { kind: 'move_cluster', refs: group.refs, dx_mm: null, dy_mm: null };
  }
  if (report.blockers.nets.length && !reuseStopped(report)) return { kind: 'widen_region', nets: report.blockers.nets };
  return { kind: 'ask_user', question: `Nothing on the list frees ${report.open_nets.join(', ')}. What may change?` };
}

function offsets(dx: number | null, dy: number | null): string[] {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return ['dx_mm and dy_mm must be numbers'];
  return dx === 0 && dy === 0 ? ['a move of nothing'] : [];
}

function movable(ref: string, dx: number, dy: number, { reviewed, parts, bounds }: MoveContext): string[] {
  const part = parts.get(ref), fixed = reviewed.fixed.get(ref);
  if (!part) return [`${ref} is not on the board`];
  const reasons = [...(part.locked ? [`${ref} is locked`] : []), ...(fixed ? [`${ref} is fixed by reviewed rule ${fixed}`] : [])];
  const [x, y] = [part.x + dx, part.y + dy];
  if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) reasons.push(`${ref} would leave the board at (${x}, ${y})`);
  return reasons;
}

/** Why this move may not run; none when it may. */
export function validateMove(move: Move, context: MoveContext): string[] {
  if (!MOVE_KINDS.includes(move?.kind)) return [`${String(move?.kind)} is not on the list: ${MOVE_KINDS.join(', ')}`];
  const extra = Object.keys(move).filter(key => key !== 'kind' && !FIELDS[move.kind].includes(key));
  if (extra.length) return [`${move.kind} has no field ${extra.join(', ')}`];
  const { report, reviewed, parts } = context;
  if ((move.kind === 'reroute_stuck' || move.kind === 'widen_region') && reuseMadeItWorse(report)) return ['this run reused an earlier one and came out worse: start from the earlier run'];
  switch (move.kind) {
    case 'reroute_stuck': return report.open_nets.length || report.drc_errors ? [] : ['the report has nothing to route again'];
    case 'ask_user': return move.question?.trim() ? [] : ['a question is needed'];
    case 'change_setting': {
      if (move.setting === 'passes') return Number.isInteger(move.value) && Number(move.value) >= 1 && Number(move.value) <= MAX_PASSES ? [] : [`passes must be 1..${MAX_PASSES}`];
      if (move.setting === 'time_s') return Number.isFinite(move.value) && Number(move.value) > 0 ? [] : ['time_s must be positive'];
      if (move.setting !== 'layers') return [`${String(move.setting)} is no setting: passes, time_s, layers. Rules, widths and clearances are reviewed inputs`];
      const layers = Array.isArray(move.value) ? move.value : [];
      return layers.length && layers.every(layer => report.route_layers.includes(layer)) ? [] : [`layers must be some of ${report.route_layers.join(', ')}`];
    }
    case 'move_part': {
      const reasons = offsets(move.dx_mm, move.dy_mm), group = reviewed.groups.find(row => row.refs.includes(move.ref));
      if (group) reasons.push(`${move.ref} is in rigid group ${group.id}: move_cluster with ${group.refs.join(', ')}`);
      return reasons.length ? reasons : movable(move.ref, move.dx_mm!, move.dy_mm!, context);
    }
    case 'move_cluster': {
      const reasons = offsets(move.dx_mm, move.dy_mm), refs = move.refs ?? [];
      if (refs.length < 2 || new Set(refs).size !== refs.length) reasons.push('a cluster is two or more distinct parts');
      for (const group of reviewed.groups) {
        const left = group.refs.filter(ref => !refs.includes(ref));
        if (left.length && left.length < group.refs.length) reasons.push(`rigid group ${group.id} would split: ${left.join(', ')} stay behind`);
      }
      return reasons.length ? reasons : refs.flatMap(ref => movable(ref, move.dx_mm!, move.dy_mm!, context));
    }
    case 'swap_pins': {
      const part = parts.get(move.ref), pads = move.pads ?? [];
      if (!part) return [`${move.ref} is not on the board`];
      if (pads.length !== 2 || pads[0] === pads[1]) return ['swap_pins needs two distinct pads'];
      const absent = pads.filter(pad => !part.pads.includes(pad)).map(pad => `${move.ref}.${pad} is not on the board`);
      const ruled = pads.filter(pad => reviewed.pads.has(`${move.ref}.${pad}`)).map(pad => `${move.ref}.${pad} is in reviewed rule ${reviewed.pads.get(`${move.ref}.${pad}`)}`);
      return [...absent, ...ruled, ...(reviewed.fixed.has(move.ref) ? [`${move.ref} is fixed by reviewed rule ${reviewed.fixed.get(move.ref)}`] : [])];
    }
    case 'widen_region': {
      const known = new Set([...report.blockers.nets, ...report.open_nets]), nets = move.nets ?? [];
      return nets.length ? nets.filter(net => !known.has(net)).map(net => `${net} is neither stuck nor a blocker in the report`) : ['name the nets to route again'];
    }
  }
}

export interface MoveResult {
  schema: string; status: 'accepted' | 'rejected' | 'proposal' | 'ask_user'; qualified: false; board: string; move: Move; reasons: string[]; reversible: true; undo: string;
  spec: string | null; next_action: { kind: string; argv: string[] } | null; evidence_sha256: Record<string, string>; cause?: string;
}
interface StuckRun { router?: string; spec?: RoutePlan }
const POLICY_SCHEMA = 'iot-lab.iotroute-policy.v1';
const POLICY_KEY = { passes: 'iters', time_s: 'max_time_s', layers: 'layers' } as const;
interface RoutePlan { budget?: Record<string, unknown>; layers?: string[]; stages?: Record<string, unknown>[]; reuse?: unknown; [key: string]: unknown }

/** The route plan of a move, from the plan of the stuck run. */
export function movedPlan(plan: RoutePlan, move: Move, router: string): RoutePlan {
  const { reuse: _earlier, ...next } = plan;
  if (move.kind === 'reroute_stuck') return { ...next, reuse: { from: router, nets: [] } };
  if (move.kind === 'widen_region') return { ...next, reuse: { from: router, nets: move.nets } };
  if (move.kind !== 'change_setting') throw new Error(`${move.kind} has no route plan`);
  const key = move.setting;
  // A stage's own value would win over the plan's.
  const stages = (plan.stages ?? []).map(({ [key]: _stage, ...stage }) => stage);
  return key === 'layers' ? { ...next, stages, layers: move.value as string[] } : { ...next, stages, budget: { ...plan.budget, [key]: move.value } };
}

/** The iotroute policy of a move, from the policy of the stuck run; `board` is the board that run wrote. */
export function movedPolicy(policy: Record<string, unknown>, move: Move, board: string): Record<string, unknown> {
  const { reuse: _board, reuse_nets: _nets, ...next } = policy;
  if (move.kind === 'reroute_stuck') return { ...next, reuse: board };
  if (move.kind === 'widen_region') return { ...next, reuse: board, reuse_nets: move.nets };
  if (move.kind !== 'change_setting') throw new Error(`${move.kind} has no iotroute policy`);
  return { ...next, [POLICY_KEY[move.setting]]: move.value };
}

function poses(move: Extract<Move, { kind: 'move_part' | 'move_cluster' }>, parts: Map<string, Part>): Record<string, number[]> {
  const refs = move.kind === 'move_part' ? [move.ref] : move.refs;
  return Object.fromEntries(refs.map(ref => { const part = parts.get(ref)!; return [ref, [part.x + move.dx_mm!, part.y + move.dy_mm!, part.orientation]]; }));
}

function boardParts(board: Board): Pick<MoveContext, 'parts' | 'bounds'> {
  const { left, top, right, bottom } = board.edges_bbox;
  const parts = new Map(board.footprints.map(part => [part.reference, { x: toMm(part.position.x), y: toMm(part.position.y), orientation: part.orientation, locked: part.locked, pads: part.pads.map(pad => pad.number) }]));
  return { parts, bounds: { left: toMm(left), top: toMm(top), right: toMm(right), bottom: toMm(bottom) } };
}

export interface MoveServices { board(path: string): Board; reviewed(root: string, board: string): Reviewed }
export const moveServices: MoveServices = { board: path => decisionServices.board(path), reviewed: (root, board) => reviewedFrom(reviewedRules(root, board) as Rule[]) };

/** Checks `text`, a move as JSON, against the report at `evidence`, a run's operation/stuck.json. What it needs goes beside `output`. */
export function checkMove(root: string, board: string, evidence: string, text: string, output: string, services = moveServices): MoveResult {
  const report = readObject<StuckReport>(evidence), run = dirname(dirname(evidence)), manifest = readObject<StuckRun>(join(run, 'run.json'));
  if (report.schema !== STUCK_SCHEMA || report.board !== board) throw new Error(`${evidence} is no stuck report of ${board}`);
  const move = JSON.parse(text) as Move;
  const context: MoveContext = { report, reviewed: services.reviewed(root, board), ...boardParts(services.board(nativeInputs(root, board).native)) };
  const result: MoveResult = { schema: MOVE_SCHEMA, status: 'accepted', qualified: false, board, move, reasons: validateMove(move, context), reversible: true, undo: UNDO, spec: null, next_action: null, evidence_sha256: { [evidence]: sha256File(evidence) } };
  if (result.reasons.length) return { ...result, status: 'rejected', cause: result.reasons.join('; ') };
  if (move.kind === 'ask_user') return { ...result, status: 'ask_user' };
  if (move.kind === 'swap_pins') return { ...result, status: 'proposal', undo: 'nothing was changed: a pin swap is a schematic change for a person to review' };
  result.spec = join(dirname(output), 'move-spec.json');
  if (move.kind === 'move_part' || move.kind === 'move_cluster') {
    atomicJson(result.spec, { place: poses(move, context.parts) });
    return { ...result, next_action: { kind: move.kind, argv: ['tools/pcb', 'edit', board, '--kind', 'place', '--spec', result.spec, '--detach', '--json'] } };
  }
  const router = join(run, 'operation/router');
  if (!['route-json', 'iotroute'].includes(manifest.router ?? '') || !existsSync(router)) {
    const reason = 'this move needs a stuck run of tools/pcb route with --router route-json or iotroute';
    return { ...result, status: 'rejected', spec: null, reasons: [reason], cause: reason };
  }
  if (manifest.router === 'route-json') atomicJson(result.spec, movedPlan(manifest.spec ?? readObject<RoutePlan>(join(boardConfig(root, board).folder, 'route.json')), move, router));
  else atomicJson(result.spec, movedPolicy(manifest.spec ?? { schema: POLICY_SCHEMA }, move, String(readObject<{ board_file?: string }>(join(run, 'operation/router-summary.json')).board_file)));
  return { ...result, next_action: { kind: move.kind, argv: ['tools/pcb', 'route', board, '--router', manifest.router!, '--spec', result.spec, '--detach', '--json'] } };
}

/** The command that checks a move against a run's report; a part move still needs its offsets filled in. */
export function moveArgs(board: string, evidence: string, move: Move): string[] {
  return ['routing', '--json', '--follow', 'move', board, '--evidence', evidence, '--move', JSON.stringify(move)];
}
