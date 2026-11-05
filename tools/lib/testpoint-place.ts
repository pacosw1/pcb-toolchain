// Where a bring-up test point and its silk label go: the rules of tools/add_testpoints.ts on a board document. Points are whole
// nanometres, as board-hit.ts tests them; boxes are millimetres, as board-silk.ts gives them.
import { fromMm, padCollidesCircle, pointSegmentSq, polygonNear, polygonNearSegment, polygonsContain, polygonsOverlap, ringContains, trackLine } from './board-hit.ts';
import { boxCentre, courtyardOf, footprintBox, grow, hit, insideBoard, offset, rectBox, touch, type Box, type FootprintText, type Silk, type Xy } from './board-silk.ts';
import { toMm, tracks, vias, type Board, type Graphic, type Polygon, type Pt, type Track, type Zone } from './board-types.ts';
import { textBox } from './stroke-text.ts';

export type Kind = 'smd' | 'tht';
export interface PointSpec {
  ref: string; net: string; kind: Kind; near: string | [number, number];
  power?: string | null; max_mm?: number; label?: string | string[] | null; track_only?: boolean;
}
/** The footprint of a test point, centred on its pad. Millimetres. */
export interface PadShape { radius: number; halfWidth: number; halfHeight: number }
export interface Spot { at: Pt; distance: number; onTrack: boolean }
export interface Label { text: string; at: Xy }

export const LABEL_SIZE = 0.8;
export const LABEL_PEN = 0.15;
const LABEL_MARGIN = 0.15;
const LABEL_EDGE_GAP = 0.35; // silk_edge_clearance
const LABEL_NEARER = 0.5; // a GND label next to a 5 V pad is a trap
const LABEL_REACH = [1.0, 1.6, 2.4];
const LABEL_SIDE_REACH = 1.2;
const LABEL_WAYS: Xy[] = [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]];
const STEP = fromMm(0.25);
const DEFAULT_MAX_MM = 8;
const EDGE_GAP = 1.0;
const PART_GAP = 0.5;
const CONNECTOR_GAP = 1.0; // D-040: U and J parts
const RING_GAP = 1.0;
const RING_POINTS = 16;
const SILK_GAP = 0.3;
const MIN_CLEARANCE = 0.2;
const CLEARANCE_MARGIN = 0.1;
const PAD_GAP = 0.2; // a pad on a track stays this far from any pad of a part
const CHORD_ERROR = 1000;

const mmOf = ({ x, y }: Pt): Xy => [toMm(x), toMm(y)];
const whole = (x: number, y: number): Pt => ({ x: Math.trunc(x), y: Math.trunc(y) });
const circleBox = ([x, y]: Xy, radius: number): Box => [x - radius, y - radius, x + radius, y + radius];

/** Chords from `start` round `center`, the angle growing, for `sweep` radians. */
function arcChain(center: Pt, start: Pt, sweep: number): Pt[] {
  const radius = Math.hypot(start.x - center.x, start.y - center.y);
  const first = Math.atan2(start.y - center.y, start.x - center.x);
  const steps = Math.max(8, Math.ceil(sweep / (2 * Math.acos(Math.max(0, 1 - CHORD_ERROR / radius)))));
  return Array.from({ length: steps + 1 }, (_, i) => {
    const angle = first + sweep * i / steps;
    return whole(center.x + radius * Math.cos(angle), center.y + radius * Math.sin(angle));
  });
}

function sweepOf(center: Pt, start: Pt, end: Pt): number {
  const turn = Math.atan2(end.y - center.y, end.x - center.x) - Math.atan2(start.y - center.y, start.x - center.x);
  return turn > 0 ? turn : turn + 2 * Math.PI;
}

/** The centre lines of a shape, each a chain of points. */
function strokes({ geometry }: Graphic): Pt[][] {
  if (geometry === 'Other') return [];
  if ('Segment' in geometry) return [[geometry.Segment.start, geometry.Segment.end]];
  if ('Rect' in geometry) {
    const { top_left: a, bottom_right: b } = geometry.Rect;
    return [[a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }, a]];
  }
  if ('Circle' in geometry) return [arcChain(geometry.Circle.center, geometry.Circle.radius_point, 2 * Math.PI)];
  if ('Arc' in geometry) return [arcChain(geometry.Arc.center, geometry.Arc.start, sweepOf(geometry.Arc.center, geometry.Arc.start, geometry.Arc.end))];
  return geometry.Poly.rings.map(ring => [...ring, ring[0]!]);
}

const links = (chain: Pt[]): [Pt, Pt][] => chain.slice(1).map((point, i) => [chain[i]!, point]);
const areas = (shape: Graphic): Pt[][] => (shape.filled ? strokes(shape) : []);

/** PCB_SHAPE::GetEffectiveShape()->Collide of a point with a clearance: the stroke, and the inside of a filled shape. */
export function shapeNear(shape: Graphic, p: Pt, clearance: number): boolean {
  const reach = (clearance + shape.width / 2) ** 2;
  return strokes(shape).some(chain => links(chain).some(([a, b]) => pointSegmentSq(p, a, b) < reach)) || areas(shape).some(ring => ringContains(ring, p));
}

function boxPolygon([x0, y0, x1, y1]: Box): Polygon {
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as const;
  return { outline: corners.map(([x, y]) => whole(fromMm(x), fromMm(y))), holes: [] };
}

/** Collide of a box: exact, so a label may sit inside the box of an arc or a frame without touching its line. */
export function shapeTouchesBox(shape: Graphic, box: Box): boolean {
  const rect = boxPolygon(box);
  return strokes(shape).some(chain => links(chain).some(([a, b]) => polygonNearSegment(rect, a, b, shape.width / 2)))
    || areas(shape).some(ring => polygonsOverlap({ outline: ring, holes: [] }, rect));
}

/** A piece of copper, as a test point sees it. `layers` null: every copper layer. */
interface Copper { kind: 'track' | 'via' | 'pad'; net: string; layers: string[] | null; box: Box; near(layer: string, p: Pt, reach: number): boolean }

function trackCopper(track: Track): Copper {
  const line = links(trackLine(track));
  return {
    kind: 'track', net: track.net, layers: [track.layer], box: grow(rectOf(line.flat()), toMm(track.width) / 2),
    near: (_, p, reach) => line.some(([a, b]) => pointSegmentSq(p, a, b) < (reach + track.width / 2) ** 2),
  };
}

function rectOf(points: Pt[]): Box {
  const [xs, ys] = [points.map(point => toMm(point.x)), points.map(point => toMm(point.y))];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Copper round a point: a through via is on every layer, as copperObstacles counts it. */
const roundCopper = (kind: 'via' | 'pad', net: string, layers: string[] | null, at: Pt, radius: number): Copper => ({
  kind, net, layers, box: circleBox(mmOf(at), toMm(radius)),
  near: (_, p, reach) => (p.x - at.x) ** 2 + (p.y - at.y) ** 2 < (reach + radius) ** 2,
});

function boardCopper(board: Board): Copper[] {
  const pads = board.footprints.flatMap(footprint => footprint.pads).map((pad): Copper => ({
    kind: 'pad', net: pad.net, layers: pad.layers, box: rectBox(pad.bbox), near: (layer, p, reach) => padCollidesCircle(pad, layer, p, reach),
  }));
  return [...tracks(board).map(trackCopper), ...vias(board).map(via => roundCopper('via', via.net, null, via.at, via.size / 2)), ...pads];
}

const onLayer = (copper: Copper, layer: string): boolean => copper.layers === null || copper.layers.includes(layer);

/** A board that takes test points one by one: each new pad, courtyard and label counts for the next. */
export class TestPointBoard {
  readonly #board: Board;
  readonly #silk: Silk;
  readonly #clearanceOf: (net: string) => number;
  readonly #edges: Box;
  readonly #keepouts: Zone[];
  readonly #bodies: { box: Box; reference: string }[];
  readonly #copper: Copper[];
  readonly #points: Xy[];
  readonly #labels: Box[] = [];

  /** `clearanceOf`: the class clearance of a net, in millimetres. */
  constructor(board: Board, silk: Silk, clearanceOf: (net: string) => number) {
    this.#board = board;
    this.#silk = silk;
    this.#clearanceOf = clearanceOf;
    this.#edges = rectBox(board.edges_bbox);
    this.#keepouts = [...board.zones, ...board.footprints.flatMap(footprint => footprint.zones)].filter(zone => zone.rule_area);
    this.#bodies = board.footprints.map(footprint => ({ box: courtyardOf(footprint) ?? footprintBox(footprint), reference: footprint.reference }));
    this.#copper = boardCopper(board);
    this.#points = board.footprints.filter(footprint => footprint.reference.startsWith('TP')).map(footprint => mmOf(footprint.position));
  }

  /** The pad or the point a spec names. */
  target({ near, ref }: PointSpec): Pt {
    if (typeof near !== 'string') return { x: fromMm(near[0]), y: fromMm(near[1]) };
    const [reference, number] = near.split('.');
    const pad = this.#board.footprints.find(footprint => footprint.reference === reference)?.pads.find(item => item.number === number);
    if (!pad) throw new Error(`${ref}: no pad ${near} on the board`);
    return pad.position;
  }

  #layers(kind: Kind): string[] {
    return kind === 'tht' ? this.#board.copper_layers : ['F.Cu'];
  }

  #insideOutline([x, y]: Xy, reach: number): boolean {
    return insideBoard(this.#board, [x, y]) && Array.from({ length: RING_POINTS }, (_, i) => i * 2 * Math.PI / RING_POINTS)
      .every(angle => insideBoard(this.#board, [x + reach * Math.cos(angle), y + reach * Math.sin(angle)]));
  }

  #clearOfSilk(p: Pt, kind: Kind, radius: number): boolean {
    const sides = kind === 'tht' ? ['F.SilkS', 'B.SilkS'] : ['F.SilkS'];
    const [x, y] = mmOf(p);
    const reach = radius + SILK_GAP;
    const inBox = (box: Box): boolean => box[0] - reach < x && x < box[2] + reach && box[1] - reach < y && y < box[3] + reach;
    return !this.#silk.texts.some(text => sides.includes(text.layer) && inBox(text.box))
      && !this.#labels.some(inBox) // the labels of the points before this one: they are not on the board yet
      && !this.#board.graphics.some(shape => sides.includes(shape.layer) && shapeNear(shape, p, fromMm(reach)));
  }

  /** May the pad sit here? `others`: the copper of other nets on its layers. */
  #free(p: Pt, spec: PointSpec, pad: PadShape, others: [Copper, string][], gap: number): boolean {
    const [x, y] = mmOf(p);
    const { halfWidth: hw, halfHeight: hh, radius } = pad;
    const [left, top, right, bottom] = this.#edges;
    if (x - hw < left + EDGE_GAP || x + hw > right - EDGE_GAP || y - hh < top + EDGE_GAP || y + hh > bottom - EDGE_GAP) return false;
    const body: Box = [x - hw, y - hh, x + hw, y + hh];
    if (this.#bodies.some(({ box, reference }) => hit(grow(body, /^[UJ]/.test(reference) ? CONNECTOR_GAP : PART_GAP), box))) return false;
    if (!this.#insideOutline([x, y], Math.max(hw, hh) + RING_GAP)) return false;
    if (!this.#clearOfSilk(p, spec.kind, radius)) return false;
    const layers = this.#layers(spec.kind);
    const padRadius = fromMm(radius);
    if (this.#keepouts.some(zone => layers.some(layer => zone.layers.includes(layer)) && zone.outline.some(polygon => polygonNear(polygon, p, padRadius)))) return false;
    const reach = padRadius + gap;
    const window = grow(circleBox([x, y], 0), toMm(reach));
    return !others.some(([copper, layer]) => hit(copper.box, window) && copper.near(layer, p, reach));
  }

  /** Points on the net's plain F.Cu tracks that a pad of this radius covers, nearest first. Arcs have no test points. */
  #trackSpots(net: string, target: Pt, limit: number, radius: number): { at: Pt; distance: number }[] {
    const spots: { at: Pt; distance: number }[] = [];
    for (const { start, end, width, layer, net: own, mid } of tracks(this.#board)) {
      if (mid || own !== net || layer !== 'F.Cu' || toMm(width) > 2 * radius) continue;
      const steps = Math.max(1, Math.trunc(Math.hypot(end.x - start.x, end.y - start.y) / STEP));
      for (let i = 0; i <= steps; i++) {
        const [x, y] = [start.x + (end.x - start.x) * i / steps, start.y + (end.y - start.y) * i / steps];
        const distance = Math.hypot(x - target.x, y - target.y) / STEP;
        if (distance <= limit) spots.push({ at: whole(x, y), distance });
      }
    }
    return spots.sort((a, b) => a.distance - b.distance);
  }

  /** Not over a via (a via in an SMD pad), and clear of every pad of a part. */
  #clearOnTrack(p: Pt, radius: number): boolean {
    const reach = fromMm(radius);
    return !this.#copper.some(copper => (copper.kind === 'via' && copper.near('F.Cu', p, reach))
      || (copper.kind === 'pad' && onLayer(copper, 'F.Cu') && copper.near('F.Cu', p, reach + fromMm(PAD_GAP))));
  }

  /** Grid points round the target, nearest first; a tie keeps the order of the scan. */
  #gridSpots(target: Pt, limit: number): { at: Pt; distance: number }[] {
    const spots: { at: Pt; distance: number }[] = [];
    for (let ix = -limit; ix <= limit; ix++) {
      for (let iy = -limit; iy <= limit; iy++) {
        const distance = Math.hypot(ix, iy);
        if (distance <= limit) spots.push({ at: { x: target.x + ix * STEP, y: target.y + iy * STEP }, distance });
      }
    }
    return spots.sort((a, b) => a.distance - b.distance);
  }

  /** The best free place, or null. An SMD point takes a track of its net before any free grid point; track_only takes nothing else. */
  place(spec: PointSpec, pad: PadShape): Spot | null {
    const target = this.target(spec);
    const limit = Math.trunc(fromMm(spec.max_mm ?? DEFAULT_MAX_MM) / STEP);
    const gap = fromMm(Math.max(this.#clearanceOf(spec.net), MIN_CLEARANCE) + CLEARANCE_MARGIN);
    const others = this.#layers(spec.kind).flatMap(layer => this.#copper.filter(copper => copper.net !== spec.net && onLayer(copper, layer)).map((copper): [Copper, string] => [copper, layer]));
    const free = ({ at }: { at: Pt }): boolean => this.#free(at, spec, pad, others, gap);
    if (spec.kind === 'smd') {
      const onTrack = this.#trackSpots(spec.net, target, limit, pad.radius).find(spot => this.#clearOnTrack(spot.at, pad.radius) && free(spot));
      if (onTrack) return { ...onTrack, onTrack: true };
    }
    if (spec.track_only) return null;
    const onGrid = this.#gridSpots(target, limit).find(free);
    return onGrid ? { ...onGrid, onTrack: false } : null;
  }

  #labelClear(box: Box, pad: Xy): boolean {
    const grown = grow(box, LABEL_MARGIN);
    const centre = boxCentre(grown);
    const away = (point: Xy): number => Math.hypot(point[0] - centre[0], point[1] - centre[1]);
    const { texts, footprintTexts } = this.#silk;
    const userText = ({ layer, name }: FootprintText): boolean => layer === 'F.SilkS' && name === 'user';
    const shapes = [...this.#board.footprints.flatMap(footprint => footprint.graphics), ...this.#board.graphics].filter(shape => shape.layer === 'F.SilkS');
    const [x0, y0, x1, y1] = grow(grown, LABEL_EDGE_GAP);
    return !this.#copper.some(copper => copper.kind !== 'track' && onLayer(copper, 'F.Cu') && touch(copper.box, grown))
      && !texts.some(text => (text.layer === 'F.SilkS' || text.layer === 'B.SilkS') && touch(text.box, grown))
      && !footprintTexts.some(text => userText(text) && touch(text.ink, grown))
      && !shapes.some(shape => shapeTouchesBox(shape, grown))
      && !this.#labels.some(label => touch(label, grown))
      && !this.#bodies.some(body => touch(body.box, grown))
      && !this.#points.some(point => away(point) <= away(pad) + LABEL_NEARER)
      && ([[x0, y0], [x1, y0], [x0, y1], [x1, y1]] as const).every(corner => polygonsContain(this.#board.outlines, { x: fromMm(corner[0]), y: fromMm(corner[1]) }));
  }

  /** The first of the texts that fits beside the pad, at the first clear place, or null. */
  label(texts: string[], at: Pt, radius: number): Label | null {
    const pad = mmOf(at);
    for (const text of texts) {
      const size = textBox(text, { height: LABEL_SIZE, width: LABEL_SIZE, thickness: LABEL_PEN });
      for (const reach of LABEL_REACH) {
        for (const [ux, uy] of LABEL_WAYS) {
          const place: Xy = [pad[0] + ux * (radius + LABEL_SIDE_REACH + reach), pad[1] + uy * (radius + reach)];
          if (!this.#labelClear(offset(size, place), pad)) continue;
          this.#labels.push(grow(offset(size, place), LABEL_MARGIN));
          return { text, at: place };
        }
      }
    }
    return null;
  }

  /** The point is placed: it counts for the next one. */
  add({ ref, net, kind }: PointSpec, at: Pt, { halfWidth, halfHeight, radius }: PadShape): void {
    const [x, y] = mmOf(at);
    this.#bodies.push({ box: [x - halfWidth, y - halfHeight, x + halfWidth, y + halfHeight], reference: ref });
    this.#copper.push(roundCopper('pad', net, kind === 'tht' ? null : ['F.Cu'], at, fromMm(radius)));
    this.#points.push([x, y]);
  }
}
