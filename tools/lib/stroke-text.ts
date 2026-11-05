// Where KiCad's stroke font puts the ink of a text, in millimetres, relative to the text's anchor, y down. The sums follow
// common/font/font.cpp (getLinePositions) and stroke_font.cpp; the glyphs come from newstroke-metrics.json. Markup such as
// ~{overbar} is drawn as plain characters here. A character past the table is a square of the text's size.
import metrics from './newstroke-metrics.json' with { type: 'json' };

export type HAlign = 'left' | 'center' | 'right';
export type VAlign = 'top' | 'center' | 'bottom';
/** left, top, right, bottom. */
export type Box = readonly [number, number, number, number];

export interface TextStyle {
  height: number; width: number; thickness: number;
  h?: HAlign; v?: VAlign; mirrored?: boolean;
  /** Degrees, counter-clockwise as seen on screen. */
  angle?: number;
}

interface Glyph { advance: number; ink: Box | null }

const UNITS = 21; // STROKE_FONT_SCALE
const ORIGIN = 'R'.charCodeAt(0);
const BASELINE_OFFSET = -8; // FONT_OFFSET
const FIRST_LINE_FUDGE = 1.17; // getLinePositions: "to match 6.0 positioning"
const STROKE_X_FUDGE = 1 / 1.52;
const STROKE_Y_FUDGE = 0.052;
const INTERLINE = 1.68 * 0.9583; // METRICS::m_InterlinePitch and STROKE_FONT::GetInterline's legacy factor
const INTER_CHAR = 0.2; // GetTextAsGlyphs: the gap after the last glyph comes off a text's width
const BOUNDARY_PEN_RATIO = 1.5; // StringBoundaryLimits: "a bit more than thickness/2 to catch diacriticals, descenders"
const BOX_FUDGE = 0.17; // EDA_TEXT::GetTextBox

const table = metrics.glyphs.join('');
const known = new Map<number, Glyph>();

function glyph(code: number): Glyph {
  const found = known.get(code);
  if (found) return found;
  const at = (code - metrics.first) * metrics.size;
  const made = at < 0 || at >= table.length ? { advance: 1, ink: [0, -1, 1, 0] as Box } : decode(table.slice(at, at + metrics.size));
  known.set(code, made);
  return made;
}

function decode(cell: string): Glyph {
  const value = (index: number): number => cell.charCodeAt(index) - ORIGIN;
  const advance = (value(1) - value(0)) / UNITS;
  if (cell[2] === ' ') return { advance, ink: null };
  const x = (index: number): number => (value(index) - value(0)) / UNITS;
  const y = (index: number): number => (value(index) + BASELINE_OFFSET) / UNITS;
  return { advance, ink: [x(2), y(4), x(3), y(5)] };
}

const codes = (line: string): number[] => [...line].map(character => character.codePointAt(0)!);

/** The length of a line from its first cursor to its last. */
export const lineAdvance = (line: string, width: number): number =>
  codes(line).reduce((sum, code) => sum + glyph(code).advance * width, 0);

function union(a: Box | null, b: Box): Box {
  return a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b;
}

/** The ink of one line with its first cursor at `x` and its baseline at `y`. */
function lineInk(line: string, x: number, y: number, width: number, height: number): Box | null {
  let cursor = x;
  let box: Box | null = null;
  for (const code of codes(line)) {
    const { advance, ink } = glyph(code);
    if (ink) box = union(box, [cursor + ink[0] * width, y + ink[1] * height, cursor + ink[2] * width, y + ink[3] * height]);
    cursor += advance * width;
  }
  return box;
}

/** A box turned about the origin, as KiCad's RotatePoint turns points: the box of its turned corners. */
export function turned([x0, y0, x1, y1]: Box, degrees: number): Box {
  if (!degrees) return [x0, y0, x1, y1];
  const radians = degrees * Math.PI / 180;
  const cos = Math.round(Math.cos(radians) * 1e12) / 1e12;
  const sin = Math.round(Math.sin(radians) * 1e12) / 1e12;
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => [x! * cos + y! * sin, -x! * sin + y! * cos] as const);
  const xs = corners.map(corner => corner[0]);
  const ys = corners.map(corner => corner[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * EDA_TEXT::GetTextBox turned as PCB_TEXT::GetBoundingBox turns it, relative to the anchor: the box KiCad gives a text, which holds
 * the ink with a margin. Tools keep clear of this box; inkBox is where the ink itself goes.
 */
export function textBox(text: string, style: TextStyle): Box {
  const { height, width, thickness, h = 'center', v = 'center', mirrored = false, angle = 0 } = style;
  const lines = text.split('\n');
  const inflated = 2 * thickness * BOUNDARY_PEN_RATIO;
  const lineHeight = height + inflated;
  const fudge = lineHeight * BOX_FUDGE;
  const boxWidth = Math.max(...lines.map(line => lineAdvance(line, width) - width * INTER_CHAR + inflated));
  const boxHeight = lineHeight + fudge + (lines.length - 1) * height * INTERLINE;
  const left = h === 'center' ? -boxWidth / 2 : (h === 'right') !== mirrored ? -boxWidth : 0;
  const top = v === 'center' ? -boxHeight / 2 : v === 'top' ? -fudge : fudge - boxHeight;
  return turned([left, top, left + boxWidth, top + boxHeight], angle);
}

/** The box of the ink with its pen width, relative to the anchor. A text with no ink is an empty box at the anchor. */
export function inkBox(text: string, style: TextStyle): Box {
  const { height, width, thickness, h = 'center', v = 'center', mirrored = false, angle = 0 } = style;
  const lines = text.split('\n');
  const interline = height * INTERLINE;
  const block = height * FIRST_LINE_FUDGE + (lines.length - 1) * interline;
  const left = thickness * STROKE_X_FUDGE;
  const top = height - thickness * STROKE_Y_FUDGE - (v === 'center' ? block / 2 : v === 'bottom' ? block : 0);
  let box: Box | null = null;
  lines.forEach((line, index) => {
    const advance = lineAdvance(line, width);
    const x = h === 'left' ? left : h === 'center' ? -advance / 2 : -(advance + left);
    const ink = lineInk(line, x, top + index * interline, width, height);
    if (ink) box = union(box, ink);
  });
  if (!box) return [0, 0, 0, 0];
  const [x0, y0, x1, y1] = box as Box;
  const pen = thickness / 2;
  const inked: Box = [x0 - pen, y0 - pen, x1 + pen, y1 + pen];
  return turned(mirrored ? [-inked[2], inked[1], -inked[0], inked[3]] : inked, angle);
}
