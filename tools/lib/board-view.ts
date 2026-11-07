// `pcb state`: the view of a board. It reads the evidence and the change log on each call and stores no state.
// The position comes from the same `position` as the commands. `pcb next` already judges runs, so the view uses its decision and does not judge them again.
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { allowedEvents, commandEvidence, machineTable, position, type BoardState, type Evidenced } from './board-machine.ts';
import { changeBlock, changeStatus } from './change-log.ts';
import { boardConfig } from './pcb-workflow.ts';
import { loadTransitions, redoFor, type Command, type Evidence, type Freshness, type Item, type Kind, type Readers, type RedoRow, type State, type TransitionTable } from './transitions.ts';

type Row = Record<string, unknown>;
export interface Decision { state?: string; blocker?: { code?: unknown }; next_action?: { command?: string }; observed_run?: { run_id?: unknown } | null; board_state?: unknown }
export type Decide = (root: string, board: string) => Promise<Decision>;
export interface ItemView { name: string; path: string | null; template?: string; exists: boolean; image?: true }
export interface StateView { id: string; name: string; status: string; evidence: Evidence | null; freshness: Freshness | null; position: boolean; next: readonly string[]; back: State['back']; inputs: ItemView[]; outputs: ItemView[]; gap?: string }
export interface KindView { kind: string; reenter: readonly string[]; redo: RedoRow[]; keep: readonly Evidence[]; approve: readonly string[] }
export interface BoardView {
  schema: 'iot-lab.board-state.v1'; board: string; position: { state: BoardState; name: string; evidence: Evidence | null; freshness: Freshness | null };
  allowed: Command[]; next: Row; evidence: Evidenced;
  change: { state: string; path: string; events: number; problems: string[]; pending: (KindView & { group: string })[]; last: (KindView & { id: string; at: string; by: string; reason: string }) | null };
  images: string[]; states: StateView[];
}

const TABLE = machineTable(loadTransitions());
const DONE = { placement: 'current', copper: 'current', gate: 'current' } as const;
const COPPER_OPEN: Evidenced = { placement: 'current', copper: 'missing' };
const READY: Evidenced = { ...DONE, release: 'current', readiness: 'missing' };
/** What a blocker code of `pcb next` proves. A code with no row proves nothing. */
const JUDGED: Record<string, Evidenced> = {
  board_unplaced: { placement: 'missing' }, bounded_route_repair: COPPER_OPEN, candidate_connectivity_open: COPPER_OPEN, route_stuck: COPPER_OPEN, engine_search_exhausted: COPPER_OPEN, route_move_accepted: COPPER_OPEN,
  release_evidence_missing: { ...DONE, release: 'missing' }, assembly_readiness_unverified: READY, stock_day_expired: READY, readiness_requires_current_review: READY,
};
export const judgedEvidence = (code: unknown): Evidenced => JUDGED[String(code)] ?? {};

function decisionOf(decision: Decision): Decision { return (decision.board_state as Decision | undefined) ?? decision; }

function expand(item: Item, values: Record<string, string | null>, images: string[]): ItemView {
  if (!item.path) return { name: item.name, path: null, exists: false };
  const missing = [...item.path.matchAll(/\{([^}]*)\}/g)].some(match => values[match[1]!] === null);
  if (missing) return { name: item.name, path: null, template: item.path, exists: false };
  const path = item.path.replace(/\{([^}]*)\}/g, (_, name: string) => values[name]!);
  const full = isAbsolute(path) ? path : resolve(values.root!, path), exists = existsSync(full), image = /\.(svg|png)$/.test(path);
  if (image && exists) images.push(full);
  return { name: item.name, path: full, template: item.path, exists, ...(image ? { image: true as const } : {}) };
}

const kindView = (kind: Kind, readers: Readers): KindView => ({ kind: kind.id, reenter: kind.reenter, redo: redoFor(kind, readers), keep: kind.keep, approve: kind.approve });

/** The view of BOARD now. A decision that fails reads as unavailable and proves nothing. */
export async function boardView(root: string, board: string, base: string, decide: Decide, table: TransitionTable = TABLE): Promise<BoardView> {
  const project = boardConfig(root, board).project;
  let next: Row, run: string | null = null, judged: Evidenced = {};
  try {
    const decision = decisionOf(await decide(root, board)), observed = decision.observed_run?.run_id;
    next = { state: decision.state, code: decision.blocker?.code, command: decision.next_action?.command };
    run = typeof observed === 'string' ? join(base, observed) : null;
    judged = judgedEvidence(decision.blocker?.code);
  } catch (error) { next = { state: 'unavailable', cause: (error as Error).message }; }
  const evidence: Evidenced = { ...judged, ...commandEvidence(root, board) };
  const at = position(table, evidence), change = changeStatus(root, board, table);
  const readers: Readers = Object.fromEntries(Object.entries(evidence).map(([name, freshness]) => [name, () => freshness]));
  const images: string[] = [], values = { root, board, project, run };
  const states = table.states.map(state => ({
    id: state.id, name: state.name, status: state.status, evidence: state.evidence, freshness: state.evidence ? evidence[state.evidence] ?? 'unknown' as const : null,
    position: state.id === at.state, next: state.next, back: state.back,
    inputs: state.inputs.map(item => expand(item, values, images)), outputs: state.outputs.map(item => expand(item, values, images)), ...(state.gap ? { gap: state.gap } : {}),
  }));
  const pending = change.state === 'unrecorded' ? change.groups.map(row => ({ group: row.group, ...kindView(row.kind, readers) })) : [];
  const event = change.events.at(-1), kind = table.kinds.find(row => row.id === event?.kind);
  return {
    schema: 'iot-lab.board-state.v1', board, allowed: allowedEvents(table, at.state, { change_recorded: changeBlock(root, board, table) === null }), next, evidence, images: [...new Set(images)], states,
    position: { state: at.state, name: table.states.find(state => state.id === at.state)!.name, evidence: at.evidence, freshness: at.freshness },
    change: { state: change.state, path: change.path, events: change.events.length, problems: change.state === 'invalid' ? change.problems : [], pending,
      last: event && kind && kind.role === 'change' ? { id: event.id, at: event.at, by: event.by, reason: event.reason, ...kindView(kind, readers) } : null },
  };
}

const redoText = (rows: RedoRow[]): string => rows.map(row => `${row.evidence}=${row.status}`).join(', ') || 'nothing';

export function viewText(view: BoardView): string {
  const { position: at, change } = view, lines = [`${view.board} is at ${at.state} (${at.name})${at.evidence ? `: ${at.evidence} is ${at.freshness}` : ''}`, `Allowed: ${view.allowed.join(', ') || 'none'}`];
  if (view.next.command) lines.push(`Next: ${String(view.next.command)}`);
  lines.push(`Change log: ${change.state}, ${change.events} events`, ...change.problems.map(problem => `  ${problem}`));
  for (const row of change.pending) lines.push(`Change with no event in ${row.group}: re-enter ${row.reenter.join(' or ')}; redo ${redoText(row.redo)}; keep ${row.keep.join(', ') || 'nothing'}`);
  if (change.last) lines.push(`Last event ${change.last.id} ${change.last.kind} by ${change.last.by}: ${change.last.reason}; redo ${redoText(change.last.redo)}; keep ${change.last.keep.join(', ') || 'nothing'}`);
  lines.push('States:');
  for (const state of view.states) {
    const missing = [...state.inputs, ...state.outputs].filter(item => !item.exists && item.path).length;
    lines.push(`${state.position ? '>' : ' '} ${state.id} ${state.status} ${state.freshness ?? '-'} ${state.name}${missing ? ` (${missing} files missing)` : ''}`);
  }
  if (view.images.length) lines.push('Images:', ...view.images.map(path => `  ${path}`));
  return lines.join('\n');
}
