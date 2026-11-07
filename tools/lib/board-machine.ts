// The board state machine. The table gives the allowed moves. Sealed evidence gives the position on each call, and no file stores it.
// `transition` is pure and total: each state and event pair has a next state or a typed refusal.
// The position is one of the process states A1 to A25. The B states are rules that hold at any position.
import { releaseEvidence, releaseView } from './board-release.ts';
import { sealStatus } from './cad-seal.ts';
import { changeBlock, type ChangeBlock } from './change-log.ts';
import { layoutGate, layoutPlanStatus } from './layout-plan.ts';
import { runsBase } from './pcb-runs.ts';
import { loadTransitions, type Command, type Evidence, type Freshness, type Guard, type StateId, type TransitionTable } from './transitions.ts';

export const BOARD_STATES = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'A12', 'A13', 'A14', 'A15', 'A16', 'A17', 'A18', 'A19', 'A20', 'A21', 'A22', 'A23', 'A24', 'A25'] as const;
export const CHANGE_KINDS = ['part_swap_new_footprint', 'part_swap_same_footprint', 'part_value_change', 'net_change', 'stackup_change', 'outline_change', 'design_rule_change', 'rule_change', 'route_plan_change', 'datasheet_change', 'out_of_stock', 'approval_withdrawn', 'route_stuck', 'gate_failed', 'drc_failed', 'fab_defect', 'bringup_failure', 'toolchain_change', 'human_edit', 'requirement_change', 'cad_after_order', 'baseline'] as const;

export type BoardState = typeof BOARD_STATES[number];
export type ChangeKind = typeof CHANGE_KINDS[number];
export type BoardEvent = { type: 'command'; command: Command } | { type: 'change'; kind: ChangeKind };
export type Guards = Record<Guard, boolean>;
export type Evidenced = Partial<Record<Evidence, Freshness>>;
export type Moved = { ok: true; state: BoardState; event: BoardEvent; to: BoardState };
export type Refused = { ok: false; state: BoardState; event: BoardEvent; allowed: Command[] } & (
  | { code: 'move_not_allowed' | 'kind_names_no_move' }
  | { code: 'guard_failed'; guard: Guard });
export type Position = { state: BoardState; evidence: Evidence; freshness: Freshness } | { state: BoardState; evidence: null; freshness: null };

const rank = (id: StateId): number => Number(id.slice(1));
const FIRST: BoardState = BOARD_STATES[0];

/** The table with the proof that the unions hold each of its rows. */
export function machineTable(table: TransitionTable): TransitionTable {
  const states = table.states.map(state => state.id).filter(id => id.startsWith('A')), kinds = table.kinds.map(kind => kind.id);
  const missing = [...BOARD_STATES.filter(id => !states.includes(id)), ...states.filter(id => !(BOARD_STATES as readonly string[]).includes(id)),
    ...CHANGE_KINDS.filter(id => !kinds.includes(id)), ...kinds.filter(id => !(CHANGE_KINDS as readonly string[]).includes(id))];
  if (missing.length) throw new Error(`The machine and the table do not agree: ${missing.join(', ')}`);
  return table;
}

const TABLE = machineTable(loadTransitions());

export function allowedEvents(table: TransitionTable, state: BoardState, guards: Guards): Command[] {
  return table.moves.filter(row => row.from.includes(state) && (!row.guard || guards[row.guard])).map(row => row.event);
}

/** The next state of `state` on `event`, or why not. A row that is not in the table is a refusal. */
export function transition(table: TransitionTable, state: BoardState, event: BoardEvent, guards: Guards): Moved | Refused {
  const refused = { ok: false as const, state, event, allowed: allowedEvents(table, state, guards) };
  switch (event.type) {
    case 'command': {
      const row = table.moves.find(entry => entry.event === event.command && entry.from.includes(state));
      if (!row) return { ...refused, code: 'move_not_allowed' };
      if (row.guard && !guards[row.guard]) return { ...refused, code: 'guard_failed', guard: row.guard };
      return { ok: true, state, event, to: (row.to ?? state) as BoardState };
    }
    case 'change': {
      const kind = table.kinds.find(entry => entry.id === event.kind)!;
      if (kind.role === 'delegate') return { ...refused, code: 'kind_names_no_move' };
      const earliest = [...kind.reenter, state].sort((a, b) => rank(a) - rank(b))[0]!;
      return { ok: true, state, event, to: earliest as BoardState };
    }
    default: { const unknown: never = event; throw new Error(`unknown event ${JSON.stringify(unknown)}`); }
  }
}

/** The first state whose evidence is not current. A class with no reader proves nothing, so the walk skips it. */
export function position(table: TransitionTable, found: Evidenced): Position {
  let last: TransitionTable['states'][number] | undefined;
  for (const state of table.states) {
    if (!state.id.startsWith('A') || !state.evidence) continue;
    const freshness = found[state.evidence];
    if (freshness === undefined) continue;
    if (freshness !== 'current' && freshness !== 'exempt') return { state: state.id as BoardState, evidence: state.evidence, freshness };
    last = state;
  }
  return { state: (last ? last.next[0] ?? last.id : FIRST) as BoardState, evidence: null, freshness: null };
}

/** What a call can read with no run: the seal, the layout plan and the release records. A run proves more; `judgedEvidence` of lib/board-view.ts reads that. */
export function commandEvidence(root: string, board: string, base: string = runsBase(root)): Evidenced {
  return { ...designEvidence(root, board), ...releaseEvidence(releaseView(root, board, base)) };
}

function designEvidence(root: string, board: string): Evidenced {
  const seal = sealStatus(root, board).state, layout = layoutPlanStatus(root, board).state;
  const schematic: Freshness = seal === 'sealed' ? 'current' : seal === 'not_canonical' ? 'exempt' : seal === 'changed' ? 'stale' : 'missing';
  if (layout === 'exempt') return { schematic, route_plan: 'exempt', layout_approval: 'exempt' };
  if (layout === 'approved') return { schematic, route_plan: 'current', layout_approval: 'current' };
  if (layout === 'stale') return { schematic, route_plan: 'current', layout_approval: 'stale' };
  if (layout === 'unapproved') return { schematic, route_plan: 'current', layout_approval: 'missing' };
  return { schematic, route_plan: 'missing', layout_approval: 'missing' };
}

/** The event of a run, or null for a run that only reads evidence. */
export function commandOf(operation: string, kind: string | undefined): Command | null {
  if (operation === 'edit') return kind === 'place' || kind === 'route' ? kind : 'edit';
  return (['check', 'build', 'route', 'repair', 'release'] as const).find(name => name === operation) ?? null;
}

function refusal(board: string, command: Command, at: Position, stop: Refused, block: ChangeBlock | null, help: { code: string; message: string } | null, table: TransitionTable): string {
  const name = table.states.find(state => state.id === at.state)!.name;
  const cause = stop.code === 'guard_failed' ? `guard ${stop.guard} failed: ${block?.message ?? 'no cause'}` : at.evidence ? `${at.evidence} is ${at.freshness}` : 'the table has no such move';
  return `${board}: ${command} is refused at ${at.state} (${name}): ${cause}${help ? `\n${help.code}: ${help.message}` : ''}\nAllowed events: ${stop.allowed.join(', ') || 'none'}`;
}

/** Asks the machine for a command, from the position that the evidence gives now. It stops with the state, the event and the allowed events. */
export function assertCommand(root: string, board: string, command: Command, judged: Evidenced = {}, table: TransitionTable = TABLE): void {
  const block = changeBlock(root, board), at = position(table, { ...judged, ...commandEvidence(root, board) });
  const result = transition(table, at.state, { type: 'command', command }, { change_recorded: block === null });
  if (!result.ok) throw new Error(refusal(board, command, at, result, block, at.evidence === 'route_plan' || at.evidence === 'layout_approval' ? layoutGate(root, board, () => {}) : null, table));
}
