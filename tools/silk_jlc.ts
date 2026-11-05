// silk_jlc: silkscreen texts and strokes up to the JLC legend minimums.
//
//   tools/silk_jlc.ts check BOARD.kicad_pcb   list visible silk texts / strokes under the minimums
//   tools/silk_jlc.ts apply BOARD.kicad_pcb   raise them (board texts, footprint fields and texts, strokes)
//
// Source (registry/evidence/2026-11-03/jlcpcb-pcb-capabilities.html, "Legend Features"): minimum line width >= 0.15 mm; minimum
// text height 40 mil (1.0 mm); character width to height ratio 1:6 preferred. apply: a text under 1.0 mm is scaled to 1.0 mm high
// (width in proportion), its stroke = max(0.15, height / 6); a stroke (line, arc, circle, rectangle, unfilled polygon) under
// 0.15 mm becomes 0.15 mm. Filled polygons keep their outline (a fill has no stroke width). Positions are not changed.
// One summary line: PASS|FAIL|DONE <counts>.
//
// Texts, their sizes and footprint silk ids are not in the board document, so this reads the file itself. pads and clip stay in
// tools/silk_jlc.py: they need polygon booleans (shapely, SHAPE_POLY_SET.BooleanSubtract) and pad polygons grown by a margin
// (PAD.TransformShapeToPolygon on a mask layer), which the document does not hold.
import { readFileSync } from 'node:fs';
import { BoardEdit, mmText, saveBoardInPlace } from './lib/board-edit.ts';
import { runMain, UsageError } from './lib/cli.ts';
import { childForms } from './lib/footprint-move.ts';
import { floatRepr } from './lib/py-compat.mjs';
import { round } from './lib/py-numbers.ts';
import { kids, parse, type SExpr, type SList } from './lib/sexpr.ts';

const MIN_H = 1;
const MIN_W = 0.15;
const USAGE = 'usage: tools/silk_jlc.ts {check|apply} BOARD.kicad_pcb; pads and clip: tools/silk_jlc.py';
const SILK = new Set(['F.SilkS', 'B.SilkS']);
const BOARD_SHAPES: Record<string, string> = { gr_line: 'Line', gr_arc: 'Arc', gr_circle: 'Circle', gr_rect: 'Rect', gr_poly: 'Polygon', gr_curve: 'Bezier' };
const FOOTPRINT_SHAPES: Record<string, string> = { fp_line: 'Line', fp_arc: 'Arc', fp_circle: 'Circle', fp_rect: 'Rect', fp_poly: 'Polygon', fp_curve: 'Bezier' };

export interface SilkItem { owner: string; uuid: string; text: string; form: SList; kind: 'text' | 'shape'; shape?: string }

const word = (value: SExpr | undefined): string => (typeof value === 'string' ? value : '');
const child = (form: SList, name: string): SList | undefined => kids(form, name)[0];
const layerOf = (form: SList): string => word(child(form, 'layer')?.[1]);
const uuidOf = (form: SList): string => word(child(form, 'uuid')?.[1]);
/** A text's value: (gr_text "T" ...), (fp_text user "T" ...), (property "Reference" "T" ...). */
const textValue = (form: SList): string => word(form[form[0] === 'gr_text' ? 1 : 2]);
const hidden = (form: SList): boolean => child(form, 'hide')?.[1] === 'yes' || child(child(form, 'effects') ?? [], 'hide')?.[1] === 'yes';

function footprintItems(footprint: string): SilkItem[] {
  const owner = childForms(footprint).map(span => parse(footprint.slice(span.start, span.end)))
    .find(form => form[0] === 'property' && form[1] === 'Reference')?.[2];
  const fields: SilkItem[] = [];
  const graphics: SilkItem[] = [];
  for (const span of childForms(footprint)) {
    const text = footprint.slice(span.start, span.end);
    const shape = FOOTPRINT_SHAPES[span.kind];
    if (span.kind !== 'property' && span.kind !== 'fp_text' && !shape) continue;
    const form = parse(text);
    if (!SILK.has(layerOf(form))) continue;
    const item = { owner: word(owner), uuid: uuidOf(form), text, form };
    if (shape) graphics.push({ ...item, kind: 'shape', shape });
    else if (!hidden(form)) (span.kind === 'property' ? fields : graphics).push({ ...item, kind: 'text' });
  }
  return [...fields, ...graphics];
}

/** Every visible silk text and stroke shape: board drawings first, then each footprint's fields and graphics. */
export function silkItems(board: string): SilkItem[] {
  const spans = childForms(board);
  const drawings = spans.flatMap((span): SilkItem[] => {
    const shape = BOARD_SHAPES[span.kind];
    if (span.kind !== 'gr_text' && !shape) return [];
    const text = board.slice(span.start, span.end);
    const form = parse(text);
    if (!SILK.has(layerOf(form))) return [];
    const item = { owner: 'board', uuid: uuidOf(form), text, form };
    return [shape ? { ...item, kind: 'shape', shape } : { ...item, kind: 'text' }];
  });
  return [...drawings, ...spans.filter(span => span.kind === 'footprint').flatMap(span => footprintItems(board.slice(span.start, span.end)))];
}

interface TextSize { height: number; width: number; thickness: number }

function textSize(form: SList): TextSize {
  const font = child(child(form, 'effects') ?? [], 'font') ?? [];
  const size = child(font, 'size') ?? [];
  return { height: Number(size[1]), width: Number(size[2]), thickness: Number(child(font, 'thickness')?.[1] ?? 0) };
}

const strokeWidth = (form: SList): number => Number(child(child(form, 'stroke') ?? [], 'width')?.[1] ?? child(form, 'width')?.[1] ?? 0);
const filledPolygon = (item: SilkItem): boolean => item.shape === 'Polygon' && child(item.form, 'fill')?.[1] === 'yes';

export function underMinimum(item: SilkItem): boolean {
  if (item.kind === 'text') {
    const { height, thickness } = textSize(item.form);
    return height < MIN_H - 1e-6 || thickness < MIN_W - 1e-6;
  }
  return !filledPolygon(item) && strokeWidth(item.form) < MIN_W - 1e-6;
}

/** The raised sizes of a text. */
export function raisedText({ height, width, thickness }: TextSize): TextSize {
  const scale = Math.max(1, MIN_H / height);
  const newHeight = round(height * scale, 4);
  return { height: newHeight, width: round(width * scale, 4), thickness: round(Math.max(MIN_W, thickness, newHeight / 6), 4) };
}

function raisedForm(item: SilkItem, raised: TextSize): string {
  const size = `(size ${mmText(raised.height)} ${mmText(raised.width)})`;
  const thickness = `(thickness ${mmText(raised.thickness)})`;
  const sized = item.text.replace(/\(size [^)]*\)/, size);
  return /\(thickness [^)]*\)/.test(sized) ? sized.replace(/\(thickness [^)]*\)/, thickness) : sized.replace(size, `${size} ${thickness}`);
}

const widenedForm = (item: SilkItem): string => item.text.replace(/\(width [^)]*\)/, `(width ${mmText(MIN_W)})`);

/** Layer names as the board calls them: F.Silkscreen for F.SilkS. */
function layerNames(board: string): Map<string, string> {
  const span = childForms(board).find(form => form.kind === 'layers');
  const rows = span ? parse(board.slice(span.start, span.end)).slice(1) as SList[] : [];
  return new Map(rows.map(row => [word(row[1]), word(row[3] ?? row[1])]));
}

function run(pcb: string, write: boolean): number {
  const board = readFileSync(pcb, 'utf8');
  const names = layerNames(board);
  const edit = new BoardEdit(board);
  const counts = { text: 0, shape: 0 };
  for (const item of silkItems(board).filter(underMinimum)) {
    counts[item.kind] += 1;
    const layer = names.get(layerOf(item.form));
    if (item.kind === 'text') {
      const size = textSize(item.form);
      const raised = raisedText(size);
      console.log(`  text ${item.owner} ${layer} "${textValue(item.form)}" ${floatRepr(size.height)}/${floatRepr(size.thickness)} -> ${floatRepr(raised.height)}/${floatRepr(raised.thickness)}`);
      if (write) edit.replace(item.uuid, raisedForm(item, raised));
    } else {
      console.log(`  shape ${item.owner} ${layer} ${item.shape} ${floatRepr(strokeWidth(item.form))} -> ${MIN_W}`);
      if (write) edit.replace(item.uuid, widenedForm(item));
    }
  }
  const under = `${counts.text} texts, ${counts.shape} strokes`;
  const minimums = `${floatRepr(MIN_H)} mm / ${MIN_W} mm`;
  if (write) {
    saveBoardInPlace(pcb, edit.text());
    console.log(`DONE apply: ${under} raised to ${minimums}`);
    return 0;
  }
  const ok = counts.text === 0 && counts.shape === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'} check: ${under} under ${minimums}`);
  return ok ? 0 : 1;
}

function main(argv: string[]): number {
  const [command, pcb] = argv;
  if (argv.length !== 2 || (command !== 'check' && command !== 'apply')) throw new UsageError(USAGE, 1);
  return run(pcb!, command === 'apply');
}

runMain(import.meta.url, main);
