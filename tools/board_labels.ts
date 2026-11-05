// Connector pin labels and group titles on F.SilkS (and B.SilkS, "back": true), then the silk marks, references and brand block of
// a board (user request 2026-10-07 "logos and clear labels, bigger if possible"; model: the AIO labels, D-102).
//
//   tools/board_labels.ts <BOARD> [--dry-run] [--pcb PATH] [--labels-only] [--keep-going]
//
// SILKSCREEN ONLY: the tool writes silk texts, reference fields and B.SilkS brand shapes. It never moves a footprint, pad, track,
// via or zone. All the steps edit the board text; one KiCad save ends the run.
//
// Reads hardware-design/boards/<BOARD>/board-labels.json:
//   {"remove": [["24V", 145.6, 107.05], ...], "remove_groups": ["j6-labels"],
//                                 legacy loose F.SilkS texts (text, x, y; matched within 0.3 mm) and label groups this tool replaces.
//                                 A rerun finds none: that is not an error.
//    "pin_h": [1.0, 0.9], "title_h": [1.5, 1.27, 1.0],          sizes to try, largest first (defaults)
//    "connectors": [{"ref": "J1", "dir": "E",                         labels go from the pins toward this side (N/S/E/W)
//                    "pins": [["1", "24V", "/VIN_RAW"], ...],          pad, label, expected net (string or list), and an
//                                        optional dict: {"dir", "max_gap", "max_shift", "far": mm (a pin exempted in port-labels.json),
//                                         "angle": 90 (vertical, last resort)}
//                    "title": ["24V DC IN", "18-32V"],                 title lines (horizontal); or a list of wordings
//                                                                      [["24V DC IN", "18-32V"], ["24V IN", "18-32V DC"]]
//                    "title_near": [x, y], "pin_h": [...], "title_h": [...], "max_gap": 3.0, "title_dx": 12,
//                    "rows": 3 (staggered label rows for a fine pitch), "pin_gap_x": 0.5}],
//    "free_texts": [{"text": ["FIELD 24V BUS"], "near": [x, y], "h": [2.0, 1.5]}],   board texts (not a port)
//    "brand": {"name": "PWR-24V-5V", "rev": "A", "logo_mm": [26, 22, 18, 16], "text_mm": [2.0, 1.5, 1.2], "near": [x, y]},
//    "info_back": [...], "info_layout": {...}}                         reference blocks on B.SilkS: tools/lib/label-info.ts
//
// Steps (each rerun gives the same result):
// 1. All reference fields go to Fab (tools/silk_refs.ts); the old "board-labels" and "silk-marks" groups and the legacy texts in
//    "remove" are deleted.
// 2. Pin labels, one per listed pad: on the board side of the terminal (dir), aligned to the pin (the label anchor is nearer to its
//    own pad than to any other connector pad, within 3.9 mm: tools/port_labels.ts), clear of every pad (0.2 mm; NPTH 0.3 mm), via
//    (0.15 mm), footprint silk and other board silk (0.1 mm), part body (courtyard less 0.2 mm; first clear of the vias, then over
//    the tented vias before a smaller size), M3 screw head (r 3.0 mm round a hole >= 3 mm), other labels (0.2 mm) and 0.5 mm inside
//    the board outline. All the pins of one connector get one size: the largest of pin_h where every pin fits. Stroke: 0.15 mm per
//    mm of text height, 0.15 mm minimum.
// 3. Titles: after all pin labels, each title block (its lines kept together) goes to the free place nearest to title_near (default:
//    past the pin labels, along dir), with every line within 7.9 mm of the connector pads (gate: 8 mm). The largest size of title_h
//    that fits (glyph width 1.0, then 0.8 of the height). A pin or title with no free place stops the tool (fail closed); nothing is
//    written, unless --keep-going, which writes what fits to a scratch copy for review.
// 4. tools/silk_marks.ts <BOARD> (silk-marks.json) and tools/brand_mark.ts (the largest logo_mm / text_mm block that fits on B.SilkS
//    near "near").
// 5. "back": true (user request 2026-10-07: the bottom side may be easier to read while wiring): the same pin labels and titles on
//    B.SilkS, mirrored, aligned to the same pins (group "board-labels-back"). It runs last and only adds B.SilkS texts. Obstacles:
//    through-hole pads and holes, pads on B.Cu / B.Mask, vias (always: no tented-via fallback), all B.SilkS, M3 screw heads, other
//    back labels and 0.5 mm inside the outline. A pin label that does not fit on the dir side goes to the other side of its pin. An
//    SMD connector (no pad on the bottom) gets its labels and title under its body first. A pin or title with no free place is
//    skipped and listed (not an error).
// 6. "info_back": reference blocks on B.SilkS, in group "board-info-back".
// --labels-only: steps 1-3 (and 5, 6).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boardJson } from './lib/board-json.ts';
import { BoardEdit, itemIds, saveBoardInPlace } from './lib/board-edit.ts';
import { textText } from './lib/board-items.ts';
import { readSilk, type Box, type Xy } from './lib/board-silk.ts';
import type { Board } from './lib/board-types.ts';
import { parseFlags, runMain, UsageError } from './lib/cli.ts';
import { readJson } from './lib/json-file.ts';
import { GROUP, GROUP_BACK, GROUP_INFO, LabelBoard, strokeOf } from './lib/label-board.ts';
import { drawGrid, drawPanel, drawTextBlock, edgesBox, holdBackTexts, infoColumns, type InfoBlock, type InfoCanvas, type InfoLayout } from './lib/label-info.ts';
import { NoPlace, placePins, placeTitle, portPads, type Connector, type LabelItem, type LabelSizes } from './lib/label-place.ts';
import { fixed } from './lib/py-compat.mjs';
import { brandBlock, logoFile, placeLine } from './brand_mark.ts';
import { boardFiles, GROUP as MARKS_GROUP, silkMarks, type MarksSpec } from './silk_marks.ts';
import { refsOffSilk } from './silk_refs.ts';

const USAGE = 'usage: tools/board_labels.ts BOARD [--dry-run] [--pcb PATH] [--labels-only] [--keep-going]';
const LEGACY_MATCH_MM = 0.3;
const TENTED_BACK = /\(tenting\s+\(front\s+\w+\)\s+\(back\s+yes\)/;

export interface FreeText { text: string[] | string[][]; near: Xy; h?: number[]; dx?: number }
export interface Brand { name: string; rev: string; logo_mm?: number[]; text_mm?: number[]; near?: Xy }
export interface LabelConfig extends LabelSizes {
  connectors: Connector[]; remove?: [string, number, number][]; remove_groups?: string[]; free_texts?: FreeText[]; brand?: Brand;
  back?: boolean; info_back?: InfoBlock[]; info_layout?: InfoLayout;
}

const shown = (value: number): string => String(value);
const itemLine = (prefix: string, { ref, pin, text, height, width, at }: LabelItem): string =>
  `  ${prefix}${ref ?? 'board'}.${pin ?? 'title'} "${text}" ${shown(height)}x${shown(width)} mm at (${fixed(at[0], 2)}, ${fixed(at[1], 2)})`;

function addLabels(edit: BoardEdit, next: () => string, items: LabelItem[], layer: string, group: string): void {
  const back = layer === 'B.SilkS';
  const members = items.map(({ text, height, width, at, h, v, angle }) => {
    const uuid = next();
    edit.add(textText({ text, at, layer, size: height, width, thickness: strokeOf(height), h, v, angle, mirrored: back, uuid }));
    return uuid;
  });
  edit.addGroup(group, members, next());
}

function removeGroups(edit: BoardEdit, names: string[]): void {
  for (const group of edit.groups().filter(item => names.includes(item.name))) edit.removeGroup(group);
}

/** Step 1: the board text with the old labels gone. */
function clearLabels(text: string, config: LabelConfig): { text: string; legacy: number } {
  const edit = new BoardEdit(text);
  removeGroups(edit, [GROUP, MARKS_GROUP, GROUP_BACK, ...(config.remove_groups ?? [])]);
  const legacy = readSilk(text).texts.filter(item => item.layer === 'F.SilkS' && item.group === undefined
    && (config.remove ?? []).some(([label, x, y]) => item.text === label && Math.hypot(item.at[0] - x, item.at[1] - y) <= LEGACY_MATCH_MM));
  for (const item of legacy) edit.remove(item.uuid);
  return { text: edit.text(), legacy: legacy.length };
}

const titleOf = (text: FreeText): Connector => ({ ref: null, title: text.text, title_near: text.near, title_h: text.h ?? [1.5, 1.27, 1.0], title_dx: text.dx ?? 6, title_just: 'C' });

const tryTitle = (B: LabelBoard, connector: Connector, config: LabelConfig, failed: string[]): LabelItem[] => {
  try {
    return placeTitle(B, connector, config);
  } catch (error) {
    if (!(error instanceof NoPlace)) throw error;
    failed.push(error.message);
    return [];
  }
};

/** Steps 2 and 3: the front labels, or the failures that stop the tool. */
function frontLabels(board: Board, text: string, config: LabelConfig, keepGoing: boolean, lines: string[]): LabelItem[] {
  const B = new LabelBoard(board, readSilk(text));
  const ports = portPads(board);
  const items: LabelItem[] = [];
  const failed: string[] = [];
  const notes: string[] = [];
  for (const connector of config.connectors.filter(item => item.pins?.length)) {
    const result = placePins(B, connector, ports, config);
    B.resetPinGap();
    if (result.failed) failed.push(result.failed);
    else { items.push(...result.items); notes.push(...result.notes); }
  }
  if (failed.length && !keepGoing) throw new Error(`board_labels: pin labels with no free place:\n  ${failed.join('\n  ')}`);
  for (const connector of config.connectors) items.push(...tryTitle(B, connector, config, failed));
  for (const free of config.free_texts ?? []) items.push(...tryTitle(B, titleOf(free), config, failed));
  if (failed.length && !keepGoing) throw new Error(`board_labels: titles with no free place:\n  ${failed.join('\n  ')}`);
  if (failed.length) lines.push(`  NOT PLACED (--keep-going):\n  ${failed.join('\n  ')}`);
  lines.push(...items.map(item => itemLine('', item)), ...notes.map(note => `  SMALLER: ${note}`));
  return items;
}

/** Step 5: the same labels on the back. */
function backLabels(board: Board, text: string, config: LabelConfig, name: string, lines: string[]): string {
  const edit = new BoardEdit(text);
  removeGroups(edit, [GROUP_BACK]);
  const B = new LabelBoard(board, readSilk(text), true);
  const ports = portPads(board);
  const items: LabelItem[] = [];
  const skipped: string[] = [];
  const notes: string[] = [];
  for (const connector of config.connectors.filter(item => item.pins?.length)) {
    const result = placePins(B, connector, ports, config);
    B.resetPinGap();
    if (result.failed) skipped.push(result.failed);
    else { items.push(...result.items); notes.push(...result.notes); }
  }
  for (const connector of config.connectors) items.push(...tryTitle(B, connector, config, skipped));
  skipped.push(...notes.filter(note => note.startsWith('SKIPPED ')).map(note => note.slice('SKIPPED '.length)));
  addLabels(edit, itemIds(text, GROUP_BACK), items, 'B.SilkS', GROUP_BACK);
  lines.push(...items.map(item => itemLine('back ', item)), ...notes.filter(note => !note.startsWith('SKIPPED ')).map(note => `  back SMALLER: ${note}`),
    ...skipped.map(note => `  back SKIPPED: ${note}`), `board_labels ${name}: ${items.length} back texts in group "${GROUP_BACK}", ${skipped.length} skipped`);
  return edit.text();
}

/** A "split" block becomes one text block per column, so it fits between the vias; a panel stays whole. */
function infoBlocks(board: Board, blocks: InfoBlock[], date: string): InfoBlock[] {
  return blocks.flatMap(block => {
    if (block.kind === 'panel' || !block.split) return [block];
    const columns = infoColumns(board, block, date);
    if (columns.length < 2) return [block];
    return columns.map((lines, index) => ({ ...block, kind: 'text' as const, lines, id: `${block.id ?? 'info'}.${index + 1}` }));
  });
}

function fixedPanel(canvas: InfoCanvas, block: InfoBlock, rect: Box): boolean {
  const window: Box = [rect[0] - 0.5, rect[1] - 0.5, rect[2] + 0.5, rect[3] + 0.5];
  const local = canvas.tented ? canvas.B.localOverVias(window) : canvas.B.local(window);
  if (!canvas.B.free(rect, local, 'title') || !drawPanel(canvas, block, rect)) {
    canvas.skipped.push(`${block.id}: fixed rect ${rect.join(' ')} not free`);
    return false;
  }
  return true;
}

/** Step 6: the reference blocks. */
function infoPass(board: Board, text: string, config: LabelConfig, name: string, lines: string[]): string {
  const edit = new BoardEdit(text);
  removeGroups(edit, [GROUP_INFO]);
  const silk = readSilk(text);
  const B = new LabelBoard(board, silk, true);
  holdBackTexts(B, silk.texts.filter(item => item.group !== GROUP_INFO));
  const next = itemIds(text, GROUP_INFO);
  const members: string[] = [];
  const date = process.env.RENDER_DATE || new Date().toISOString().slice(0, 10); // RENDER_DATE: the fab-set date of tools/fab-workflow.sh
  const canvas: InfoCanvas = {
    board, B, tented: TENTED_BACK.test(text), outline: edgesBox(board), date, lines, skipped: [],
    add: make => { const uuid = next(); edit.add(`${make(uuid)}`); members.push(uuid); },
  };
  let blocks = infoBlocks(board, config.info_back ?? [], date);
  let placed = 0;
  if (config.info_layout) {
    placed += drawGrid(canvas, blocks, config.info_layout);
    const laid = new Set(config.info_layout.rows.flat());
    blocks = blocks.filter(block => !laid.has(block.id ?? ''));
  }
  for (const block of blocks) {
    if (block.kind === 'panel' && block.rect) placed += fixedPanel(canvas, block, block.rect) ? 1 : 0;
    else if (block.kind === 'panel') {
      if (drawPanel(canvas, block)) placed += 1;
      else canvas.skipped.push(`${block.id}: no free place`);
    } else if (drawTextBlock(canvas, block)) placed += 1;
  }
  edit.addGroup(GROUP_INFO, members, next());
  lines.push(`board_labels ${name}: ${placed} info blocks in group "${GROUP_INFO}"`, ...canvas.skipped.map(item => `  NOT PLACED info ${item}`));
  return edit.text();
}

/** Step 4: silk marks, then the largest brand block that fits. */
function marksAndBrand(board: Board, text: string, folder: string, config: LabelConfig, name: string, lines: string[]): string {
  const marks = silkMarks(board, text, readJson<MarksSpec>(join(folder, 'silk-marks.json')), name);
  lines.push(...marks.lines, `silk_marks ${name}: ${marks.items} items in group "${MARKS_GROUP}"`);
  const { brand } = config;
  if (!brand) return marks.text;
  const logo = logoFile();
  for (const logoMm of brand.logo_mm ?? [16]) {
    for (const textMm of brand.text_mm ?? [1.2]) {
      const options = { name: brand.name, rev: brand.rev, logoMm, textMm, ...(brand.near ? { near: brand.near } : {}) };
      const placed = brandBlock(board, marks.text, options, logo);
      if (placed) {
        lines.push(placeLine(options, placed.place));
        return placed.text;
      }
    }
  }
  throw new Error(`board_labels ${name}: no place for the brand block`);
}

export interface LabelRun { name: string; folder: string; dryRun?: boolean; labelsOnly?: boolean; keepGoing?: boolean }

/** Every step on the board text. Dry run: the labels of steps 1 to 3, and the text comes back unchanged. */
export function labelBoard(board: Board, source: string, config: LabelConfig, run: LabelRun): { text: string; lines: string[] } {
  const { name, folder, dryRun = false, labelsOnly = false, keepGoing = false } = run;
  const lines: string[] = [];
  const { text: moved, moved: references } = refsOffSilk(source);
  const { text: cleared, legacy } = clearLabels(moved, config);
  lines.push(`board_labels ${name}: ${references} references to Fab, ${legacy} legacy texts removed`);
  const items = frontLabels(board, cleared, config, keepGoing, lines);
  if (dryRun) {
    lines.push(`board_labels ${name}: dry run, ${items.length} texts`);
    return { text: source, lines };
  }
  const edit = new BoardEdit(cleared);
  addLabels(edit, itemIds(cleared, GROUP), items, 'F.SilkS', GROUP);
  lines.push(`board_labels ${name}: ${items.length} texts in group "${GROUP}"`);
  let text = edit.text();
  if (!labelsOnly) text = marksAndBrand(board, text, folder, config, name, lines);
  if (config.back) text = backLabels(board, text, config, name, lines);
  if (config.info_back) text = infoPass(board, text, config, name, lines);
  return { text, lines };
}

function main(argv: string[]): number {
  const { values, positionals } = parseFlags(argv, {
    'dry-run': { type: 'boolean' }, pcb: { type: 'string' }, 'labels-only': { type: 'boolean' }, 'keep-going': { type: 'boolean' },
  }, USAGE);
  const [name] = positionals;
  if (positionals.length !== 1 || name === undefined) throw new UsageError(USAGE);
  const { folder, pcb: projectBoard } = boardFiles(name);
  const pcb = values.pcb ?? projectBoard;
  if (!existsSync(pcb)) throw new Error(`no board ${pcb}`);
  const config = readJson<LabelConfig>(join(folder, 'board-labels.json'));
  const run = { name, folder, dryRun: Boolean(values['dry-run']), labelsOnly: Boolean(values['labels-only']), keepGoing: Boolean(values['keep-going']) };
  const { text, lines } = labelBoard(boardJson(pcb).board, readFileSync(pcb, 'utf8'), config, run);
  for (const line of lines) console.log(line);
  if (!run.dryRun) saveBoardInPlace(pcb, text);
  return 0;
}

runMain(import.meta.url, main);
