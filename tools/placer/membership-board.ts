// The board side of block membership, on board JSON and the .kicad_pcb text.
//   drawnBoard: a copy with each block border (User.1, 4 lines, label above the top-left corner) and each component border (User.2)
//     around the member courtyards; with `fixed`, the passives of each block with no fixed part move in first (tightenBlock).
//   fixedRefs: the parts `iotplace read` keeps fixed (read/parts.rs part_fixed): their blocks stay soft, cohesion only.
//   referenceBlocks: the blocks of the User.1 borders of a board (read/grouping.rs block_borders), for validation.
import { BoardEdit, itemIds, quoted } from '../lib/board-edit.ts';
import { padHit, trackHit, viaHit } from '../lib/board-hit.ts';
import { toMm, type Board, type Footprint, type Graphic, type Pad, type Pt, type RoutedCopper } from '../lib/board-types.ts';
import { Float } from '../lib/py-compat.mjs';
import { hypot } from '../lib/py-math.ts';
import { round } from '../lib/py-numbers.ts';
import { listEnd } from '../lib/sexpr.ts';
import { compareRefs, CONNECTOR, prefix, tightenBlock, type Box, type Members } from './membership-derive.ts';

const PAD_MARGIN = 0.25;     // a part rect is its pads + this when it has no courtyard (read/parts.rs)
const EDGE_DIST = 1.5;       // iotplace read --edge-dist default
const OUTLINE_MARGIN = 0.3;  // a tightened part stays this far inside the outline box
const BLOCK_MARGIN = 0.3;    // border = member courtyards + this (tools/build-net-core-pcb.py)
const COMP_MARGIN = 0.5;
const LABEL_DIST = 3;        // a User.1 text this close to a block border is its label (read/grouping.rs)
const LINE_TOLERANCE = 1e-3; // read/grouping.rs
const BORDERS = ['User.1', 'User.2'];

const boundsOf = (points: Pt[]): Box => [toMm(Math.min(...points.map(p => p.x))), toMm(Math.min(...points.map(p => p.y))), toMm(Math.max(...points.map(p => p.x))), toMm(Math.max(...points.map(p => p.y)))];
const nearestNm = (mm: number): number => round(mm * 1e6);

/** The F.CrtYd points' box; without a courtyard the pads + a margin, else the position + the margin. */
function fpRect(fp: Footprint): Box {
  const courtyard = fp.courtyard_front.flatMap(c => c.outline);
  if (courtyard.length) return boundsOf(courtyard);
  const [x0, y0, x1, y1] = boundsOf(fp.pads.length ? fp.pads.flatMap(({ bbox: b }) => [{ x: b.left, y: b.top }, { x: b.right, y: b.bottom }]) : [fp.position]);
  return [x0 - PAD_MARGIN, y0 - PAD_MARGIN, x1 + PAD_MARGIN, y1 + PAD_MARGIN];
}

/** The rect of a part grown to cover its copper pads (an NPTH hole has no copper). */
export function partBox(fp: Footprint): Box {
  const pads = fp.pads.filter(p => p.kind !== 'NpThroughHole').map(({ bbox: b }) => boundsOf([{ x: b.left, y: b.top }, { x: b.right, y: b.bottom }]));
  return border([fpRect(fp), ...pads], 0);
}

function border(rects: Box[], margin: number): Box {
  return [Math.min(...rects.map(r => r[0])) - margin, Math.min(...rects.map(r => r[1])) - margin, Math.max(...rects.map(r => r[2])) + margin, Math.max(...rects.map(r => r[3])) + margin];
}

/** Even-odd test of a point in a ring, on the numbers the search uses. */
function inRing(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  ring.forEach(([ax, ay], k) => {
    const [bx, by] = ring[(k + 1) % ring.length]!;
    if (ay !== by && (ay > y) !== (by > y) && x < ax + (y - ay) * (bx - ax) / (by - ay)) inside = !inside;
  });
  return inside;
}

function outlineOf(board: Board): [number, number][] {
  const first = board.outlines[0];
  if (!first) throw new Error('no closed board outline on Edge.Cuts');
  return first.outline.map(p => [toMm(p.x), toMm(p.y)]);
}

const copperItem = (c: RoutedCopper) => ('Track' in c ? c.Track : c.Via);
const copperEnds = (c: RoutedCopper): Pt[] => ('Track' in c ? [c.Track.start, c.Track.end] : [c.Via.at]);
const copperHit = (c: RoutedCopper, p: Pt): boolean => ('Track' in c ? trackHit(c.Track, p) : viaHit(c.Via, p));
const onPad = (c: RoutedCopper, pad: Pad): boolean => copperItem(c).net === pad.net && (copperHit(c, pad.position) || copperEnds(c).some(e => padHit(pad, e)));

/** A connector whose rect crosses the outline, within `gap`; one wholly outside is staged for placement and stays movable. */
function atEdge(r: Box, outline: [number, number][], gap: number): boolean {
  const corners = [[r[0] - gap, r[1] - gap], [r[2] + gap, r[1] - gap], [r[2] + gap, r[3] + gap], [r[0] - gap, r[3] + gap]] as const;
  const inside = corners.filter(([x, y]) => inRing(x, y, outline)).length;
  return inside > 0 && inside < 4;
}

export function fixedRefs(board: Board): string[] {
  const outline = outlineOf(board);
  const locked = board.copper.filter(c => copperItem(c).locked);
  const held = (fp: Footprint): boolean => fp.locked || /^H\d+$/.test(fp.reference) || fp.lib_id.toLowerCase().includes('mountinghole') || fp.layer !== 'F.Cu'
    || (CONNECTOR.includes(prefix(fp.reference)) && atEdge(partBox(fp), outline, EDGE_DIST))
    || fp.pads.some(pad => pad.net && locked.some(c => onPad(c, pad)));
  return board.footprints.filter(held).map(fp => fp.reference).sort();
}

/** Whole nanometres as KiCad's millimetre text. */
function nmText(nm: number): string {
  const whole = Math.trunc(Math.abs(nm) / 1e6);
  const fraction = String(Math.abs(nm) % 1e6).padStart(6, '0').replace(/0+$/, '');
  return `${nm < 0 ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

const xyText = (x: number, y: number): string => `${nmText(nearestNm(x))} ${nmText(nearestNm(y))}`;

/** The board-coordinate places of a footprint's text, moved: its `at`, and the points of its zones. A file stores all else relative. */
export function movedFootprint(source: string, fp: Footprint, by: Pt): string {
  const shifted = (x: string, y: string): string => `${nmText(nearestNm(Number(x)) + by.x)} ${nmText(nearestNm(Number(y)) + by.y)}`;
  const at = /\(at (\S+) ([^\s)]+)/.exec(source);
  if (!at || nearestNm(Number(at[1])) !== fp.position.x || nearestNm(Number(at[2])) !== fp.position.y) throw new Error(`${fp.reference}: the board text and board JSON disagree on its place`);
  const start = at.index + 4;
  let out = source.slice(0, start) + shifted(at[1]!, at[2]!) + source.slice(start + at[1]!.length + 1 + at[2]!.length);
  for (let zone = out.indexOf('(zone'); zone >= 0; zone = out.indexOf('(zone', zone + 1)) {
    const end = listEnd(out, zone);
    out = out.slice(0, zone) + out.slice(zone, end).replace(/\(xy (\S+) ([^\s)]+)\)/g, (_, x: string, y: string) => `(xy ${shifted(x, y)})`) + out.slice(end);
  }
  return out;
}

function movedCopy(fp: Footprint, { x, y }: Pt): Footprint {
  const point = (p: Pt): Pt => ({ x: p.x + x, y: p.y + y });
  return {
    ...fp, position: point(fp.position),
    courtyard_front: fp.courtyard_front.map(c => ({ ...c, outline: c.outline.map(point) })),
    pads: fp.pads.map(p => ({ ...p, bbox: { left: p.bbox.left + x, top: p.bbox.top + y, right: p.bbox.right + x, bottom: p.bbox.bottom + y } })),
  };
}

/** Moves the passives of each block with no fixed part toward its IC, in `edit` and in `parts`. Returns the moves in mm. */
function tighten(edit: BoardEdit, parts: Map<string, Footprint>, board: Board, members: Members, held: string[]): Map<string, [Float, Float]> {
  const outline = outlineOf(board);
  const [xs, ys] = [outline.map(p => p[0]), outline.map(p => p[1])];
  const inner: Box = [Math.min(...xs) + OUTLINE_MARGIN, Math.min(...ys) + OUTLINE_MARGIN, Math.max(...xs) - OUTLINE_MARGIN, Math.max(...ys) - OUTLINE_MARGIN];
  const inside = (q: Box): boolean => q[0] >= inner[0] && q[1] >= inner[1] && q[2] <= inner[2] && q[3] <= inner[3];
  const moved = new Map<string, [Float, Float]>();
  for (const refs of members.blocks.values()) {
    if (refs.some(r => held.includes(r))) continue;
    const size = (r: string): number => parts.get(r)!.pads.length;
    const anchor = refs.reduce((a, b) => (size(b) > size(a) || (size(b) === size(a) && b > a) ? b : a));
    const others = new Map(refs.filter(r => r !== anchor).map(r => [r, partBox(parts.get(r)!)]));
    for (const [r, [dx, dy]] of tightenBlock(partBox(parts.get(anchor)!), others, inside)) {
      if (Math.abs(dx) <= 1e-6 && Math.abs(dy) <= 1e-6) continue;
      const by = { x: nearestNm(dx), y: nearestNm(dy) }, fp = parts.get(r)!;
      edit.replace(fp.id, movedFootprint(edit.textOf(fp.id), fp, by));
      parts.set(r, movedCopy(fp, by));
      moved.set(r, [new Float(round(dx, 4)), new Float(round(dy, 4))]);
    }
  }
  return moved;
}

function lineText(a: [number, number], b: [number, number], layer: string, width: number, id: string): string {
  return `\t(gr_line\n\t\t(start ${xyText(...a)})\n\t\t(end ${xyText(...b)})\n\t\t(stroke\n\t\t\t(width ${nmText(Math.trunc(width * 1e6))})\n\t\t\t(type default)\n\t\t)\n\t\t(layer ${quoted(layer)})\n\t\t(uuid ${quoted(id)})\n\t)\n`;
}

function labelText(label: string, x: number, y: number, height: number, layer: string, id: string): string {
  const size = nmText(Math.trunc(height * 1e6)), thickness = nmText(Math.trunc(Math.max(0.12, height * 0.15) * 1e6));
  return `\t(gr_text ${quoted(label)}\n\t\t(at ${xyText(x, y)} 0)\n\t\t(layer ${quoted(layer)})\n\t\t(uuid ${quoted(id)})\n\t\t(effects\n\t\t\t(font\n\t\t\t\t(size ${size} ${size})\n\t\t\t\t(thickness ${thickness})\n\t\t\t)\n\t\t\t(justify left)\n\t\t)\n\t)\n`;
}

function rectText(r: Box, layer: string, width: number, next: () => string): string {
  const corners: [number, number][] = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];
  return corners.map((corner, k) => lineText(corner, corners[(k + 1) % 4]!, layer, width, next())).join('');
}

/** The board text with the borders; `held` (the fixed parts) asks for the tighten first. Old User.1 and User.2 drawings go. */
export function drawnBoard(source: string, board: Board, members: Members, held: string[] | null): { text: string; tightened: Map<string, [Float, Float]> } {
  const edit = new BoardEdit(source);
  const next = itemIds(source, 'placer-membership');
  const parts = new Map(board.footprints.map(fp => [fp.reference, fp]));
  const tightened = held ? tighten(edit, parts, board, members, held) : new Map<string, [Float, Float]>();
  for (const item of [...board.graphics, ...board.texts]) if (BORDERS.includes(item.layer)) edit.remove(item.id);
  const boxes = new Map<string, Box>();
  for (const [name, refs] of members.blocks) {
    const r = border(refs.map(ref => partBox(parts.get(ref)!)), BLOCK_MARGIN);
    boxes.set(name, r);
    edit.add(rectText(r, 'User.1', 0.08, next) + labelText(name, r[0] + 0.2, r[1] + 0.5, 0.6, 'User.1', next()));
  }
  for (const [name, list] of members.components) {
    const r = border(list.map(x => boxes.get(x) ?? partBox(parts.get(x)!)), COMP_MARGIN);
    edit.add(rectText(r, 'User.2', 0.12, next) + labelText(name, r[0] + 0.2, r[3] - 0.5, 0.7, 'User.2', next()));
  }
  return { text: edit.text(), tightened };
}

type Line = [number, number, number, number];

/** Axis-aligned rectangles closed by 4 lines: a border drawn as 4 User.1 lines is a block border like a rectangle shape. */
function lineRectangles(lines: Line[]): Box[] {
  const key = (v: number): number => round(v / LINE_TOLERANCE);
  const flat = (a: number, b: number): boolean => Math.abs(a - b) <= LINE_TOLERANCE;
  const across = new Map<string, { k: [number, number, number]; x0: number; x1: number; y: number }>();
  const down = new Set<string>();
  for (const [x0, y0, x1, y1] of lines) {
    const [left, right, top, bottom] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)];
    if (flat(y0, y1) && !flat(x0, x1)) {
      const k: [number, number, number] = [key(left), key(right), key(y0)];
      across.set(k.join(), { k, x0: left, x1: right, y: y0 });
    } else if (flat(x0, x1) && !flat(y0, y1)) down.add([key(x0), key(top), key(bottom)].join());
  }
  const rows = [...across.values()].sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2]);
  const out: Box[] = [];
  rows.forEach((a, n) => {
    for (const b of rows.slice(n + 1)) {
      if (b.k[0] !== a.k[0] || b.k[1] !== a.k[1] || b.k[2] === a.k[2]) continue;
      const [lo, hi] = [Math.min(a.k[2], b.k[2]), Math.max(a.k[2], b.k[2])];
      if (down.has([a.k[0], lo, hi].join()) && down.has([a.k[1], lo, hi].join())) out.push([a.x0, Math.min(a.y, b.y), a.x1, Math.max(a.y, b.y)]);
    }
  });
  return out;
}

function shapeBox(g: Graphic): Box | null {
  const { geometry: shape } = g;
  if (typeof shape !== 'object') return null;
  if ('Rect' in shape) return boundsOf([shape.Rect.top_left, shape.Rect.bottom_right]);
  if ('Poly' in shape && shape.Poly.rings[0]?.length) return boundsOf(shape.Poly.rings[0]);
  return null;
}

/** The blocks of a board: the refs with their position in each User.1 border, named by its label. */
export function referenceBlocks(board: Board): Map<string, string[]> {
  const drawn = board.graphics.filter(g => g.layer === 'User.1');
  const lines = drawn.flatMap(g => (typeof g.geometry === 'object' && 'Segment' in g.geometry ? [[...mmPoint(g.geometry.Segment.start), ...mmPoint(g.geometry.Segment.end)] as Line] : []));
  const shapes = drawn.map(shapeBox).filter(b => b !== null);
  const borders: { box: Box; label: string | null }[] = [...shapes, ...lineRectangles(lines)].map(box => ({ box, label: null }));
  for (const t of board.texts.filter(t => t.layer === 'User.1')) {
    const [x, y] = mmPoint(t.position);
    const nearest = borders.map(({ box: b }, k) => ({ k, gap: Math.max(b[0] - x, x - b[2], b[1] - y, y - b[3], 0), corner: hypot(x - b[0], y - b[1]) }))
      .reduce<{ k: number; gap: number; corner: number } | null>((a, b) => (!a || b.gap < a.gap || (b.gap === a.gap && b.corner < a.corner) ? b : a), null);
    if (nearest && nearest.gap <= LABEL_DIST) borders[nearest.k]!.label ??= t.text;
  }
  const inside = (p: Pt, b: Box): boolean => b[0] <= toMm(p.x) && toMm(p.x) <= b[2] && b[1] <= toMm(p.y) && toMm(p.y) <= b[3];
  return new Map(borders.map(({ box, label }, k) => [label || `BLOCK${k + 1}`, board.footprints.filter(fp => inside(fp.position, box)).map(fp => fp.reference).sort(compareRefs)]));
}

const mmPoint = (p: Pt): [number, number] => [toMm(p.x), toMm(p.y)];
