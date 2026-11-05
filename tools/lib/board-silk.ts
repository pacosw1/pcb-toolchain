// The silkscreen of a board, for tools that place silk: boxes in millimetres, y down. Texts and board shapes come from the board
// text, which holds what the document does not (size, justification, visibility) and stays right while a tool edits it. Pads,
// courtyards and footprint shapes come from the board document, which those tools never change.
import { normalize180, pointSegmentSq, polygonsContain, fromMm } from './board-hit.ts';
import { toMm, type Board, type Footprint, type Graphic, type Polygon, type Pt, type Rect } from './board-types.ts';
import { atom, kids, layerOf, one, parse, pose, type SList } from './sexpr.ts';
import { inkBox, textBox, type Box, type HAlign, type TextStyle, type VAlign } from './stroke-text.ts';

export type { Box } from './stroke-text.ts';
export type Xy = readonly [number, number];

/** `box` is KiCad's box of the text, what other items keep clear of; `ink` is its strokes. */
export interface SilkText { uuid: string; text: string; layer: string; at: Xy; style: TextStyle; box: Box; ink: Box; visible: boolean; group?: string }
/** A field or a user text of a footprint. */
export interface FootprintText extends SilkText { reference: string; name: string; footprint: { at: Xy; angle: number } }
export interface SilkShape { uuid: string; layer: string; box: Box; group?: string }
export interface Silk { texts: SilkText[]; shapes: SilkShape[]; footprintTexts: FootprintText[] }

const DEFAULT_PEN_RATIO = 1 / 8; // EDA_TEXT: a text with no thickness draws at height / 8
const DEFAULT_COURTYARD_WIDTH_MM = 0.05; // KiCad's DEFAULT_COURTYARD_WIDTH
const SHAPE_KINDS = ['gr_line', 'gr_rect', 'gr_circle', 'gr_arc', 'gr_poly', 'gr_curve'];

export const hit = (a: Box, b: Box): boolean => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
/** BOX2::Intersects: two boxes that only touch count. */
export const touch = (a: Box, b: Box): boolean => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
export const grow = (box: Box, gap: number): Box => [box[0] - gap, box[1] - gap, box[2] + gap, box[3] + gap];
export const offset = (box: Box, [x, y]: Xy): Box => [box[0] + x, box[1] + y, box[2] + x, box[3] + y];
export const unionBox = (a: Box, b: Box): Box => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
export const boxCentre = (box: Box): Xy => [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];

export function boxOfPoints(points: readonly Xy[]): Box {
  const xs = points.map(point => point[0]);
  const ys = points.map(point => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export const rectBox = (rect: Rect): Box => [toMm(rect.left), toMm(rect.top), toMm(rect.right), toMm(rect.bottom)];
const ptMm = (point: Pt): Xy => [toMm(point.x), toMm(point.y)];

/** Footprint-local to board: KiCad's angle runs counter-clockwise with y down. */
export function toBoard([x, y]: Xy, { at, angle }: { at: Xy; angle: number }): Xy {
  const radians = angle * Math.PI / 180;
  const [cos, sin] = [Math.round(Math.cos(radians) * 1e12) / 1e12, Math.round(Math.sin(radians) * 1e12) / 1e12];
  return [at[0] + x * cos + y * sin, at[1] - x * sin + y * cos];
}

/** Board to footprint-local. */
export function toFootprint([x, y]: Xy, { at, angle }: { at: Xy; angle: number }): Xy {
  return toBoard([x - at[0], y - at[1]], { at: [0, 0], angle: -angle });
}

/** EDA_TEXT keeps a footprint text readable: its drawn angle stays within a quarter turn. */
function upright(degrees: number): number {
  const angle = normalize180(degrees);
  if (angle > 90) return angle - 180;
  return angle <= -90 ? angle + 180 : angle;
}

const uuidOf = (form: SList): string => { const id = one(form, 'uuid'); return id ? atom(id, 1) : ''; };
const yes = (form: SList | undefined): boolean => form !== undefined && (form.length < 2 || form[1] === 'yes');

function textStyle(form: SList, angle: number): { style: TextStyle; hidden: boolean } {
  const effects = one(form, 'effects') ?? [];
  const font = one(effects, 'font') ?? [];
  const size = one(font, 'size');
  const height = size ? Number(atom(size, 1)) : 1;
  const width = size ? Number(atom(size, 2)) : 1;
  const thickness = one(font, 'thickness');
  const justify = (one(effects, 'justify') ?? []).slice(1);
  const h: HAlign = justify.includes('left') ? 'left' : justify.includes('right') ? 'right' : 'center';
  const v: VAlign = justify.includes('top') ? 'top' : justify.includes('bottom') ? 'bottom' : 'center';
  return {
    style: { height, width, thickness: thickness ? Number(atom(thickness, 1)) : height * DEFAULT_PEN_RATIO, h, v, mirrored: justify.includes('mirror'), angle },
    hidden: yes(one(form, 'hide')) || yes(one(effects, 'hide')) || form.includes('hide'),
  };
}

const shownText = (text: string): string => text.replaceAll('\\n', '\n');

function readText(form: SList, text: string, at: Xy, angle: number, group?: string): SilkText {
  const { style, hidden } = textStyle(form, angle);
  const shown = shownText(text);
  return { uuid: uuidOf(form), text, layer: layerOf(form) ?? '', at, style, box: offset(textBox(shown, style), at), ink: offset(inkBox(shown, style), at), visible: !hidden, ...(group === undefined ? {} : { group }) };
}

function footprintTexts(form: SList): FootprintText[] {
  const { x, y, angle } = pose(form);
  const footprint = { at: [x, y] as Xy, angle };
  const reference = kids(form, 'property').find(field => field[1] === 'Reference')?.[2];
  const texts = [...kids(form, 'property').map(field => ({ field, name: atom(field, 1), text: atom(field, 2) })),
    ...kids(form, 'fp_text').map(field => ({ field, name: atom(field, 1), text: atom(field, 2) }))];
  return texts.filter(({ field }) => layerOf(field) !== undefined).map(({ field, name, text }) => {
    const local = pose(field);
    const drawn = yes(one(field, 'unlocked')) ? local.angle : upright(local.angle);
    return { ...readText(field, text, toBoard([local.x, local.y], footprint), drawn), reference: String(reference ?? ''), name, footprint };
  });
}

const point = (form: SList | undefined): Xy => (form ? [Number(atom(form, 1)), Number(atom(form, 2))] : [0, 0]);

/** The box of an arc from `start` round the centre, growing the angle, to `end`: EDA_SHAPE's way round. */
function arcBox(start: Xy, end: Xy, centre: Xy): Box {
  const radius = Math.hypot(start[0] - centre[0], start[1] - centre[1]);
  const angleOf = ([x, y]: Xy): number => Math.atan2(y - centre[1], x - centre[0]);
  const first = angleOf(start);
  let last = angleOf(end);
  while (last <= first) last += 2 * Math.PI;
  const extremes: Xy[] = [];
  for (let quarter = Math.ceil(first / (Math.PI / 2)); quarter * (Math.PI / 2) <= last; quarter += 1) {
    extremes.push([centre[0] + radius * Math.round(Math.cos(quarter * Math.PI / 2)), centre[1] + radius * Math.round(Math.sin(quarter * Math.PI / 2))]);
  }
  return boxOfPoints([start, end, ...extremes]);
}

/** The circle through three points. */
function circleCentre(a: Xy, b: Xy, c: Xy): Xy {
  const [bx, by, cx, cy] = [b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1]];
  const d = 2 * (bx * cy - by * cx);
  const [bb, cc] = [bx * bx + by * by, cx * cx + cy * cy];
  return [a[0] + (cy * bb - by * cc) / d, a[1] + (bx * cc - cx * bb) / d];
}

function shapeBox(form: SList): Box {
  const stroke = one(form, 'stroke');
  const widthForm = one(stroke ?? form, 'width');
  const half = (widthForm ? Number(atom(widthForm, 1)) : 0) / 2;
  const kind = form[0];
  const [start, end] = [point(one(form, 'start')), point(one(form, 'end'))];
  if (kind === 'gr_circle') {
    const centre = point(one(form, 'center'));
    const radius = Math.hypot(end[0] - centre[0], end[1] - centre[1]);
    return grow([centre[0] - radius, centre[1] - radius, centre[0] + radius, centre[1] + radius], half);
  }
  if (kind === 'gr_arc') {
    const mid = point(one(form, 'mid'));
    const centre = circleCentre(start, mid, end);
    const shrinking = (mid[0] - start[0]) * (end[1] - start[1]) - (mid[1] - start[1]) * (end[0] - start[0]) < 0;
    return grow(shrinking ? arcBox(end, start, centre) : arcBox(start, end, centre), half);
  }
  const points = one(form, 'pts');
  return grow(boxOfPoints(points ? kids(points, 'xy').map(point) : [start, end]), half);
}

/** The silk of a board text: every text and shape, on any layer. */
export function readSilk(boardText: string): Silk {
  const root = parse(boardText);
  const groupOf = new Map(kids(root, 'group').flatMap(group => (one(group, 'members') ?? []).slice(1).map(member => [String(member), atom(group, 1)] as const)));
  const texts = kids(root, 'gr_text').map(form => {
    const { x, y, angle } = pose(form);
    return readText(form, atom(form, 1), [x, y], angle, groupOf.get(uuidOf(form)));
  });
  const shapes = SHAPE_KINDS.flatMap(kind => kids(root, kind)).map(form => {
    const group = groupOf.get(uuidOf(form));
    return { uuid: uuidOf(form), layer: layerOf(form) ?? '', box: shapeBox(form), ...(group === undefined ? {} : { group }) };
  });
  return { texts, shapes, footprintTexts: kids(root, 'footprint').flatMap(footprintTexts) };
}

/** A shape of the document, with its line width. */
export function graphicBox({ geometry, width }: Graphic): Box | null {
  const half = toMm(width) / 2;
  if (geometry === 'Other') return null;
  if ('Segment' in geometry) return grow(boxOfPoints([ptMm(geometry.Segment.start), ptMm(geometry.Segment.end)]), half);
  if ('Rect' in geometry) return grow(boxOfPoints([ptMm(geometry.Rect.top_left), ptMm(geometry.Rect.bottom_right)]), half);
  if ('Circle' in geometry) {
    const [x, y] = ptMm(geometry.Circle.center);
    const [px, py] = ptMm(geometry.Circle.radius_point);
    const radius = Math.hypot(px - x, py - y);
    return grow([x - radius, y - radius, x + radius, y + radius], half);
  }
  if ('Arc' in geometry) return grow(arcBox(ptMm(geometry.Arc.start), ptMm(geometry.Arc.end), ptMm(geometry.Arc.center)), half);
  const points = geometry.Poly.rings.flat().map(ptMm);
  return points.length ? grow(boxOfPoints(points), half) : null;
}

/** The boxes of the shapes on a layer: a box is an array, so a flatMap over them would spill its numbers. */
export const graphicBoxes = (items: Graphic[], layer: string): Box[] =>
  items.filter(item => item.layer === layer).map(graphicBox).filter(box => box !== null);

export function polygonsBox(polygons: Polygon[]): Box | null {
  const points = polygons.flatMap(polygon => polygon.outline.map(ptMm));
  return points.length ? boxOfPoints(points) : null;
}

/** FOOTPRINT::BuildCourtyardCaches: the outline takes the commonest stroke of the courtyard, the smallest of a tie. */
function courtyardStroke(footprint: Footprint): number {
  const counts = new Map<number, number>();
  for (const item of footprint.graphics) if (item.layer === 'F.CrtYd') counts.set(item.width, (counts.get(item.width) ?? 0) + 1);
  const [width = 0] = [...counts].sort(([a, m], [b, n]) => n - m || a - b)[0] ?? [];
  return width ? toMm(width) : DEFAULT_COURTYARD_WIDTH_MM;
}

/** The courtyard of a footprint on the top side, or null: FOOTPRINT::GetCourtyard().BBox(), which a chain's width grows by that width. */
export function courtyardOf(footprint: Footprint): Box | null {
  const box = polygonsBox(footprint.courtyard_front);
  return box && grow(box, courtyardStroke(footprint));
}

/** The pads and shapes of a footprint: what its courtyard stands for when it has none. */
export function footprintBox(footprint: Footprint): Box {
  const boxes = [...footprint.pads.map(pad => rectBox(pad.bbox)), ...footprint.graphics.map(graphicBox).filter(box => box !== null)];
  return boxes.length ? boxes.reduce(unionBox) : [...ptMm(footprint.position), ...ptMm(footprint.position)];
}

/** Is the point inside the board, at least `gap` mm from its outline and cut-outs? */
export function insideBoard(board: Board, [x, y]: Xy, gap = 0): boolean {
  const at = { x: fromMm(x), y: fromMm(y) };
  if (!polygonsContain(board.outlines, at)) return false;
  if (gap <= 0) return true;
  const reach = (gap * 1e6) ** 2;
  return !board.outlines.some(({ outline, holes }) => [outline, ...holes].some(ring =>
    ring.some((a, i) => pointSegmentSq(at, a, ring[(i + 1) % ring.length]!) < reach)));
}

/** Corners and edge middles of a box: the nine points a tool tests against the outline. */
export function boxProbes([x0, y0, x1, y1]: Box): Xy[] {
  return [0, 1, 2, 3, 4, 5, 6, 7, 8].map(k => [x0 + (x1 - x0) * (k % 3) / 2, y0 + (y1 - y0) * Math.floor(k / 3) / 2]);
}
