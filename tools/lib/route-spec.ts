// Place and route specs of pcbtool as plain data: what the agent wrote, turned into positions, segments and vias. Millimetres,
// y down. Nothing here reads a board.
import { validateGrid, validatePlaceSpec, validateRouteSpec } from './explicit-spec.ts';
import { floatRepr } from './py-compat.mjs';
import { pyFloat, round } from './py-numbers.ts';

export type Xy = [number, number];
export type RoutePoint = Xy | { via: Xy; to?: string };

export interface RouteSpec {
  net: string; width: number; layer: string; path: RoutePoint[];
  any_angle?: boolean; via_size?: number; via_drill?: number;
}
export interface RouteSegment { a: Xy; b: Xy; layer: string; width: number }
export interface ExpandedRoute { segments: RouteSegment[]; vias: Xy[] }

export interface GridSpec { refs: string[]; origin: Xy; pitch: Xy; cols?: number; rot?: number }
export interface PlaceSpec { place?: Record<string, [number, number, number]>; grids?: GridSpec[] }
export type Placement = [number, number, number];

/** Layer change of a via with no named target. */
export const OTHER_SIDE: Record<string, string> = { 'F.Cu': 'B.Cu', 'B.Cu': 'F.Cu' };

/** A number of a JSON spec as Python printed it. JSON 1.0 reads as 1 here, so it prints without the .0. */
const specNumber = (value: number): string => (Number.isInteger(value) ? String(value) : floatRepr(value));
/** A point of a spec as Python printed the tuple. */
export const specPoint = ([x, y]: Xy): string => `(${specNumber(x)}, ${specNumber(y)})`;
/** A point of the connect command: its numbers are always floats. */
export const floatPoint = ([x, y]: Xy): string => `(${floatRepr(x)}, ${floatRepr(y)})`;

export function gridPositions(grid: GridSpec): Map<string, Placement> {
  validateGrid(grid);
  const cols = grid.cols || grid.refs.length;
  const [dx, dy] = grid.pitch;
  const [x0, y0] = grid.origin;
  return new Map(grid.refs.map((ref, i) => {
    const column = i % cols;
    const row = Math.floor(i / cols);
    return [ref, [round(x0 + column * dx, 4), round(y0 + row * dy, 4), grid.rot ?? 0]];
  }));
}

export function placements(spec: PlaceSpec): Map<string, Placement> {
  validatePlaceSpec(spec);
  const out = new Map<string, Placement>(Object.entries(spec.place ?? {}));
  for (const grid of spec.grids ?? []) {
    for (const [ref, placed] of gridPositions(grid)) {
      if (out.has(ref)) throw new Error(`${ref} is placed twice`);
      out.set(ref, placed);
    }
  }
  return out;
}

const samePoint = (a: Xy, b: Xy): boolean => a[0] === b[0] && a[1] === b[1];

/** The segments and vias of a route. A bad path is an error; `show` prints a point in its message. */
export function expandRoute(route: RouteSpec, show: (point: Xy) => string = specPoint): ExpandedRoute {
  validateRouteSpec(route);
  if (route.path.length < 2) throw new Error(`${route.net}: a path needs 2 or more points`);
  const segments: RouteSegment[] = [];
  const vias: Xy[] = [];
  let layer = route.layer;
  let previous: Xy | null = null;
  const leg = (to: Xy): void => {
    if (previous) segments.push({ a: previous, b: to, layer, width: route.width });
  };
  for (const point of route.path) {
    if (Array.isArray(point)) {
      leg(point);
      previous = point;
      continue;
    }
    const at = point.via;
    if (previous && !samePoint(at, previous)) leg(at);
    vias.push(at);
    const target = point.to || OTHER_SIDE[layer];
    if (!target || target === layer) throw new Error(`${route.net}: via at ${show(at)} from ${layer} needs a target layer (via X,Y@LAYER)`);
    layer = target;
    previous = at;
  }
  for (const { a, b } of segments) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) throw new Error(`${route.net}: zero-length segment at ${show(a)}`);
    const straight = Math.abs(dx) < 1e-6 || Math.abs(dy) < 1e-6 || Math.abs(Math.abs(dx) - Math.abs(dy)) < 1e-6;
    if (!route.any_angle && !straight) throw new Error(`${route.net}: segment ${show(a)}->${show(b)} is not 0/45/90 degrees`);
  }
  return { segments, vias };
}

export interface IntentPoint { kind: 'through' | 'via'; at: Xy; to?: string }
export interface PadName { ref: string; number: string }
export interface Intent {
  net: string; a: PadName; b: PadName; layer: string | null; width: number | null; via: number[] | null; points: IntentPoint[];
}

function padName(text: string): PadName {
  const dot = text.indexOf('.');
  const [ref, number] = [text.slice(0, Math.max(dot, 0)), text.slice(dot + 1)];
  if (dot < 0 || !ref || !number) throw new Error(`expected REF.PAD, got ${text}`);
  return { ref, number };
}

function intentPoint(kind: IntentPoint['kind'], text: string | undefined, line: string): IntentPoint {
  const bad = new Error(`${kind} needs x,y (via: x,y or x,y@LAYER): ${line}`);
  if (text === undefined) throw bad;
  const at = text.indexOf('@');
  const coordinates = (at < 0 ? text : text.slice(0, at)).split(',');
  const to = at < 0 ? '' : text.slice(at + 1);
  if (coordinates.length !== 2 || (at >= 0 && (kind !== 'via' || !to))) throw bad;
  try {
    const point: IntentPoint = { kind, at: [pyFloat(coordinates[0]!), pyFloat(coordinates[1]!)] };
    return to ? { ...point, to } : point;
  } catch {
    throw bad;
  }
}

/** One connect line: NET REF.PAD -> REF.PAD [layer=L] [width=W] [via=auto|D/DRILL] [through x,y] [via x,y[@L]] ... */
export function parseIntent(line: string): Intent {
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length < 4 || words[2] !== '->') throw new Error(`expected "NET REF.PAD -> REF.PAD ...": ${line}`);
  const intent: Intent = { net: words[0]!, a: padName(words[1]!), b: padName(words[3]!), layer: null, width: null, via: null, points: [] };
  const rest = words.slice(4);
  while (rest.length) {
    const word = rest.shift()!;
    if (word === 'through' || word === 'via') intent.points.push(intentPoint(word, rest.shift(), line));
    else if (word.startsWith('layer=')) intent.layer = word.slice(6);
    else if (word.startsWith('width=')) intent.width = word.slice(6) === 'auto' ? null : pyFloat(word.slice(6));
    else if (word.startsWith('via=')) intent.via = word.slice(4) === 'auto' ? null : word.slice(4).split('/').map(pyFloat);
    else throw new Error(`unknown option ${word}: ${line}`);
  }
  return intent;
}

/** Points from a to b, a not included: half the straight part, the diagonal, the other half. Pads are entered straight. */
export function leg(a: Xy, b: Xy): Xy[] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const diagonal = Math.min(Math.abs(dx), Math.abs(dy));
  const straight = Math.max(Math.abs(dx), Math.abs(dy)) - diagonal;
  if (diagonal < 1e-9 || straight < 1e-9) return [b];
  const sx = dx < 0 ? -1 : 1;
  const sy = dy < 0 ? -1 : 1;
  const half: Xy = Math.abs(dx) > Math.abs(dy) ? [sx * straight / 2, 0] : [0, sy * straight / 2];
  const first: Xy = [a[0] + half[0], a[1] + half[1]];
  return [first, [first[0] + sx * diagonal, first[1] + sy * diagonal], b];
}

/** The route of an intent, from the pad centres, the start layer, the width and the via (size, drill). */
export function intentRoute(intent: Intent, start: Xy, end: Xy, layer: string, width: number, via: number[]): RouteSpec {
  const path: RoutePoint[] = [start];
  let current = start;
  for (const point of [...intent.points, { kind: 'end' as const, at: end }]) {
    path.push(...leg(current, point.at).slice(0, -1));
    if (point.kind !== 'via') path.push(point.at);
    else path.push(point.to ? { via: point.at, to: point.to } : { via: point.at });
    current = point.at;
  }
  return { net: intent.net, width, layer, via_size: via[0]!, via_drill: via[1]!, path };
}
