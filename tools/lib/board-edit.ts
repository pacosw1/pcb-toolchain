// Edits to a board as text, for tools that used to save through pcbnew. Reads go through the KiCad API (board JSON); nothing
// is ever saved from nightly. An edit goes into a copy of the board as text, then one KiCad 10 kicad-cli DRC with parity
// refills every zone and saves, and KiCad puts new items in their place on that save. tools/router/core/src/write.rs does the
// same for route results inside a job, where there is no node; mmText, quoted and itemUuid must keep its results.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { kicadCli } from './env.mjs';
import { readJson } from './json-file.ts';
import { kids, parse } from './sexpr.ts';

const NM_PER_MM = 1_000_000;
const FORM_NAME = /[^\s()"]*/y;

/** Millimetres as KiCad's text, by way of whole nanometres. The cut toward zero is pcbnew.FromMM's. */
export function mmText(mm: number): string {
  const nm = Math.trunc(mm * NM_PER_MM);
  const whole = Math.trunc(Math.abs(nm) / NM_PER_MM);
  const fraction = String(Math.abs(nm) % NM_PER_MM).padStart(6, '0').replace(/0+$/, '');
  return `${nm < 0 ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** A KiCad string: the characters a quoted name can hold. */
export const quoted = (text: string): string => `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

/** A UUID from the seed and the item's number: the same input gives the same ids, so the same file. */
export function itemUuid(seed: string, n: number): string {
  const h = createHash('sha256').update(`${seed}:${n}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Ids for the new items of one edit: seeded by the board's text, so a rerun on a changed board cannot repeat one. */
export function itemIds(board: string, tool: string): () => string {
  const seed = `${tool}:${createHash('sha256').update(board).digest('hex')}`;
  let n = 0;
  return () => itemUuid(seed, n++);
}

export interface Span { kind: string; start: number; end: number }
/** A PCB_GROUP as the file holds it: a (group ...) form that names its members by uuid. */
export interface BoardGroup { uuid: string; name: string; members: string[] }

/** Each form that holds a (uuid "...") child, by that uuid, at any depth: board items and the items inside footprints. */
export function formsByUuid(board: string): Map<string, Span> {
  const forms = new Map<string, Span>();
  const open: { kind: string; start: number; uuid?: string }[] = [];
  let at = 0;
  while (at < board.length) {
    const c = board[at]!;
    if (c === '"') {
      at = stringEnd(board, at);
    } else if (c === '(') {
      FORM_NAME.lastIndex = at + 1;
      open.push({ kind: FORM_NAME.exec(board)![0], start: at });
      at += 1;
    } else if (c === ')') {
      const form = open.pop();
      if (!form) throw new Error('the board text has an unmatched )');
      if (form.kind === 'uuid') {
        const parent = open.at(-1);
        if (parent) parent.uuid = board.slice(form.start, at).match(/"([^"]*)"/)?.[1];
      } else if (form.uuid) {
        forms.set(form.uuid, { kind: form.kind, start: form.start, end: at + 1 });
      }
      at += 1;
    } else {
      at += 1;
    }
  }
  if (open.length) throw new Error('the board text does not close');
  return forms;
}

/** Where the form that opens at `open` ends, past its closing parenthesis, skipping quoted text. */
export function formEnd(board: string, open: number): number {
  let depth = 0;
  for (let at = open; at < board.length;) {
    const c = board[at]!;
    if (c === '"') {
      at = stringEnd(board, at);
      continue;
    }
    if (c === '(') depth += 1;
    if (c === ')' && --depth === 0) return at + 1;
    at += 1;
  }
  throw new Error('the board text does not close');
}

function stringEnd(board: string, open: number): number {
  for (let at = open + 1; at < board.length; at++) {
    if (board[at] === '\\') at += 1;
    else if (board[at] === '"') return at + 1;
  }
  throw new Error('the board text has an unterminated string');
}

/** Pending changes to one board text. Offsets refer to the text it was made with, so changes do not disturb each other. */
export class BoardEdit {
  readonly #board: string;
  readonly #forms: Map<string, Span>;
  readonly #changes: (Span & { text: string })[] = [];
  readonly #removed = new Set<string>();
  #added = '';

  constructor(board: string) {
    this.#board = board;
    this.#forms = formsByUuid(board);
  }

  /** The text of the item, so a tool can change one field of it and hand it to replace(). */
  textOf(uuid: string): string {
    const form = this.#form(uuid);
    return this.#board.slice(form.start, form.end);
  }

  /** Adds an item before the board's closing parenthesis. */
  add(itemText: string): void {
    this.#added += itemText;
  }

  /** Removes the item; text() takes it out of its group too. */
  remove(uuid: string): void {
    this.replace(uuid, '');
    this.#removed.add(uuid);
  }

  groups(): BoardGroup[] {
    return [...this.#forms].filter(([, form]) => form.kind === 'group').map(([uuid, { start, end }]) => {
      const form = parse(this.#board.slice(start, end));
      return { uuid, name: String(form[1]), members: (kids(form, 'members')[0] ?? []).slice(1).map(String) };
    });
  }

  /** Removes a group with all it holds, as pcbnew did item by item. A member the file no longer has is skipped. */
  removeGroup(group: BoardGroup): void {
    const groups = new Map(this.groups().map(known => [known.uuid, known]));
    for (const member of group.members) {
      const inner = groups.get(member);
      if (inner) this.removeGroup(inner);
      else if (this.#forms.has(member)) this.remove(member);
    }
    this.remove(group.uuid);
  }

  /** Adds a group of items, new or already on the board. */
  addGroup(name: string, members: string[], uuid: string): void {
    this.add(groupText(name, members, uuid));
  }

  replace(uuid: string, itemText: string): void {
    const form = this.#form(uuid);
    const clash = this.#changes.find(change => form.start < change.end && change.start < form.end);
    if (clash) throw new Error(`board edit: ${uuid} overlaps an item already changed`);
    this.#changes.push({ ...form, text: itemText });
  }

  text(): string {
    const close = this.#board.lastIndexOf(')');
    if (close < 0) throw new Error('the board file has no closing parenthesis');
    const pieces: string[] = [];
    let at = 0;
    for (const change of [...this.#changes, ...this.#groupChanges()].sort((a, b) => a.start - b.start)) {
      pieces.push(this.#board.slice(at, change.start), change.text);
      at = change.end;
    }
    return [...pieces, this.#board.slice(at, close), this.#added, this.#board.slice(close)].join('');
  }

  /** The groups that lost a member and are not removed themselves. A group left with no member goes: KiCad saves none. */
  #groupChanges(): (Span & { text: string })[] {
    return this.groups().filter(group => !this.#removed.has(group.uuid) && group.members.some(member => this.#removed.has(member)))
      .map(group => {
        const members = group.members.filter(member => !this.#removed.has(member));
        return { ...this.#form(group.uuid), text: members.length ? groupText(group.name, members, group.uuid) : '' };
      });
  }

  #form(uuid: string): Span {
    const form = this.#forms.get(uuid);
    if (!form) throw new Error(`board edit: no item with uuid ${uuid}`);
    return form;
  }
}

function groupText(name: string, members: string[], uuid: string): string {
  return `\t(group ${quoted(name)}\n\t\t(uuid ${quoted(uuid)})\n\t\t(members ${members.map(quoted).join(' ')})\n\t)\n`;
}

/** The project next to the board: the one of its name when there is one, else the last by name, else null. */
export function projectName(pcb: string): string | null {
  const names = readdirSync(dirname(pcb)).filter(name => name.endsWith('.kicad_pro')).map(name => name.slice(0, -'.kicad_pro'.length)).sort();
  const own = basename(pcb).replace(/\.kicad_pcb$/, '');
  return names.includes(own) ? own : names.at(-1) ?? null;
}

export interface DrcItem { description: string }
export interface DrcViolation { type?: string; severity?: string; items?: DrcItem[] }
/** kicad-cli's JSON report, as far as the tools read it. */
export interface DrcFile { violations?: DrcViolation[]; unconnected_items?: { items: DrcItem[] }[]; schematic_parity?: unknown[] }

export interface SaveReport {
  board: string;
  /** Errors by type. */
  violations: Record<string, number>;
  errors: number;
  unconnected: number;
  parity: number;
  passed: boolean;
  /** The whole report: warnings too, for a tool that prints a summary of them. */
  drc: DrcFile;
}

function readReport(file: string): Omit<SaveReport, 'board'> {
  const drc = readJson<DrcFile>(file);
  const violations: Record<string, number> = {};
  for (const { type = '?', severity = 'error' } of drc.violations ?? []) {
    if (severity === 'error') violations[type] = (violations[type] ?? 0) + 1;
  }
  const errors = Object.values(violations).reduce((sum, count) => sum + count, 0);
  const unconnected = drc.unconnected_items?.length ?? 0;
  const parity = drc.schematic_parity?.length ?? 0;
  return { violations, errors, unconnected, parity, passed: errors === 0 && unconnected === 0 && parity === 0, drc };
}

/** The one KiCad 10 save: refills every zone, checks with parity and writes the board in place. */
function runSave(board: string, report: string) {
  return spawnSync(kicadCli, ['pcb', 'drc', '--schematic-parity', '--refill-zones', '--save-board', '--format', 'json',
    '--output', report, board], { encoding: 'utf8' });
}

/**
 * Writes `text` as the board of a project copy in `outDir`, then saves it with one kicad-cli run. The source project is only
 * read. A save can rewrite .kicad_pro with defaults, so the original goes back after it. A failed DRC is a report, not an
 * error: the caller decides what it means for its edit.
 */
export function saveBoard(pcb: string, text: string, outDir: string): SaveReport {
  const source = dirname(pcb);
  const project = projectName(pcb);
  if (project === null) throw new Error(`no .kicad_pro next to ${pcb}`);
  mkdirSync(outDir, { recursive: true });
  for (const name of [`${project}.kicad_pro`, `${project}.kicad_dru`, `${project}.kicad_sch`, 'sym-lib-table', 'fp-lib-table']) {
    if (existsSync(join(source, name))) copyFileSync(join(source, name), join(outDir, name));
  }
  const board = join(outDir, `${project}.kicad_pcb`);
  const report = join(outDir, 'drc.json');
  writeFileSync(board, text);
  rmSync(report, { force: true });
  const run = runSave(board, report);
  copyFileSync(join(source, `${project}.kicad_pro`), join(outDir, `${project}.kicad_pro`));
  if (!existsSync(report)) throw new Error(`kicad-cli wrote no report (exit ${run.status}): ${run.stderr}`);
  return { board, ...readReport(report) };
}

/**
 * `text` becomes the board at `pcb`, saved by one kicad-cli run in its own project folder: the DRC sees the real sheets and
 * rules, as the tools that saved in place through pcbnew did. A run that writes no report leaves the board as it was.
 */
export function saveBoardInPlace(pcb: string, text: string): SaveReport {
  const before = readFileSync(pcb);
  const project = projectName(pcb);
  const pro = project === null ? null : join(dirname(pcb), `${project}.kicad_pro`);
  const settings = pro === null ? null : readFileSync(pro);
  const work = mkdtempSync(join(tmpdir(), 'board-save-'));
  const report = join(work, 'drc.json');
  try {
    writeFileSync(pcb, text);
    const run = runSave(pcb, report);
    if (pro !== null && settings !== null) writeFileSync(pro, settings);
    if (!existsSync(report)) {
      writeFileSync(pcb, before);
      throw new Error(`kicad-cli wrote no report (exit ${run.status}): ${run.stderr}`);
    }
    return { board: pcb, ...readReport(report) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The board of `pcb` with `edit` applied, saved into `outDir`. */
export function editBoard(pcb: string, outDir: string, edit: (board: BoardEdit) => void): SaveReport {
  const board = new BoardEdit(readFileSync(pcb, 'utf8'));
  edit(board);
  return saveBoard(pcb, board.text(), outDir);
}

/** The board at `pcb` with `edit` applied, saved in place. */
export function editBoardInPlace(pcb: string, edit: (board: BoardEdit) => void): SaveReport {
  const board = new BoardEdit(readFileSync(pcb, 'utf8'));
  edit(board);
  return saveBoardInPlace(pcb, board.text());
}
