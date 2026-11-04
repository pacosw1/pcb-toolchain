import type plotter from 'gerber-plotter';
import type { Geometry, Point } from './types.ts';

export type Primitive = plotter.Shape | plotter.Clip | { type: 'layer'; polarity: plotter.Polarity };
export const union = (items: Geometry[]): Geometry => ({ kind: 'union', items });
const polygon = (points: Point[]): Geometry => ({ kind: 'polygon', points });
const circle = (center: Point, radius: number): Geometry => ({ kind: 'circle', center, radius });

function rectangle(cx: number, cy: number, width: number, height: number): Geometry {
  return polygon([[cx - width / 2, cy - height / 2], [cx + width / 2, cy - height / 2],
    [cx + width / 2, cy + height / 2], [cx - width / 2, cy + height / 2]]);
}

/** The same 24 segments per quadrant used by gerber_netcheck.py's Shapely buffers. */
export function primitiveGeometry(shape: Exclude<Primitive, { type: 'layer' }>): Geometry {
  switch (shape.type) {
    case 'circle': return circle([shape.cx, shape.cy], shape.r);
    case 'poly': return polygon(shape.points);
    case 'rect': {
      if (!shape.r) return rectangle(shape.cx, shape.cy, shape.width, shape.height);
      const [dx, dy] = [shape.width / 2 - shape.r, shape.height / 2 - shape.r];
      return union([
        rectangle(shape.cx, shape.cy, shape.width - 2 * shape.r, shape.height),
        rectangle(shape.cx, shape.cy, shape.width, shape.height - 2 * shape.r),
        ...[-dx, dx].flatMap(x => [-dy, dy].map(y => circle([shape.cx + x, shape.cy + y], shape.r))),
      ]);
    }
    case 'ring': return { kind: 'difference', a: circle([shape.cx, shape.cy], shape.r + shape.width / 2),
      b: circle([shape.cx, shape.cy], Math.max(0, shape.r - shape.width / 2)) };
    case 'clip': return { kind: 'intersection', a: union(shape.shape.map(primitiveGeometry)), b: primitiveGeometry(shape.clip) };
  }
}

/** A macro's clear primitives affect that aperture alone, including when it flashes over existing copper. */
export function toolGeometry(shapes: Primitive[]): Geometry {
  let geometry = union([]);
  let dark = true;
  let pending: Geometry[] = [];
  const flush = () => {
    if (pending.length) geometry = dark ? union([geometry, ...pending]) : { kind: 'difference', a: geometry, b: union(pending) };
    pending = [];
  };
  for (const shape of shapes) {
    if (shape.type === 'layer') { flush(); dark = shape.polarity === 'dark'; }
    else pending.push(primitiveGeometry(shape));
  }
  flush();
  return geometry;
}

/** Arcs keep the original sampling density: at least eight segments, otherwise eight per mm of arc length. */
export function segmentPoints(segment: plotter.Segment): Point[] {
  if (segment.type === 'line') return [segment.start, segment.end];
  const steps = Math.max(8, Math.trunc(Math.abs(segment.sweep) * segment.radius * 8));
  const start = segment.start[2];
  const sweep = Math.abs(segment.sweep) * (segment.dir === 'cw' ? -1 : 1);
  const points: Point[] = Array.from({ length: steps + 1 }, (_, i) => {
    const angle = start + sweep * i / steps;
    return [segment.center[0] + segment.radius * Math.cos(angle), segment.center[1] + segment.radius * Math.sin(angle)];
  });
  points[0] = [segment.start[0], segment.start[1]];
  points[steps] = [segment.end[0], segment.end[1]];
  return points;
}

export function pathGeometry(path: plotter.Segment[], width?: number): Geometry {
  const rings: Point[][] = [];
  for (const segment of path) {
    const points = segmentPoints(segment);
    const last = rings.at(-1);
    if (last && last.at(-1)![0] === points[0][0] && last.at(-1)![1] === points[0][1]) last.push(...points.slice(1));
    else rings.push(points);
  }
  return width === undefined ? { kind: 'region', rings }
    : union(rings.map(points => ({ kind: 'stroke', points, width })));
}
