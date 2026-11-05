// Defects put into a throwaway copy of a real board, as plain edits of its native text, and what must survive a repair.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { footprints } from './native-board.ts';
import { field, forms, listEnd, type SExpr, type SList } from './sexpr.ts';

export interface Segment { uuid: string; start: [number, number]; end: [number, number]; width: number; layer: string; net: string; span: [number, number]; locked: boolean }
export interface MovedPart { text: string; pose: [number, number, number] }
export interface Gap { text: string; removed: Segment }

const value = (form: SList, name: string): string => String(field(form, name)?.[0] ?? '');
const point = (form: SList, name: string): [number, number] => { const row = field(form, name)!; return [Number(row[0]), Number(row[1])]; };
const atStart = (text: string, at: number): boolean => text[at] === '(';

/** The native text span of each top-level form of the board. */
function topLevel(text: string): [number, number][] {
  const spans: [number, number][] = [];
  let at = text.indexOf('(', text.indexOf('(') + 1);
  while (at >= 0 && atStart(text, at)) {
    const end = listEnd(text, at);
    spans.push([at, end]);
    at = text.indexOf('(', end);
  }
  return spans;
}

export function segments(text: string): Segment[] {
  return topLevel(text).filter(([start]) => text.startsWith('(segment', start)).map(span => {
    const form = forms(text.slice(...span))[0] as SList;
    return { uuid: value(form, 'uuid'), start: point(form, 'start'), end: point(form, 'end'), width: Number(value(form, 'width')), layer: value(form, 'layer'), net: value(form, 'net'), span,
      locked: form.includes('locked') || value(form, 'locked') === 'yes' };
  });
}

/** Moves a footprint by `dx` millimetres. The pose it had is what a repair must restore. */
export function moveFootprint(text: string, reference: string, dx: number): MovedPart {
  const named = text.indexOf(`"Reference" "${reference}"`);
  if (named < 0) throw new Error(`board has no footprint ${reference}`);
  const start = text.lastIndexOf('(footprint', named);
  const header = /\(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)/.exec(text.slice(start, named));
  if (!header) throw new Error(`footprint ${reference} has no pose`);
  const [x, y, angle] = [Number(header[1]), Number(header[2]), Number(header[3] ?? 0)];
  const at = start + header.index;
  return { text: `${text.slice(0, at)}(at ${x + dx} ${y}${header[3] ? ` ${header[3]}` : ''})${text.slice(at + header[0].length)}`, pose: [x, y, angle] };
}

const samePoint = (a: [number, number], b: [number, number]): boolean => a[0] === b[0] && a[1] === b[1];

/** Interior 0/45/90 degree segments with exactly one same-net, same-layer, same-width neighbour at each end. */
function interior(all: Segment[]): Segment[] {
  return all.filter(row => {
    const dx = Math.abs(row.end[0] - row.start[0]), dy = Math.abs(row.end[1] - row.start[1]);
    if (row.locked || samePoint(row.start, row.end) || (dx && dy && dx !== dy)) return false;
    const neighbours = [row.start, row.end].map(end => all.filter(other => other !== row && other.net === row.net && other.layer === row.layer && other.width === row.width
      && (samePoint(other.start, end) || samePoint(other.end, end))));
    return neighbours.every(rows => rows.length === 1) && neighbours[0]![0] !== neighbours[1]![0];
  });
}

const pourNets = (text: string): Set<string> => new Set([...text.matchAll(/\(zone\s+\(net "([^"]+)"\)/g)].map(match => match[1]!));

/** Whether the two ends of `row` lose each other without it: on a loop the gap would open nothing. Vias join layers at a point. */
function isBridge(row: Segment, all: Segment[]): boolean {
  const key = (end: [number, number]): string => end.join(' ');
  const rest = all.filter(other => other !== row && other.net === row.net), seen = new Set([key(row.start)]), queue = [key(row.start)];
  while (queue.length) {
    const at = queue.pop()!;
    for (const other of rest) {
      const ends = [key(other.start), key(other.end)];
      if (!ends.includes(at)) continue;
      for (const end of ends) if (!seen.has(end)) { seen.add(end); queue.push(end); }
    }
  }
  return !seen.has(key(row.end));
}

/** Removes one interior segment that bridges its net, on a net without a pour, which would keep it connected. `allowed` is the
 * router's own guard: a bridge the repair could not lay back is no specimen. */
export function removeSegment(text: string, allowed: (segment: Segment) => boolean): Gap {
  const length = (row: Segment): number => Math.hypot(row.end[0] - row.start[0], row.end[1] - row.start[1]), poured = pourNets(text);
  const all = segments(text);
  // Round track ends of neighbours closer than one width still touch: such a gap opens nothing.
  const removed = interior(all).filter(row => !poured.has(row.net) && isBridge(row, all) && length(row) > row.width).sort((a, b) => a.net.localeCompare(b.net) || length(a) - length(b) || a.uuid.localeCompare(b.uuid)).find(allowed);
  if (!removed) throw new Error('board has no interior segment gap specimen');
  return { text: text.slice(0, removed.span[0]) + text.slice(removed.span[1]), removed };
}

const segmentText = (a: [number, number], b: [number, number], width: number, layer: string, net: string): string =>
  `\t(segment\n\t\t(start ${a[0]} ${a[1]})\n\t\t(end ${b[0]} ${b[1]})\n\t\t(width ${width})\n\t\t(layer "${layer}")\n\t\t(net "${net}")\n\t\t(uuid "${randomUUID()}")\n\t)\n`;
const insert = (text: string, segment: string): string => { const end = text.lastIndexOf(')'); return `${text.slice(0, end)}${segment}${text.slice(end)}`; };

function otherNets(text: string): [Segment, Segment] {
  const all = segments(text), first = all[0];
  const second = first && all.find(row => row.net !== first.net && row.layer === first.layer);
  if (!first || !second) throw new Error('board needs copper of two nets on one layer');
  return [first, second];
}

/** Copper of one net joined to copper of another. */
export function withShort(text: string): string {
  const [a, b] = otherNets(text);
  return insert(text, segmentText(a.end, b.end, a.width, a.layer, a.net));
}

/** A short track of another net beside the middle of the longest straight track, `gap` millimetres from its edge. The specimen must
 * touch nothing: KiCad gives floating copper the net of whatever it touches, and a refill moves a pour around it, so pour nets are out. */
export function withClearance(text: string, gap: number, width: number): string {
  const poured = pourNets(text), length = (row: Segment): number => Math.hypot(row.end[0] - row.start[0], row.end[1] - row.start[1]);
  const rows = segments(text).filter(row => !poured.has(row.net));
  const straight = rows.filter(row => row.start[0] === row.end[0] || row.start[1] === row.end[1]).sort((x, y) => length(y) - length(x))[0];
  const other = straight && rows.find(row => row.net !== straight.net);
  if (!straight || !other) throw new Error('board needs a straight track and a second net');
  const offset = (straight.width + width) / 2 + gap, vertical = straight.start[0] === straight.end[0];
  const along = (share: number): [number, number] => {
    const x = straight.start[0] + (straight.end[0] - straight.start[0]) * share, y = straight.start[1] + (straight.end[1] - straight.start[1]) * share;
    return vertical ? [x + offset, y] : [x, y + offset];
  };
  return insert(text, segmentText(along(1 / 3), along(2 / 3), width, straight.layer, other.net));
}

/** One pad of a footprint on another net than the schematic says. */
export function withWrongPadNet(text: string, reference: string): string {
  const named = text.indexOf(`"Reference" "${reference}"`), start = text.lastIndexOf('(footprint', named), end = listEnd(text, start);
  const pads = [...text.slice(start, end).matchAll(/\(pad [\s\S]*?\(net "([^"]+)"\)/g)];
  const first = pads[0];
  const other = [...text.matchAll(/\(net "([^"]+)"\)/g)].map(match => match[1]!).find(name => name !== first?.[1]);
  if (!first || !other) throw new Error(`footprint ${reference} has no pad to reassign`);
  const at = start + first.index + first[0].lastIndexOf(`(net "${first[1]}")`);
  return `${text.slice(0, at)}(net "${other}")${text.slice(at + `(net "${first[1]}")`.length)}`;
}

const normalized = (form: SExpr): SExpr => {
  if (Array.isArray(form)) return form.map(normalized);
  const number = Number(form);
  return form !== '' && Number.isFinite(number) ? String(number) : form;
};

/** Every footprint pose and every track, arc and via: what a repair of one defect must leave as it found. */
export function layoutOf(path: string): { poses: Record<string, string>; copper: string[] } {
  const poses = Object.fromEntries(footprints(path).map(part => [part.props.get('Reference') as string, part.pose.slice(0, 2).map(Number).concat((Number(part.pose[2]) + 360) % 360).join(' ')]));
  const copper = (forms(readFileSync(path, 'utf8'))[0] as SList).slice(1).filter((form): form is SList => Array.isArray(form) && ['segment', 'arc', 'via'].includes(form[0] as string));
  return { poses, copper: copper.map(form => JSON.stringify(normalized(form))).sort() };
}
