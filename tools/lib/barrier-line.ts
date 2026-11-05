// The line at a fixed distance round a set of shapes: the outline of copper grown by half an isolation gap. The shapes go on a
// grid, an exact distance transform gives each cell its distance to them, and marching squares draws the level line. The line
// is a mark on the silkscreen, so a grid of PITCH_MM is close enough: it stands within about one pitch of the true offset.
import { boxOfPoints, type Box, type Xy } from './board-silk.ts';

export type BarrierShape =
  | { kind: 'polygon'; rings: Xy[][] }
  | { kind: 'capsule'; a: Xy; b: Xy; radius: number };

const PITCH_MM = 0.05;
const SIMPLIFY_MM = 0.02;
const FAR = 1e20;

interface Grid { x0: number; y0: number; columns: number; rows: number }

const centreOf = (grid: Grid, column: number, row: number): Xy => [grid.x0 + (column + 0.5) * PITCH_MM, grid.y0 + (row + 0.5) * PITCH_MM];

function shapeBox(shape: BarrierShape): Box {
  if (shape.kind === 'polygon') return boxOfPoints(shape.rings.flat());
  const [x0, y0, x1, y1] = boxOfPoints([shape.a, shape.b]);
  return [x0 - shape.radius, y0 - shape.radius, x1 + shape.radius, y1 + shape.radius];
}

/** Even-odd fill: the crossings of each cell row, paired from left to right. */
function fillPolygon(mask: Uint8Array, grid: Grid, rings: Xy[][]): void {
  const edges = rings.flatMap(ring => ring.map((a, i) => [a, ring[(i + 1) % ring.length]!] as const));
  const [, top, , bottom] = boxOfPoints(rings.flat());
  const firstRow = Math.max(0, Math.floor((top - grid.y0) / PITCH_MM));
  const lastRow = Math.min(grid.rows - 1, Math.ceil((bottom - grid.y0) / PITCH_MM));
  for (let row = firstRow; row <= lastRow; row++) {
    const y = grid.y0 + (row + 0.5) * PITCH_MM;
    const crossings = edges.filter(([a, b]) => (a[1] > y) !== (b[1] > y)).map(([a, b]) => a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1])).sort((p, q) => p - q);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const from = Math.max(0, Math.ceil((crossings[k]! - grid.x0) / PITCH_MM - 0.5));
      const to = Math.min(grid.columns - 1, Math.floor((crossings[k + 1]! - grid.x0) / PITCH_MM - 0.5));
      mask.fill(1, row * grid.columns + from, row * grid.columns + to + 1);
    }
  }
}

function segmentDistance([x, y]: Xy, [ax, ay]: Xy, [bx, by]: Xy): number {
  const [dx, dy] = [bx - ax, by - ay];
  const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / ((dx * dx + dy * dy) || 1)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

function fillCapsule(mask: Uint8Array, grid: Grid, shape: Extract<BarrierShape, { kind: 'capsule' }>): void {
  const [x0, y0, x1, y1] = shapeBox(shape);
  const columnOf = (x: number): number => Math.min(grid.columns - 1, Math.max(0, Math.floor((x - grid.x0) / PITCH_MM)));
  const rowOf = (y: number): number => Math.min(grid.rows - 1, Math.max(0, Math.floor((y - grid.y0) / PITCH_MM)));
  for (let row = rowOf(y0); row <= rowOf(y1); row++) {
    for (let column = columnOf(x0); column <= columnOf(x1); column++) {
      if (segmentDistance(centreOf(grid, column, row), shape.a, shape.b) <= shape.radius) mask[row * grid.columns + column] = 1;
    }
  }
}

/** Felzenszwalb and Huttenlocher's transform of one line of squared distances, in place. */
function transformLine(line: Float64Array, count: number, hull: Int32Array, bounds: Float64Array, out: Float64Array): void {
  let top = 0;
  hull[0] = 0;
  bounds[0] = -FAR;
  bounds[1] = FAR;
  for (let q = 1; q < count; q++) {
    let crossing: number;
    for (;;) {
      const p = hull[top]!;
      crossing = (line[q]! + q * q - line[p]! - p * p) / (2 * (q - p));
      if (crossing > bounds[top]!) break;
      top -= 1;
    }
    top += 1;
    hull[top] = q;
    bounds[top] = crossing;
    bounds[top + 1] = FAR;
  }
  let at = 0;
  for (let q = 0; q < count; q++) {
    while (bounds[at + 1]! < q) at += 1;
    const p = hull[at]!;
    out[q] = (q - p) * (q - p) + line[p]!;
  }
  line.set(out.subarray(0, count));
}

/** The distance in millimetres from each cell to the nearest filled cell. */
function distances(mask: Uint8Array, { columns, rows }: Grid): Float64Array {
  const squared = new Float64Array(mask.length);
  for (let i = 0; i < mask.length; i++) squared[i] = mask[i] ? 0 : FAR;
  const longest = Math.max(columns, rows);
  const [line, out] = [new Float64Array(longest), new Float64Array(longest)];
  const [hull, bounds] = [new Int32Array(longest), new Float64Array(longest + 1)];
  for (let column = 0; column < columns; column++) {
    for (let row = 0; row < rows; row++) line[row] = squared[row * columns + column]!;
    transformLine(line, rows, hull, bounds, out);
    for (let row = 0; row < rows; row++) squared[row * columns + column] = line[row]!;
  }
  for (let row = 0; row < rows; row++) {
    line.set(squared.subarray(row * columns, (row + 1) * columns));
    transformLine(line, columns, hull, bounds, out);
    squared.set(line.subarray(0, columns), row * columns);
  }
  // A filled cell's centre stands about half a cell inside the shape.
  return squared.map(value => Math.max(0, Math.sqrt(value) - 0.5) * PITCH_MM);
}

/** Marching squares: each cell of four samples adds its pieces of the level line, as pairs of edge keys. */
function levelEdges(field: Float64Array, grid: Grid, level: number): { points: Map<string, Xy>; links: Map<string, string[]> } {
  const { columns, rows } = grid;
  const points = new Map<string, Xy>();
  const links = new Map<string, string[]>();
  const value = (column: number, row: number): number => field[row * columns + column]!;
  const crossing = (c0: number, r0: number, c1: number, r1: number): string => {
    const key = `${c0},${r0},${c1},${r1}`;
    if (!points.has(key)) {
      const t = (level - value(c0, r0)) / (value(c1, r1) - value(c0, r0));
      const [ax, ay] = centreOf(grid, c0, r0);
      const [bx, by] = centreOf(grid, c1, r1);
      points.set(key, [ax + t * (bx - ax), ay + t * (by - ay)]);
    }
    return key;
  };
  const link = (a: string, b: string): void => {
    links.set(a, [...(links.get(a) ?? []), b]);
    links.set(b, [...(links.get(b) ?? []), a]);
  };
  for (let row = 0; row + 1 < rows; row++) {
    for (let column = 0; column + 1 < columns; column++) {
      const first = value(column, row) <= level;
      if ((value(column + 1, row) <= level) === first && (value(column + 1, row + 1) <= level) === first && (value(column, row + 1) <= level) === first) continue;
      const inside = [value(column, row), value(column + 1, row), value(column + 1, row + 1), value(column, row + 1)].map(sample => sample <= level);
      const top = (): string => crossing(column, row, column + 1, row);
      const right = (): string => crossing(column + 1, row, column + 1, row + 1);
      const bottom = (): string => crossing(column, row + 1, column + 1, row + 1);
      const left = (): string => crossing(column, row, column, row + 1);
      const flips = [top, right, bottom, left].map((edge, i) => (inside[i] !== inside[(i + 1) % 4] ? edge() : null)).filter((key): key is string => key !== null);
      if (flips.length === 2) link(flips[0]!, flips[1]!);
      else { link(flips[0]!, flips[3]!); link(flips[1]!, flips[2]!); } // a saddle: either pairing is a closed line
    }
  }
  return { points, links };
}

function closedRings({ points, links }: ReturnType<typeof levelEdges>): Xy[][] {
  const seen = new Set<string>();
  const rings: Xy[][] = [];
  for (const start of links.keys()) {
    if (seen.has(start)) continue;
    const ring: Xy[] = [];
    let at: string | undefined = start;
    while (at !== undefined && !seen.has(at)) {
      seen.add(at);
      ring.push(points.get(at)!);
      at = links.get(at)!.find(next => !seen.has(next));
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

/** Douglas-Peucker on an open run of points. */
function simplified(points: Xy[]): Xy[] {
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let [worst, far] = [SIMPLIFY_MM, -1];
    for (let i = first + 1; i < last; i++) {
      const distance = segmentDistance(points[i]!, points[first]!, points[last]!);
      if (distance > worst) [worst, far] = [distance, i];
    }
    if (far < 0) continue;
    keep[far] = 1;
    stack.push([first, far], [far, last]);
  }
  return points.filter((_, i) => keep[i]);
}

function ringContains(ring: Xy[], [x, y]: Xy): boolean {
  let inside = false;
  ring.forEach(([ax, ay], i) => {
    const [bx, by] = ring[(i + 1) % ring.length]!;
    if ((ay > y) !== (by > y) && x < ax + (y - ay) * (bx - ax) / (by - ay)) inside = !inside;
  });
  return inside;
}

/** The outer lines of the shapes grown by `distance`: a line that bounds a hole of the grown region is left out. */
export function offsetOutlines(shapes: BarrierShape[], distance: number): Xy[][] {
  if (!shapes.length) return [];
  const boxes = shapes.map(shapeBox);
  const margin = distance + 2 * PITCH_MM;
  const x0 = Math.min(...boxes.map(box => box[0])) - margin;
  const y0 = Math.min(...boxes.map(box => box[1])) - margin;
  const x1 = Math.max(...boxes.map(box => box[2])) + margin;
  const y1 = Math.max(...boxes.map(box => box[3])) + margin;
  const grid: Grid = { x0, y0, columns: Math.ceil((x1 - x0) / PITCH_MM), rows: Math.ceil((y1 - y0) / PITCH_MM) };
  const mask = new Uint8Array(grid.columns * grid.rows);
  for (const shape of shapes) {
    if (shape.kind === 'polygon') fillPolygon(mask, grid, shape.rings);
    else fillCapsule(mask, grid, shape);
  }
  const rings = closedRings(levelEdges(distances(mask, grid), grid, distance));
  const outer = rings.filter(ring => rings.filter(other => other !== ring && ringContains(other, ring[0]!)).length % 2 === 0);
  return outer.map(ring => simplified([...ring, ring[0]!]).slice(0, -1));
}
