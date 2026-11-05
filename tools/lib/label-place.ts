// The place of each pin label and title of a connector: the search of tools/board_labels.ts.
import { boxOfPoints, offset, rectBox, type Box, type Xy } from './board-silk.ts';
import { toMm, type Pad } from './board-types.ts';
import { labelExtent, type Just, type LabelBoard } from './label-board.ts';
import { round } from './py-numbers.ts';
import type { HAlign } from './stroke-text.ts';

const PIN_MIN = 1.0; // target pin label height; a smaller size of pin_h is used per pin only where 1.0 mm does not fit
const PIN_DIST = 3.9; // tools/port_labels.ts limit 4.0, less a margin
export const TITLE_DIST = 7.9; // tools/port_labels.ts limit 8.0, less a margin
const PAD_CLEAR = 0.25; // first label position past the pad: the pad gap and one step
const GAP_STEP = 0.05;
const SHIFT_STEP = 0.1;
const PIN_WINDOW = 12;
const ROW_EXTRA = 0.1;
const ROW_GAP_Y = 0.08;
const FAILED_AT = 0.5;
const TITLE_STEP = 0.25;
const TITLE_PITCH = 1.4; // line pitch of a title, in text heights
const TITLE_WIDTHS = [1.0, 0.8];
const WIDE_SEARCH = 12;
const SCREW_DRILL_MM = 3.0;
const DIRS = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] } as const;

export type Dir = keyof typeof DIRS;
export interface PinOptions { dir?: Dir; max_gap?: number; max_shift?: number; far?: number; angle?: number }
export type PinRow = [string, string, string | string[], PinOptions?];
export interface Connector {
  ref: string | null; dir?: Dir; pins?: PinRow[]; title?: string[] | string[][]; title_near?: Xy; back_title_near?: Xy;
  pin_h?: number[]; title_h?: number[]; max_gap?: number; max_shift?: number; title_dx?: number; title_just?: string;
  rows?: number; pin_gap_x?: number;
}
export interface LabelSizes { pin_h?: number[]; title_h?: number[] }
export interface LabelItem extends Just { ref: string | null; pin: string | null; text: string; height: number; width: number; at: Xy }
export interface PortPad { ref: string; pin: string; x: number; y: number }
export interface PinResult { items: LabelItem[]; notes: string[]; failed: string | null }

/** A label with no free place: fail closed, or a line of the report on the back side. */
export class NoPlace extends Error {}

const CONNECTOR = /^(J|P|CN)\d/;
const padXy = (pad: Pad): Xy => [toMm(pad.position.x), toMm(pad.position.y)];
const isPin = (pad: Pad): boolean => pad.number !== '' && toMm(pad.drill.x) < SCREW_DRILL_MM;

/** All numbered pads of the connectors (J, P, CN). */
export function portPads(board: LabelBoard['board']): PortPad[] {
  return board.footprints.filter(footprint => CONNECTOR.test(footprint.reference)).flatMap(footprint =>
    footprint.pads.filter(isPin).map(pad => ({ ref: footprint.reference, pin: pad.number, x: toMm(pad.position.x), y: toMm(pad.position.y) })));
}

/** Is `own` the nearest connector pad to the anchor, within `limit`? Equal distances go to the lower reference, as a sort does. */
function nearestIs(pads: PortPad[], ref: string, pin: string, [x, y]: Xy, limit: number): boolean {
  let best: PortPad | null = null;
  let distance = Infinity;
  for (const pad of pads) {
    const d = Math.hypot(pad.x - x, pad.y - y);
    const before = d < distance || (d === distance && best !== null && (pad.ref < best.ref || (pad.ref === best.ref && pad.pin < best.pin)));
    if (before) [best, distance] = [pad, d];
  }
  return best !== null && best.ref === ref && best.pin === pin && distance <= limit;
}

const shiftsTo = (limit: number): number[] => {
  const steps = Math.floor(limit / SHIFT_STEP + 1e-6);
  return [0, ...Array.from({ length: steps }, (_, k) => round(SHIFT_STEP * (k + 1), 2)).flatMap(value => [value, -value])];
};

/** The justification that puts the glyph box on the side (ux, uy) of its anchor. Measured, so a mirrored text gets the right side too. */
function pick(text: string, height: number, [ux, uy]: readonly [number, number], vertical: boolean, back: boolean): Just {
  const h = (value: HAlign, v: Just['v'], angle = 0): Just => ({ h: value, v, angle });
  const options = vertical ? (uy ? [h('left', 'center', 90), h('right', 'center', 90)] : [h('center', 'center', 90)])
    : ux ? [h('left', 'center'), h('right', 'center')] : [h('center', 'top'), h('center', 'bottom')];
  const along = (option: Just): number => {
    const box = labelExtent(text, height, height, option, back);
    return (box[0] + box[2]) / 2 * ux + (box[1] + box[3]) / 2 * uy;
  };
  return options.reduce((best, option) => (along(option) > along(best) ? option : best));
}

interface Mode { mode: 'out' | 'opp' | 'in'; just: Just }

function pinModes(B: LabelBoard, ref: string, text: string, height: number, [dx, dy]: readonly [number, number], vertical: boolean): Mode[] {
  if (!B.back) {
    const just: Just = vertical ? { h: dy ? 'right' : 'center', v: 'center', angle: 90 }
      : dx ? { h: dx > 0 ? 'left' : 'right', v: 'center', angle: 0 } : { h: 'center', v: dy > 0 ? 'top' : 'bottom', angle: 0 };
    return [{ mode: 'out', just }];
  }
  const away: readonly [number, number] = [-dx, -dy];
  const modes: Mode[] = [{ mode: 'out', just: pick(text, height, [dx, dy], vertical, true) }, { mode: 'opp', just: pick(text, height, away, vertical, true) }];
  if (B.smd.has(ref)) modes.unshift({ mode: 'in', just: pick(text, height, away, vertical, true) }); // no pad on the bottom: first under the body
  return modes;
}

interface PinSearch { conn: Connector; ref: string; pads: Map<string, Pad>; ports: PortPad[]; shifts: number[]; maxGap: number }

function placeOne(B: LabelBoard, search: PinSearch, row: PinRow, height: number, keepVias: boolean): { item: LabelItem; box: Box } | { why: string } {
  const { conn, ref, pads, ports } = search;
  const [pin, text, , options = {}] = row;
  const [dx, dy] = DIRS[options.dir ?? conn.dir ?? 'N'];
  const pad = pads.get(pin)!;
  const [px, py] = padXy(pad);
  const box = rectBox(pad.bbox);
  const edge = dx ? (dx > 0 ? box[2] : box[0]) : (dy > 0 ? box[3] : box[1]);
  const farEdge = dx ? (dx > 0 ? box[0] : box[2]) : (dy > 0 ? box[1] : box[3]);
  const vertical = options.angle === 90;
  const modes = pinModes(B, ref, text, height, [dx, dy], vertical);
  const local = B.local([px - PIN_WINDOW, py - PIN_WINDOW, px + PIN_WINDOW, py + PIN_WINDOW], keepVias);
  const limit = options.far ?? PIN_DIST; // far: a pin with a gate exemption (port-labels.json): its label may stand further
  const shifts = options.max_shift === undefined ? search.shifts : shiftsTo(options.max_shift);
  const staggered = conn.pins!.indexOf(row) % (conn.rows ?? 1); // fine pitch: row k starts k lines out
  const steps = Math.floor((options.max_gap ?? search.maxGap) / GAP_STEP) + 1;
  let lastExtent: Box = [0, 0, 0, 0];
  for (const { mode, just } of modes) {
    const extent = labelExtent(text, height, height, just, B.back);
    lastExtent = extent;
    const first = (dx ? PAD_CLEAR : PAD_CLEAR + staggered * (extent[3] - extent[1] + ROW_GAP_Y + ROW_EXTRA)) - (mode === 'in' ? PAD_CLEAR : 0);
    for (let k = 0; k < steps; k++) {
      const gap = first + GAP_STEP * k;
      for (const shift of shifts) {
        const at: Xy = mode === 'in' ? (dx ? [px - dx * gap, py + shift] : [px + shift, py - dy * gap])
          : mode === 'opp' ? (dx ? [farEdge - dx * gap, py + shift] : [px + shift, farEdge - dy * gap])
            : dx ? [edge + dx * gap, py + shift] : [px + shift, edge + dy * gap];
        if (!nearestIs(ports, ref, pin, at, limit)) continue;
        const placed = offset(extent, at);
        if (mode === 'in') {
          const body = B.smd.get(ref)!;
          if (!(body[0] <= placed[0] && body[1] <= placed[1] && placed[2] <= body[2] && placed[3] <= body[3])) continue;
        }
        if (B.free(placed, local)) return { item: { ref, pin, text, height, width: height, at, ...just }, box: placed };
      }
    }
  }
  const failedAt: Xy = dx ? [edge + dx * FAILED_AT, py] : [px, edge + dy * FAILED_AT];
  const box2 = offset(lastExtent, failedAt);
  const why = [...B.blockers(box2), ...B.clash(box2, 'pin').map(label => `label ${label}`), ...(B.inside(box2) ? [] : ['board edge']), ...(B.overScrew(box2) ? ['screw head'] : [])];
  return { why: `${ref} pin ${pin} "${text}" at ${height} mm (${FAILED_AT} mm from the pad: ${[...new Set(why)].sort().join(', ')})` };
}

function checkNets(ref: string, rows: PinRow[], pads: Map<string, Pad>): void {
  const wrong = rows.flatMap(([pin, text, net]) => {
    const pad = pads.get(pin);
    const want = Array.isArray(net) ? net : [net];
    return pad && want.includes(pad.net) ? [] : [`${ref}.${pin} "${text}": pad net ${pad?.net ?? 'none'}, expected ${want.join(' ')}`];
  });
  if (wrong.length) throw new Error(`board_labels: label/net mismatch:\n  ${wrong.join('\n  ')}`);
}

/**
 * The pin labels of one connector: the largest size of pin_h at which every pin fits, first clear of the vias, then over them
 * (tented, all boards) before a size below PIN_MIN. When no size fits all, each pin gets the largest size at which it fits.
 */
export function placePins(B: LabelBoard, conn: Connector, ports: PortPad[], sizes: LabelSizes): PinResult {
  const ref = conn.ref!;
  const footprint = B.board.footprints.find(item => item.reference === ref);
  if (!footprint) throw new Error(`board_labels: no footprint ${ref}`);
  const rows = conn.pins!;
  const pads = new Map(footprint.pads.map(pad => [pad.number, pad]));
  checkNets(ref, rows, pads);
  const search: PinSearch = { conn, ref, pads, ports, shifts: shiftsTo(conn.max_shift ?? 0.8), maxGap: conn.max_gap ?? 3.0 };
  const heights = conn.pin_h ?? sizes.pin_h ?? [1.0, 0.9];
  B.resetPinGap(conn.pin_gap_x);
  for (const keepVias of [true, false]) {
    for (const height of heights.filter(value => value >= PIN_MIN)) {
      const mark = B.placed.length;
      const items: LabelItem[] = [];
      const all = rows.every(row => {
        const placed = placeOne(B, search, row, height, keepVias);
        if ('why' in placed) return false;
        B.place(placed.box, row[1], 'pin');
        items.push(placed.item);
        return true;
      });
      if (all) {
        const vertical = rows.filter(row => row[3]?.angle).map(row => `${ref} pin ${row[0]} "${row[1]}": vertical`);
        return { items, notes: [...(keepVias ? [] : [`${ref} pins: over tented vias`]), ...vertical], failed: null };
      }
      B.placed.length = mark;
    }
  }
  const items: LabelItem[] = [];
  const notes: string[] = [];
  const fails: string[] = [];
  for (const row of rows) {
    let why = `${ref} pin ${row[0]} "${row[1]}": no size at or below ${PIN_MIN} mm`;
    let done = false;
    for (const height of heights.filter(value => value <= PIN_MIN)) {
      const placed = placeOne(B, search, row, height, false);
      if ('why' in placed) {
        why = placed.why;
        continue;
      }
      B.place(placed.box, row[1], 'pin');
      items.push(placed.item);
      if (height < PIN_MIN) notes.push(`${ref} pin ${row[0]} "${row[1]}": ${height} mm`);
      done = true;
      break;
    }
    if (!done) fails.push(why);
  }
  if (fails.length && B.back) return { items, notes: [...notes, ...fails.map(fail => `SKIPPED ${fail}`)], failed: null }; // back: the others stay
  return { items, notes, failed: fails.length ? fails.join('\n  ') : null };
}

function spiral(span: number): [number, number][] {
  const reach = Math.trunc(span * 4);
  const steps: [number, number][] = [];
  for (let i = -reach; i <= reach; i++) for (let j = -reach; j <= reach; j++) steps.push([i, j]);
  return steps.sort((a, b) => a[0] ** 2 + a[1] ** 2 - (b[0] ** 2 + b[1] ** 2));
}

const JUST_OF: Record<string, HAlign> = { C: 'center', L: 'left', R: 'right' };

/**
 * The title block of one connector: the largest size of title_h (glyph width 1.0, then 0.8 of the height) that has a free
 * place; at one size, the place nearest to title_near. The lines are centred, or left / right justified with the anchor toward
 * the connector (the gate measures the anchor).
 */
export function placeTitle(B: LabelBoard, conn: Connector, sizes: LabelSizes): LabelItem[] {
  const title = conn.title ?? [];
  if (!title.length) return [];
  const wordings = (Array.isArray(title[0]) ? title : [title]) as string[][]; // preferred first; the size goes before the wording
  const { ref } = conn;
  let bounds: Box;
  let reach: (x: number, y: number) => boolean = () => true;
  if (ref) {
    const footprint = B.board.footprints.find(item => item.reference === ref);
    if (!footprint) throw new Error(`board_labels: no footprint ${ref}`);
    bounds = boxOfPoints(footprint.pads.filter(isPin).map(padXy));
    const [x0, y0, x1, y1] = bounds;
    reach = (x, y) => Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1)) <= TITLE_DIST;
  } else {
    const [x, y] = conn.title_near!; // a board text (free_texts): no connector
    bounds = [x, y, x, y];
  }
  const [dx, dy] = DIRS[conn.dir ?? 'N'];
  const smd = B.back && ref ? B.smd.get(ref) : undefined;
  const [nx, ny]: Xy = smd ? [(smd[0] + smd[2]) / 2, (smd[1] + smd[3]) / 2] // back: under the connector body first
    : (B.back && conn.back_title_near) || conn.title_near || [(bounds[0] + bounds[2]) / 2 + dx * 6, (bounds[1] + bounds[3]) / 2 + dy * 6];
  const span = conn.title_dx ?? WIDE_SEARCH;
  const steps = spiral(span);
  const window: Box = [nx - span - 30, ny - span - 15, nx + span + 30, ny + span + 15];
  const locals = new Map([[true, B.local(window)], [false, B.local(window, false)]]);
  const justs = [...(conn.title_just ?? 'CLR')].map(letter => JUST_OF[letter]!);
  for (const height of conn.title_h ?? sizes.title_h ?? [1.5, 1.27, 1.0]) {
    for (const keepVias of [true, false]) {
      for (const lines of wordings) {
        for (const factor of TITLE_WIDTHS) {
          const width = round(height * factor, 3);
          const pitch = round(height * TITLE_PITCH, 3);
          const extents = justs.map(h => ({ h, boxes: lines.map(line => labelExtent(line, height, width, { h, v: 'center', angle: 0 }, B.back)) }));
          for (const [i, j] of steps) {
            const [cx, cy] = [nx + i * TITLE_STEP, ny + j * TITLE_STEP];
            const ys = lines.map((_, k) => cy + (k - (lines.length - 1) / 2) * pitch);
            if (!ys.every(y => reach(cx, y))) continue;
            for (const { h, boxes } of extents) {
              const placed = boxes.map((box, k) => offset(box, [cx, ys[k]!]));
              if (!placed.every(box => B.free(box, locals.get(keepVias)!, 'title'))) continue;
              placed.forEach((box, k) => B.place(box, lines[k]!, 'title'));
              return lines.map((text, k) => ({ ref, pin: null, text, height, width, at: [cx, ys[k]!], h, v: 'center', angle: 0 }));
            }
          }
        }
      }
    }
  }
  if (B.back && span < WIDE_SEARCH) return placeTitle(B, { ...conn, title_dx: WIDE_SEARCH }, sizes); // the brand block can fill a small search box
  throw new NoPlace(`board_labels: ${ref} title ${JSON.stringify(wordings)}: no free place within ${TITLE_DIST} mm of the pads`);
}
