// The F.CrtYd items of a footprint, read and replaced as text: every other byte of the file stays (D-051).
import { formatG } from './py-numbers.ts';

/** x0, y0, x1, y1 in the footprint frame. */
export type Box = readonly [number, number, number, number];

const ITEM = /\((?:fp_line|fp_circle|fp_arc|fp_rect|fp_poly)\b(?:[^()]|\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))*\)/g;
const ON_COURTYARD = /\(layer\s+"?F\.CrtYd"?\)/;
const POINT = /\((?:start|end|mid|center|xy)\s+([-\d.]+)\s+([-\d.]+)\)/g;

const courtyardItems = (text: string) => [...text.matchAll(ITEM)].filter(item => ON_COURTYARD.test(item[0]));

/** The box of every point of the courtyard items, or null with no courtyard. */
export function courtyardBox(text: string): Box | null {
  const points = courtyardItems(text).flatMap(item => [...item[0].matchAll(POINT)]);
  if (!points.length) return null;
  const xs = points.map(point => Number(point[1]));
  const ys = points.map(point => Number(point[2]));
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Replaces every courtyard item with one rectangle, where the first one stood (else before the model, else at the end). */
export function setCourtyard(text: string, [x0, y0, x1, y1]: Box, uuid?: string): string {
  const tail = uuid ? ` (uuid "${uuid}")` : '';
  const rectangle = `(fp_rect (start ${formatG(x0)} ${formatG(y0)}) (end ${formatG(x1)} ${formatG(y1)}) `
    + `(stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd")${tail})`;
  const items = courtyardItems(text);
  const model = text.indexOf('(model');
  const anchor = items[0]?.index ?? (model >= 0 ? model : text.lastIndexOf(')'));
  const lineStart = text.lastIndexOf('\n', anchor - 1);
  const indent = text.slice(lineStart + 1, anchor);
  let kept = text;
  for (const item of items.reverse()) { // each whole line goes: its indent and its newline
    kept = kept.slice(0, text.lastIndexOf('\n', item.index - 1)) + kept.slice(item.index + item[0].length);
  }
  return `${kept.slice(0, lineStart)}\n${indent}${rectangle}${kept.slice(lineStart)}`;
}
