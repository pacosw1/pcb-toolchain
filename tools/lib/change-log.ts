// The change log: hardware-design/boards/BOARD/changes.jsonl is committed and holds why a state went back.
// Each line has a hash of the line before, and cad-seal.json holds the hash of the whole log. A hand edit or a delete of the log fails closed, for the last line too.
// A line never makes evidence valid: it adds the reason.
// The log compares each file group with the last recorded hash. A difference with no event stops the work and uses the widest row of the group.
// The log is mandatory: a sealed board with no log stops at each guarded command until `--kind baseline` starts the log.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boardFacts, boardShapeSha256 } from './board-shape.ts';
import { bindChangeLog, heldFiles, isCanonicalRoot, movedFiles, reseal, schematicFiles, schematicSha256, sealedChangeLog, sealedFiles, sealedJson, verifySeal, withSealLock } from './cad-seal.ts';
import { sha256Text } from './fingerprint.ts';
import { sha256File } from './json-file.ts';
import { durableAppend } from './pcb-check-durable.ts';
import { layoutPlanStatus } from './layout-plan.ts';
import { CHANGE_FILE } from './pcb-source-policy.ts';
import { releaseApprovalPath } from './release-approval.mjs';
import { releaseOrders } from './release-order.mjs';
import { loadTransitions, widestKind, type Kind, type TransitionTable } from './transitions.ts';

type Row = Record<string, unknown>;
export interface GroupChange { before: string | null; after: string; facts: Record<string, string> }
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
export interface ChangeBlock { code: 'change_unrecorded' | 'change_log_invalid' | 'change_log_missing'; message: string }

const KEYS = ['id', 'at', 'by', 'kind', 'reason', 'refs', 'groups', 'prev_sha256'];
const TABLE = loadTransitions();
const isObject = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const eventId = (index: number): string => `c-${String(index + 1).padStart(4, '0')}`;

export const changePath = (root: string, board: string): string => join(root, 'hardware-design/boards', board, CHANGE_FILE);

function rulesSha256(root: string, board: string, names: readonly string[], files: Record<string, string>): string {
  const named = Object.fromEntries(names.map(file => [file, files[`hardware-design/boards/${board}/${file}`] ?? null]));
  return sha256Text(JSON.stringify({ ...named, ...sealedJson(root, board, files) }));   // a missing file is a value, and each rule file of a check joins the fixed names
}

/** The hash of each group of the table, in table order, from FILES: the files now, or the files of a seal. A group with no hash here is an error: the table and the code must agree. */
export function groupHashes(root: string, board: string, table: TransitionTable = TABLE, sealed: Record<string, string> = sealedFiles(root, board)): Record<string, string> {
  return Object.fromEntries(Object.entries(table.groups).map(([group, files]) => {
    if (group === 'schematic') return [group, schematicSha256(root, board, sealed)];
    if (group === 'board_shape') return [group, boardShapeSha256(root, board)];
    if (group === 'rules') return [group, rulesSha256(root, board, files, sealed)];
    throw new Error(`group ${group} has no hash`);
  }));
}

const PART_TEXT = /(\(property "(?:Value|Footprint)" ")((?:[^"\\]|\\.)*)"/g;

/** One hash for each fact of the schematic group. A value and a footprint are fields; each other difference counts as wiring. */
function schematicFacts(root: string, board: string): Record<string, string> {
  const texts = schematicFiles(root, board).map(path => readFileSync(path, 'utf8'));
  const field = (name: string): string => sha256Text(JSON.stringify(texts.flatMap(text => [...text.matchAll(PART_TEXT)].filter(match => match[1]!.includes(name)).map(match => match[2]))));
  return { values: field('"Value"'), footprints: field('"Footprint"'), wiring: sha256Text(JSON.stringify(texts.map(text => text.replace(PART_TEXT, '$1"')))) };
}

function factsOf(root: string, board: string, group: string, hash: string): Record<string, string> {
  return group === 'schematic' ? schematicFacts(root, board) : group === 'board_shape' ? boardFacts(root, board) : { all: hash };
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

/** The facts of GROUP at the last event that recorded it. */
function recordedFacts(events: ChangeEvent[], group: string): Record<string, string> {
  return events.findLast(event => group in event.groups)?.groups[group]?.facts ?? {};
}

const DECISIONS = ['new_revision', 'use_as_is', 'reorder'];
const isOrdered = (root: string, board: string, hash: string | undefined): boolean => releaseOrders(root, board).some((order: { candidate_sha256: string }) => order.candidate_sha256 === hash);

function defects(events: ChangeEvent[]): Set<string> {
  const open = new Set<string>();
  for (const event of events) {
    if (event.kind === 'fab_defect' || event.kind === 'bringup_failure') open.add(event.refs[0]!);
    if (event.kind === 'defect_closed') open.delete(event.refs[0]!);
  }
  return open;
}

/** The release hashes with a defect that no `defect_closed` ended. An unreadable log throws: the callers stop on it. */
export const openDefects = (root: string, board: string): Set<string> => defects(readChanges(root, board));

/** The release hashes that a person ended: their CAD is free for a new revision. An order of such a hash proves no position. */
export const closedRevisions = (root: string, board: string): Set<string> => new Set(readChanges(root, board)
  .filter(event => event.kind === 'cad_after_order' || (event.kind === 'defect_closed' && event.refs[1] === 'new_revision')).map(event => event.refs[0]!));

/** The event that withdrew this approval, as a stale line, or null. A log that cannot be read proves no approval. */
export function withdrawnBy(root: string, board: string, target: 'layout' | 'release', sha256: string): string | null {
  try {
    const event = readChanges(root, board).find(row => row.kind === 'approval_withdrawn' && row.refs[0] === target && row.refs[1] === sha256);
    return event ? `the approval was withdrawn by ${event.id}: ${event.reason}` : null;
  } catch (error) { return `the change log cannot be read: ${(error as Error).message}`; }
}

/** A stale line when an event of the rules group that redoes the layout approval comes after the event AFTER. An approval from before that key has no event, so each such event counts. */
export function rulesChangedSince(root: string, board: string, after: string | undefined, table: TransitionTable = TABLE): string | null {
  try {
    const event = readChanges(root, board, table).findLast(row => 'rules' in row.groups && row.id > (after ?? '') && table.kinds.find(kind => kind.id === row.kind)!.redo.includes('layout_approval'));
    return event ? `the rules changed by ${event.id} after the approval: ${event.reason}` : null;
  } catch (error) { return `the change log cannot be read: ${(error as Error).message}`; }
}

/** The hash that names the current approval of TARGET. */
function approvalSha256(root: string, board: string, target: string): string {
  if (target === 'release' && existsSync(releaseApprovalPath(root, board))) return sha256File(releaseApprovalPath(root, board));
  const approval = target === 'layout' ? layoutPlanStatus(root, board).approval : null;
  if (approval) return sha256Text(JSON.stringify(approval));
  throw new Error(`${board} has no ${target} approval to withdraw`);
}

/** The refs of the event. A kind that names a release or an approval must name a real one. The reason and the facts of a defect stay the claim of a person. */
function eventRefs(root: string, board: string, kind: string, refs: string[], events: ChangeEvent[], table: TransitionTable): string[] {
  const [first, second] = refs;
  if (kind === 'cad_moved') {
    if (refs.length) throw new Error('cad_moved takes no --refs: the seal and the files give the paths');
    const paths = movedFiles(root, board), last = recorded(events), held = groupHashes(root, board, table, heldFiles(root, board)!);
    const open = Object.keys(held).filter(group => held[group] !== last[group]);   // a move must not carry a change that has no event
    if (open.length) throw new Error(`${board} has a change with no event in ${open.join(', ')}. Name that change before the move`);
    return paths;
  }
  if (kind === 'approval_withdrawn') {
    if (refs.length !== 1 || (first !== 'layout' && first !== 'release')) throw new Error('approval_withdrawn requires --refs layout or --refs release');
    return [first, approvalSha256(root, board, first)];
  }
  if (kind === 'defect_closed') {
    if (refs.length !== 2 || !DECISIONS.includes(second!)) throw new Error(`defect_closed requires --refs SHA,DECISION with a decision of ${DECISIONS.join(', ')}`);
    if (!defects(events).has(first!)) throw new Error(`release ${first} has no open defect`);
    return refs;
  }
  if (kind === 'fab_defect' || kind === 'bringup_failure' || kind === 'cad_after_order') {
    if (refs.length !== 1 || !isOrdered(root, board, first)) throw new Error(`${kind} requires --refs SHA: the release hash of a recorded order of ${board}`);
  }
  return refs;
}

/** A kind names what it changed. The diff checks that name: each fact that changed must be one that the kind explains. */
function assertExplained(kind: Kind, before: Record<string, string>, now: Record<string, string>, table: TransitionTable): void {
  const wrong = Object.keys(now).filter(fact => before[fact] !== now[fact] && !kind.explains!.includes(fact));
  if (!wrong.length) return;
  const others = table.kinds.filter(row => row.group === kind.group && wrong.every(fact => row.explains!.includes(fact))).map(row => row.id);
  throw new Error(`${kind.id} cannot explain the change of ${wrong.join(', ')} in group ${kind.group}. Use ${others.join(' or ')}`);
}

/** The log must be the one that the seal holds. A workspace copy has no log and a board with no seal has no hash, so neither has a compare. */
function assertBound(root: string, board: string, path: string): void {
  const bound = sealedChangeLog(root, board), head = existsSync(path) ? sha256File(path) : null;
  if (bound === undefined || bound === head) return;
  throw new Error(head === null ? 'the seal holds a change log, and the file is gone' : 'the change log is not the one that the seal holds');
}

/** True when HASH is an earlier hash of GROUP and only cad_moved events lie after it: the bytes are the same at new paths. An unrecorded change or a bad log gives false. */
export function movedSince(root: string, board: string, group: string, hash: string): boolean {
  const status = changeStatus(root, board);
  if (status.state !== 'recorded') return false;
  for (const event of status.events.filter(row => group in row.groups).reverse()) {
    if (event.kind !== 'cad_moved') return false;
    if (event.groups[group]!.before === hash) return true;
  }
  return false;
}

/** Where the log of BOARD stands. A broken, missing or unbound log or a board that cannot be read is `invalid`: it never reads as recorded. */
export function changeStatus(root: string, board: string, table: TransitionTable = TABLE): ChangeStatus {
  const path = changePath(root, board);
  try {
    assertBound(root, board, path);
    if (!existsSync(path)) return { state: 'not_started', path, events: [] };
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
  if (status.state === 'invalid') return { code: 'change_log_invalid', message: `The change log of ${board} is not valid (${status.path}):\n  ${status.problems.join('\n  ')}\nRestore the log and cad-seal.json from git, or fix the board that it cannot read.` };
  if (status.state === 'not_started') return sealedChangeLog(root, board) === undefined ? null : { code: 'change_log_missing', message: `${board} has no change log (${status.path}). Start it: tools/pcb change ${board} --kind baseline --reason TEXT --by NAME` };
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
    const hashes = kind.role === 'change' && !kind.group ? {} : groupHashes(root, board, table), last = recorded(status.events);
    if (kind.group && last[kind.group] === hashes[kind.group]) throw new Error(`no change in group ${kind.group} since the last event`);
    const names = kind.role === 'baseline' ? Object.keys(hashes) : kind.group ? [kind.group] : Object.keys(hashes).filter(group => last[group] !== hashes[group]);
    const groups = Object.fromEntries(names.map(group => [group, { before: last[group] ?? null, after: hashes[group]!, facts: factsOf(root, board, group, hashes[group]!) }]));
    if (kind.group) assertExplained(kind, recordedFacts(status.events, kind.group), groups[kind.group]!.facts, table);
    const named = eventRefs(root, board, kind.id, refs, status.events, table);
    const path = changePath(root, board), previous = existsSync(path) ? readFileSync(path, 'utf8').slice(0, -1).split('\n').at(-1)! : null;
    const event: ChangeEvent = { id: eventId(status.events.length), at: now().toISOString(), by: by.trim(), kind: kind.id, reason: reason.trim(), refs: named, groups, prev_sha256: previous === null ? null : sha256Text(previous) };
    durableAppend(path, JSON.stringify(event) + '\n');
    if (kind.role === 'move') reseal(root, board, { tool: 'pcb change', run_id: null }, reason.trim());
    bindChangeLog(root, board, sha256File(path));   // a crash before this line leaves a log that fails closed
    return event;
  });
}
