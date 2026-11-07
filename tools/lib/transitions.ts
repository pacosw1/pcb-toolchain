// The transition table: states, inputs, outputs, allowed transitions, and what a change invalidates.
// tools/pcb-transitions.json is data. It holds no state of a board: state comes from sealed evidence and hashes.
// parseTransitions is the only way to get a table: a table that can represent a bad state does not load.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TRANSITIONS_SCHEMA = 'iot-lab.transitions.v1';
export const STATUSES = ['enforced', 'recorded', 'implicit'] as const;
export const EVIDENCE = ['design_assessment', 'part_review', 'schematic', 'bom', 'stackup', 'rules', 'route_plan', 'layout_approval', 'placement', 'copper', 'gate', 'release', 'release_approval', 'readiness', 'order', 'bringup'] as const;
export const APPROVALS = ['part_review', 'layout_approval', 'seal_accept', 'substitute_choice', 'route_move', 'defect_decision', 'assessment_review', 'new_revision'] as const;
export const ROLES = ['change', 'delegate', 'baseline'] as const;

export type StateId = `${'A' | 'B'}${number}`;
export type Status = typeof STATUSES[number];
export type Evidence = typeof EVIDENCE[number];
export type Approver = typeof APPROVALS[number];
export type Role = typeof ROLES[number];
/** `unknown` is what a class with no proof gives. It never counts as current. */
export type Freshness = 'current' | 'stale' | 'missing' | 'exempt' | 'unknown';

export interface Item { readonly name: string; readonly path?: string }
export interface BackEdge { readonly to: StateId; readonly on: string }
export interface State {
  readonly id: StateId; readonly name: string; readonly status: Status; readonly evidence: Evidence | null;
  readonly next: readonly StateId[]; readonly back: readonly BackEdge[];
  readonly inputs: readonly Item[]; readonly outputs: readonly Item[]; readonly gap?: string;
}
export interface Kind {
  readonly id: string; readonly doc: string; readonly role: Role; readonly group: string | null; readonly reenter: readonly StateId[];
  readonly redo: readonly Evidence[]; readonly keep: readonly Evidence[]; readonly approve: readonly Approver[];
}
export interface TransitionTable {
  readonly schema: typeof TRANSITIONS_SCHEMA; readonly groups: Readonly<Record<string, readonly string[]>>;
  readonly states: readonly State[]; readonly kinds: readonly Kind[];
}
export interface RedoRow { evidence: Evidence; status: Freshness; cause?: string }
export type Readers = Partial<Record<Evidence, () => Freshness>>;

type Row = Record<string, unknown>;
const TOP_KEYS = ['schema', 'groups', 'states', 'kinds'];
const STATE_KEYS = ['id', 'name', 'status', 'evidence', 'next', 'back', 'inputs', 'outputs', 'gap'];
const KIND_KEYS = ['id', 'doc', 'role', 'group', 'reenter', 'redo', 'keep', 'approve'];
const PLACEHOLDERS = ['board', 'project', 'run'];
const STATE_ID = /^[AB][1-9]\d*$/;
const FILE = fileURLToPath(new URL('../pcb-transitions.json', import.meta.url));

const isObject = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const member = <T extends string>(values: readonly T[], value: unknown): value is T => (values as readonly unknown[]).includes(value);
const rank = (id: string): number => Number(id.slice(1));
const inProcess = (id: string): boolean => id.startsWith('A');

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

function checkItems(id: string, label: string, state: Row, problems: string[]): void {
  const items = state[label];
  if (!Array.isArray(items)) { problems.push(`${id}: ${label} must be a list`); return; }
  if (!items.length && !text(state.gap)) problems.push(`${id}: ${label} may be empty only with a gap`);
  for (const item of items) {
    if (!isObject(item) || !text(item.name) || Object.keys(item).some(key => key !== 'name' && key !== 'path')) { problems.push(`${id}: ${label} item needs a name and an optional path`); continue; }
    if (item.path === undefined) continue;
    if (!text(item.path)) { problems.push(`${id}: ${label} path must be text`); continue; }
    for (const [, name] of item.path.matchAll(/\{([^}]*)\}/g)) if (!PLACEHOLDERS.includes(name!)) problems.push(`${id}: unknown placeholder {${name}}`);
  }
}

function checkState(state: unknown, ids: Set<string>, problems: string[]): void {
  if (!isObject(state)) { problems.push('a state must be an object'); return; }
  const id = String(state.id);
  for (const key of Object.keys(state)) if (!STATE_KEYS.includes(key)) problems.push(`${id}: unknown key ${key}`);
  if (!text(state.name)) problems.push(`${id}: name must be text`);
  if (!member(STATUSES, state.status)) problems.push(`${id}: status must be one of ${STATUSES.join(', ')}`);
  if (state.evidence !== null && !member(EVIDENCE, state.evidence)) problems.push(`${id}: evidence ${String(state.evidence)} is not a class`);
  if (state.gap !== undefined && !text(state.gap)) problems.push(`${id}: gap must be text`);
  checkItems(id, 'inputs', state, problems);
  checkItems(id, 'outputs', state, problems);
  if (!Array.isArray(state.next)) problems.push(`${id}: next must be a list`);
  if (!Array.isArray(state.back)) problems.push(`${id}: back must be a list`);
  for (const target of list(state.next)) {
    if (!ids.has(String(target))) problems.push(`${id}: next ${String(target)} is not a state`);
    else if (inProcess(id) && inProcess(String(target)) && rank(String(target)) <= rank(id)) problems.push(`${id}: next ${String(target)} is not forward`);
  }
  for (const edge of list(state.back)) {
    const target = isObject(edge) ? String(edge.to) : String(edge);
    if (!isObject(edge) || !ids.has(target)) { problems.push(`${id}: back ${target} is not a state`); continue; }
    if (!text(edge.on)) problems.push(`${id}: back ${target} needs a code`);
    if (inProcess(id) && inProcess(target) && rank(target) > rank(id)) problems.push(`${id}: back ${target} is not backward`);
  }
}

/** A1 starts the process and each state can be reached. Only the last state has no way out. */
function checkFlow(states: Row[], problems: string[]): void {
  const process = states.filter(state => inProcess(String(state.id)));
  const last = process.at(-1)?.id;
  for (const state of process) if (!list(state.next).length && !list(state.back).length && state.id !== last) problems.push(`${String(state.id)}: only the last state may have no next state`);
  const byId = new Map(states.map(state => [String(state.id), state])), seen = new Set<string>(), queue = ['A1'];
  while (queue.length) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const target of list(byId.get(id)?.next)) queue.push(String(target));
  }
  for (const state of process) if (!seen.has(String(state.id))) problems.push(`${String(state.id)} cannot be reached from A1`);
}

function checkKind(kind: unknown, ids: Set<string>, groups: string[], problems: string[]): void {
  if (!isObject(kind)) { problems.push('a kind must be an object'); return; }
  const id = String(kind.id);
  for (const key of Object.keys(kind)) if (!KIND_KEYS.includes(key)) problems.push(`${id}: unknown key ${key}`);
  if (!text(kind.doc)) problems.push(`${id}: doc must be text`);
  if (!member(ROLES, kind.role)) problems.push(`${id}: role must be one of ${ROLES.join(', ')}`);
  if (kind.group !== null && !groups.includes(String(kind.group))) problems.push(`${id}: group ${String(kind.group)} is not a group`);
  for (const target of list(kind.reenter)) if (!ids.has(String(target))) problems.push(`${id}: reenter ${String(target)} is not a state`);
  for (const key of ['redo', 'keep'] as const) for (const item of list(kind[key])) if (!member(EVIDENCE, item)) problems.push(`${id}: ${key} ${String(item)} is not a class`);
  for (const item of list(kind.approve)) if (!member(APPROVALS, item)) problems.push(`${id}: approve ${String(item)} is not an approver`);
  for (const item of list(kind.redo)) if (list(kind.keep).includes(item)) problems.push(`${id}: ${String(item)} is in redo and keep`);
  if (kind.role === 'change' && !list(kind.reenter).length) problems.push(`${id}: reenter needs at least one state`);
  if (kind.role !== 'change' && (kind.group !== null || list(kind.reenter).length || list(kind.redo).length || list(kind.keep).length)) problems.push(`${id}: role ${String(kind.role)} has no group, reenter, redo or keep`);
}

/** The first row of a group re-enters first and redoes all that the other rows redo. With no event, this row is the answer. */
function checkWidest(kinds: Row[], groups: string[], problems: string[]): void {
  for (const group of groups) {
    const rows = kinds.filter(kind => kind.group === group);
    if (!rows.length) { problems.push(`group ${group} has no kind`); continue; }
    const [first, ...others] = rows as [Row, ...Row[]], earliest = Math.min(...list(first.reenter).map(id => rank(String(id))));
    for (const other of others) {
      for (const item of list(other.redo)) if (!list(first.redo).includes(item)) problems.push(`${String(first.id)} is not the widest row of ${group}: it does not redo ${String(item)}`);
      for (const target of list(other.reenter)) if (rank(String(target)) < earliest) problems.push(`${String(first.id)} is not the widest row of ${group}: ${String(other.id)} re-enters ${String(target)}`);
    }
  }
}

/** The table, or an error that lists all problems. */
export function parseTransitions(raw: unknown): TransitionTable {
  if (!isObject(raw)) throw new Error('the transition table must be an object');
  const problems: string[] = [];
  for (const key of Object.keys(raw)) if (!TOP_KEYS.includes(key)) problems.push(`unknown key ${key}`);
  if (raw.schema !== TRANSITIONS_SCHEMA) problems.push(`schema must be ${TRANSITIONS_SCHEMA}`);
  if (!isObject(raw.groups)) problems.push('groups must be an object');
  const groups = isObject(raw.groups) ? Object.keys(raw.groups) : [];
  const states = list(raw.states).filter(isObject), kinds = list(raw.kinds).filter(isObject);
  if (!states.length) problems.push('states must be a non-empty list');
  if (!kinds.length) problems.push('kinds must be a non-empty list');
  for (const group of groups) if (!list((raw.groups as Row)[group]).length) problems.push(`group ${group} has no files`);
  const ids = new Set<string>();
  for (const state of states) {
    const id = String(state.id);
    if (!STATE_ID.test(id)) problems.push(`state id ${id} is not valid`);
    if (ids.has(id)) problems.push(`duplicate state ${id}`);
    ids.add(id);
  }
  const names = new Set<string>();
  for (const kind of kinds) {
    if (!text(kind.id)) problems.push('a kind needs an id');
    if (names.has(String(kind.id))) problems.push(`duplicate kind ${String(kind.id)}`);
    names.add(String(kind.id));
  }
  for (const state of states) checkState(state, ids, problems);
  for (const kind of kinds) checkKind(kind, ids, groups, problems);
  checkFlow(states, problems);
  checkWidest(kinds, groups, problems);
  if (problems.length) throw new Error(`The transition table is not valid:\n  ${problems.join('\n  ')}`);
  return deepFreeze(raw) as unknown as TransitionTable;
}

export const loadTransitions = (path: string = FILE): TransitionTable => parseTransitions(JSON.parse(readFileSync(path, 'utf8')));

/** The first row of a group: what a change with no event must assume. */
export function widestKind(table: TransitionTable, group: string): Kind {
  const kind = table.kinds.find(row => row.group === group);
  if (!kind) throw new Error(`group ${group} has no kind`);
  return kind;
}

/** Asks the reader of each class in `redo`, in table order. No reader, or a reader that fails, gives `unknown`: never `current`. */
export function redoFor(kind: Kind, readers: Readers): RedoRow[] {
  return kind.redo.map(evidence => {
    const reader = readers[evidence];
    if (!reader) return { evidence, status: 'unknown' as const, cause: 'no reader' };
    try { return { evidence, status: reader() }; }
    catch (error) { return { evidence, status: 'unknown' as const, cause: (error as Error).message }; }
  });
}
