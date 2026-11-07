// The change log: hardware-design/boards/BOARD/changes.jsonl is committed and holds why a state went back.
// Each line has a hash of the line before, so a hand edit breaks the chain. A line never makes evidence valid: it adds the reason.
// The log compares each file group with the last recorded hash. A difference with no event stops the work and uses the widest row of the group.
// A board with no log has not started: nothing can compare, and `pcb state` shows that. `--kind baseline` starts the log.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boardShapeSha256 } from './board-shape.ts';
import { isCanonicalRoot, schematicSha256, verifySeal, withSealLock } from './cad-seal.ts';
import { sha256Text } from './fingerprint.ts';
import { sha256File } from './json-file.ts';
import { durableAppend } from './pcb-check-durable.ts';
import { CHANGE_FILE } from './pcb-source-policy.ts';
import { loadTransitions, widestKind, type Kind, type TransitionTable } from './transitions.ts';

type Row = Record<string, unknown>;
export interface GroupChange { before: string | null; after: string }
export interface ChangeEvent {
  id: string; at: string; by: string; kind: string; reason: string; refs: string[];
  groups: Record<string, GroupChange>; prev_sha256: string | null;
}
export interface ChangeRequest { kind: string; reason: string; by: string; refs: string[]; now?: () => Date }
export interface GroupDiff { group: string; recorded: string | null; current: string; kind: Kind }
/** One value of `state` and only the fields that state has. */
export type ChangeStatus =
  | { state: 'not_started'; path: string; events: [] }
  | { state: 'recorded'; path: string; events: ChangeEvent[] }
  | { state: 'unrecorded'; path: string; events: ChangeEvent[]; groups: GroupDiff[] }
  | { state: 'invalid'; path: string; events: []; problems: string[] };
export interface ChangeBlock { code: 'change_unrecorded' | 'change_log_invalid'; message: string }

const KEYS = ['id', 'at', 'by', 'kind', 'reason', 'refs', 'groups', 'prev_sha256'];
const TABLE = loadTransitions();
const isObject = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const eventId = (index: number): string => `c-${String(index + 1).padStart(4, '0')}`;

export const changePath = (root: string, board: string): string => join(root, 'hardware-design/boards', board, CHANGE_FILE);

function rulesSha256(root: string, board: string, files: readonly string[]): string {
  const folder = join(root, 'hardware-design/boards', board);
  return sha256Text(JSON.stringify(Object.fromEntries(files.map(file => [file, existsSync(join(folder, file)) ? sha256File(join(folder, file)) : null]))));
}

/** The hash of each group of the table, in table order. A group with no hash here is an error: the table and the code must agree. */
export function groupHashes(root: string, board: string, table: TransitionTable = TABLE): Record<string, string> {
  return Object.fromEntries(Object.entries(table.groups).map(([group, files]) => {
    if (group === 'schematic') return [group, schematicSha256(root, board)];
    if (group === 'board_shape') return [group, boardShapeSha256(root, board)];
    if (group === 'rules') return [group, rulesSha256(root, board, files)];
    throw new Error(`group ${group} has no hash`);
  }));
}

function checkLine(row: unknown, index: number, previous: string | null, table: TransitionTable): string | null {
  const name = `line ${index + 1}`;
  if (!isObject(row)) return `${name} is not an object`;
  if (Object.keys(row).length !== KEYS.length || KEYS.some(key => !(key in row))) return `${name} has the wrong keys`;
  if (row.id !== eventId(index)) return `${name} must have the id ${eventId(index)}`;
  if (row.prev_sha256 !== (previous === null ? null : sha256Text(previous))) return `${name} does not chain to the line before`;
  const kind = table.kinds.find(entry => entry.id === row.kind);
  if (!kind || kind.role === 'delegate') return `${name} has an unknown kind`;
  if ((kind.role === 'baseline') !== (index === 0)) return `${name}: the baseline is the first line, and only the first line`;
  if (!text(row.by) || !text(row.reason) || !text(row.at) || Number.isNaN(Date.parse(row.at))) return `${name} needs by, reason and at`;
  if (!Array.isArray(row.refs) || !isObject(row.groups)) return `${name} needs refs and groups`;
  return null;
}

/** The events of the log. A broken line or chain is an error. */
export function readChanges(root: string, board: string, table: TransitionTable = TABLE): ChangeEvent[] {
  const path = changePath(root, board);
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf8');
  if (!content.endsWith('\n')) throw new Error('the last line is not complete');
  let previous: string | null = null;
  return content.slice(0, -1).split('\n').map((line, index) => {
    let row: unknown;
    try { row = JSON.parse(line); } catch { throw new Error(`line ${index + 1} is not JSON`); }
    const problem = checkLine(row, index, previous, table);
    if (problem) throw new Error(problem);
    previous = line;
    return row as ChangeEvent;
  });
}

function recorded(events: ChangeEvent[]): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const event of events) for (const [group, change] of Object.entries(event.groups)) hashes[group] = change.after;
  return hashes;
}

/** Where the log of BOARD stands. A broken log or a board that cannot be read is `invalid`: it never reads as recorded. */
export function changeStatus(root: string, board: string, table: TransitionTable = TABLE): ChangeStatus {
  const path = changePath(root, board);
  if (!existsSync(path)) return { state: 'not_started', path, events: [] };
  try {
    const events = readChanges(root, board, table), last = recorded(events), now = groupHashes(root, board, table);
    const groups = Object.entries(now).filter(([group, hash]) => last[group] !== hash)
      .map(([group, current]) => ({ group, recorded: last[group] ?? null, current, kind: widestKind(table, group) }));
    return groups.length ? { state: 'unrecorded', path, events, groups } : { state: 'recorded', path, events };
  } catch (error) { return { state: 'invalid', path, events: [], problems: [(error as Error).message] }; }
}

const rowText = (kind: Kind): string => `re-enter ${kind.reenter.join(' or ')}; redo ${kind.redo.join(', ')}; keep ${kind.keep.join(', ') || 'nothing'}`;

/** null when each change has an event. Else the stop and the way to continue. */
export function changeBlock(root: string, board: string, table: TransitionTable = TABLE): ChangeBlock | null {
  const status = changeStatus(root, board, table);
  if (status.state === 'invalid') return { code: 'change_log_invalid', message: `The change log of ${board} is not valid (${status.path}):\n  ${status.problems.join('\n  ')}\nRestore the file from git, or fix the board that it cannot read.` };
  if (status.state !== 'unrecorded') return null;
  const rows = status.groups.map(row => `${row.group}: ${rowText(row.kind)}`);
  return { code: 'change_unrecorded', message: `${board} has a change with no event:\n  ${rows.join('\n  ')}\nName the change: tools/pcb change ${board} --kind KIND --reason TEXT --by NAME` };
}

/** `pcb change`: appends one event under the seal lock. It reads no evidence and writes none. */
export function recordChange(root: string, board: string, request: ChangeRequest, table: TransitionTable = TABLE): ChangeEvent {
  const { reason, by, refs, now = () => new Date() } = request, kind = table.kinds.find(entry => entry.id === request.kind);
  if (!kind) throw new Error(`unknown change kind ${request.kind}: ${table.kinds.filter(entry => entry.role !== 'delegate').map(entry => entry.id).join(', ')}`);
  if (kind.role === 'delegate') throw new Error(`${kind.id} names no change: use the kind of the change that the edit made`);
  if (!reason?.trim()) throw new Error('pcb change requires --reason TEXT');
  if (!by?.trim()) throw new Error('pcb change requires --by NAME');
  if (!isCanonicalRoot(root)) throw new Error(`${root} is a run workspace or candidate copy, not canonical; it has no change log`);
  return withSealLock(root, board, () => {
    const status = changeStatus(root, board, table);
    if (status.state === 'invalid') throw new Error(`The change log of ${board} is not valid:\n  ${status.problems.join('\n  ')}`);
    if (kind.role === 'baseline' && status.state !== 'not_started') throw new Error(`${board} already has a baseline`);
    if (kind.role !== 'baseline' && status.state === 'not_started') throw new Error(`${board} has no change log. Start it: tools/pcb change ${board} --kind baseline --reason TEXT --by NAME`);
    if (kind.role === 'baseline' || kind.group) verifySeal(root, board);
    const hashes = kind.role === 'baseline' || kind.group ? groupHashes(root, board, table) : {}, last = recorded(status.events);
    if (kind.group && last[kind.group] === hashes[kind.group]) throw new Error(`no change in group ${kind.group} since the last event`);
    const names = kind.role === 'baseline' ? Object.keys(hashes) : kind.group ? [kind.group] : [];
    const groups = Object.fromEntries(names.map(group => [group, { before: last[group] ?? null, after: hashes[group]! }]));
    const path = changePath(root, board), previous = existsSync(path) ? readFileSync(path, 'utf8').slice(0, -1).split('\n').at(-1)! : null;
    const event: ChangeEvent = { id: eventId(status.events.length), at: now().toISOString(), by: by.trim(), kind: kind.id, reason: reason.trim(), refs, groups, prev_sha256: previous === null ? null : sha256Text(previous) };
    durableAppend(path, JSON.stringify(event) + '\n');
    return event;
  });
}
