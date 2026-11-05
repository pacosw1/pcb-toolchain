// Distances between new copper and what is on the board, in millimetres, y down: pcbtool's own clearance check, not KiCad's. A
// shape is a fattened segment or a polygon. Hit tests of pcbnew's meaning are in board-hit.ts; these are the measured gaps.
import { fixed } from './py-compat.mjs';
import { dist } from './py-math.ts';
import { formatG } from './py-numbers.ts';
import type { RouteSegment, Xy } from './route-spec.ts';

export type Shape = { kind: 'seg'; a: Xy; b: Xy; half: number } | { kind: 'poly'; points: Xy[] };
export interface Obstacle { shape: Shape; clearance: number; label: string }
export type Obstacles = Record<string, Obstacle[]>;

export const segmentShape = (a: Xy, b: Xy, half: number): Shape => ({ kind: 'seg', a, b, half });
export const dotShape = (at: Xy, half: number): Shape => ({ kind: 'seg', a: at, b: at, half });
export const polyShape = (points: Xy[]): Shape => ({ kind: 'poly', points });

const edges = (points: Xy[]): [Xy, Xy][] => points.map((a, i) => [a, points[(i + 1) % points.length]!]);

export function segDist(q: Xy, a: Xy, b: Xy): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.min(1, Math.max(0, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / ((dx * dx + dy * dy) || 1)));
  return dist(q, [a[0] + t * dx, a[1] + t * dy]);
}

export function inPoly(q: Xy, points: Xy[]): boolean {
  let inside = false;
  for (const [[ax, ay], [bx, by]] of edges(points)) {
    if ((ay > q[1]) !== (by > q[1]) && q[0] < ax + (q[1] - ay) * (bx - ax) / (by - ay)) inside = !inside;
  }
  return inside;
}

/** Smallest distance between segments a-b and c-d, 0 when they cross. */
export function segSegDist(a: Xy, b: Xy, c: Xy, d: Xy): number {
  const side = (p: Xy, q: Xy, r: Xy): number => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const [d1, d2, d3, d4] = [side(c, d, a), side(c, d, b), side(a, b, c), side(a, b, d)];
  if ((d1 > 0) !== (d2 > 0) && (d3 > 0) !== (d4 > 0) && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0) return 0;
  return Math.min(segDist(a, c, d), segDist(b, c, d), segDist(c, a, b), segDist(d, a, b));
}

/** Distance from segment a-b to a shape's edge; 0 when the segment starts inside or crosses a polygon. */
export function shapeSegDist(shape: Shape, a: Xy, b: Xy): number {
  if (shape.kind === 'seg') return segSegDist(a, b, shape.a, shape.b) - shape.half;
  if (inPoly(a, shape.points)) return 0;
  return Math.min(...edges(shape.points).map(([p, q]) => segSegDist(a, b, p, q)));
}

/** Distance from a point to a shape's edge, 0 or less inside it. */
export function shapeDist(shape: Shape, q: Xy): number {
  if (shape.kind === 'seg') return segDist(q, shape.a, shape.b) - shape.half;
  const distance = Math.min(...edges(shape.points).map(([a, b]) => segDist(q, a, b)));
  return inPoly(q, shape.points) ? -distance : distance;
}

export type Box = [left: number, top: number, right: number, bottom: number];

export function shapeBox(shape: Shape): Box {
  const points = shape.kind === 'seg' ? [shape.a, shape.b] : shape.points;
  const half = shape.kind === 'seg' ? shape.half : 0;
  const xs = points.map(point => point[0]);
  const ys = points.map(point => point[1]);
  return [Math.min(...xs) - half, Math.min(...ys) - half, Math.max(...xs) + half, Math.max(...ys) + half];
}

interface NewCopper { layer: string; kind: 'track' | 'via'; a: Xy; b: Xy; width: number }

/** New copper item by item. A via is on every layer of `obstacles`. */
function newCopper(segments: RouteSegment[], vias: Xy[], viaSize: number, obstacles: Obstacles): NewCopper[] {
  const tracks = segments.map(({ a, b, layer, width }): NewCopper => ({ layer, kind: 'track', a, b, width }));
  const holes = vias.flatMap(at => Object.keys(obstacles).map((layer): NewCopper => ({ layer, kind: 'via', a: at, b: at, width: viaSize })));
  return [...tracks, ...holes];
}

/** The first new item closer than its clearance to other-net copper, as one line, or null. */
export function firstConflict(segments: RouteSegment[], vias: Xy[], viaSize: number, obstacles: Obstacles): string | null {
  for (const { layer, kind, a, b, width } of newCopper(segments, vias, viaSize, obstacles)) {
    for (const { shape, clearance, label } of obstacles[layer] ?? []) {
      const gap = shapeSegDist(shape, a, b) - width / 2;
      if (gap < clearance - 1e-6) {
        const where = `(${fixed(a[0], 3)}, ${fixed(a[1], 3)})${kind === 'via' ? '' : `-(${fixed(b[0], 3)}, ${fixed(b[1], 3)})`}`;
        return `${layer} ${kind} ${where} w ${formatG(width)}: gap ${fixed(gap, 3)} < ${formatG(clearance)} to ${label}`;
      }
    }
  }
  return null;
}

/** Smallest gap minus clearance of new copper to other-net copper, and to what. Past `window` nothing is measured. */
export function nearestCopper(segments: RouteSegment[], vias: Xy[], viaSize: number, obstacles: Obstacles, window = 1): { margin: number; label: string } {
  let margin = window;
  let nearest = '';
  for (const { layer, a, b, width } of newCopper(segments, vias, viaSize, obstacles)) {
    const reach = width / 2 + window;
    const [loX, loY, hiX, hiY] = [Math.min(a[0], b[0]) - reach, Math.min(a[1], b[1]) - reach, Math.max(a[0], b[0]) + reach, Math.max(a[1], b[1]) + reach];
    for (const { shape, clearance, label } of obstacles[layer] ?? []) {
      const [left, top, right, bottom] = shapeBox(shape);
      if (left - clearance > hiX || right + clearance < loX || top - clearance > hiY || bottom + clearance < loY) continue;
      const gap = shapeSegDist(shape, a, b) - width / 2 - clearance;
      if (gap < margin) { margin = gap; nearest = label; }
    }
  }
  return { margin, label: nearest };
}

/** The margin of nearestCopper: negative on a conflict. */
export const clearMargin = (segments: RouteSegment[], vias: Xy[], viaSize: number, obstacles: Obstacles, window = 1): number =>
  nearestCopper(segments, vias, viaSize, obstacles, window).margin;
