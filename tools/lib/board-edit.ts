// Edits to a board as text, for tools that used to save through pcbnew. Reads go through the KiCad API (board JSON); nothing
// is ever saved from nightly. An edit goes into a copy of the board as text, then one KiCad 10 kicad-cli DRC with parity
// refills every zone and saves, and KiCad puts new items in their place on that save. tools/router/core/src/write.rs does the
// same for route results inside a job, where there is no node; mmText, quoted and itemUuid must keep its results.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { kicadCli } from './env.mjs';
import { readJson } from './json-file.ts';

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

export interface Span { kind: string; start: number; end: number }

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

  remove(uuid: string): void {
    this.replace(uuid, '');
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
    for (const change of [...this.#changes].sort((a, b) => a.start - b.start)) {
      pieces.push(this.#board.slice(at, change.start), change.text);
      at = change.end;
    }
    return [...pieces, this.#board.slice(at, close), this.#added, this.#board.slice(close)].join('');
  }

  #form(uuid: string): Span {
    const form = this.#forms.get(uuid);
    if (!form) throw new Error(`board edit: no item with uuid ${uuid}`);
    return form;
  }
}

/** The project next to the board: the one of its name when there is one, else the last by name. */
function projectOf(pcb: string): string {
  const names = readdirSync(dirname(pcb)).filter(name => name.endsWith('.kicad_pro')).map(name => name.slice(0, -'.kicad_pro'.length)).sort();
  const own = basename(pcb).replace(/\.kicad_pcb$/, '');
  if (names.includes(own)) return own;
  const last = names.at(-1);
  if (last === undefined) throw new Error(`no .kicad_pro next to ${pcb}`);
  return last;
}

export interface SaveReport {
  board: string;
  violations: Record<string, number>;
  errors: number;
  unconnected: number;
  parity: number;
  passed: boolean;
}

interface DrcFile { violations?: { type?: string }[]; unconnected_items?: unknown[]; schematic_parity?: unknown[] }

function readReport(file: string): Omit<SaveReport, 'board'> {
  const drc = readJson<DrcFile>(file);
  const violations: Record<string, number> = {};
  for (const { type = '?' } of drc.violations ?? []) violations[type] = (violations[type] ?? 0) + 1;
  const errors = Object.values(violations).reduce((sum, count) => sum + count, 0);
  const unconnected = drc.unconnected_items?.length ?? 0;
  const parity = drc.schematic_parity?.length ?? 0;
  return { violations, errors, unconnected, parity, passed: errors === 0 && unconnected === 0 && parity === 0 };
}

/**
 * Writes `text` as the board of a project copy in `outDir`, then saves it with one kicad-cli run. The source project is only
 * read. A save can rewrite .kicad_pro with defaults, so the original goes back after it. A failed DRC is a report, not an
 * error: the caller decides what it means for its edit.
 */
export function saveBoard(pcb: string, text: string, outDir: string): SaveReport {
  const source = dirname(pcb);
  const project = projectOf(pcb);
  mkdirSync(outDir, { recursive: true });
  for (const name of [`${project}.kicad_pro`, `${project}.kicad_dru`, `${project}.kicad_sch`, 'sym-lib-table', 'fp-lib-table']) {
    if (existsSync(join(source, name))) copyFileSync(join(source, name), join(outDir, name));
  }
  const board = join(outDir, `${project}.kicad_pcb`);
  const report = join(outDir, 'drc.json');
  writeFileSync(board, text);
  rmSync(report, { force: true });
  const run = spawnSync(kicadCli, ['pcb', 'drc', '--schematic-parity', '--refill-zones', '--save-board', '--format', 'json',
    '--severity-error', '--output', report, board], { encoding: 'utf8' });
  copyFileSync(join(source, `${project}.kicad_pro`), join(outDir, `${project}.kicad_pro`));
  if (!existsSync(report)) throw new Error(`kicad-cli wrote no report (exit ${run.status}): ${run.stderr}`);
  return { board, ...readReport(report) };
}

/** The board of `pcb` with `edit` applied, saved into `outDir`. */
export function editBoard(pcb: string, outDir: string, edit: (board: BoardEdit) => void): SaveReport {
  const board = new BoardEdit(readFileSync(pcb, 'utf8'));
  edit(board);
  return saveBoard(pcb, board.text(), outDir);
}
