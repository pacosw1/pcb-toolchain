// The Japanese wave pattern (seigaiha) as visible arc spans. Millimetres and degrees, y down.
import { hypot } from './py-math.ts';

type Box = readonly [number, number, number, number];
export interface WaveArc { centre: [number, number]; radius: number; from: number; to: number }

/** Scale centres: rows r/2 apart, scales 2r apart, odd rows shifted by r. Every scale fits in the box. */
function scaleCentres([x0, y0, x1, y1]: Box, r: number): [number, number][] {
  const centres: [number, number][] = [];
  for (let row = 0; y0 + r + row * r / 2 <= y1; row++) {
    const y = y0 + r + row * r / 2;
    for (let x = x0 + r + (row % 2 ? r : 0); x + r <= x1 + 1e-9; x += 2 * r) centres.push([x, y]);
  }
  return centres;
}

/** Scales of radius r with `rings` rings each. A lower row is in front; only upper halves are drawn (y down: 180 to 360 degrees). */
export function seigaiha(box: Box, r: number, rings = 3, stepDeg = 4): WaveArc[] {
  const centres = scaleCentres(box, r);
  const arcs: WaveArc[] = [];
  for (const centre of centres) {
    const front = centres.filter(other => other[1] > centre[1] + 1e-9 && Math.abs(other[0] - centre[0]) < 2 * r && other[1] - centre[1] < 2 * r);
    for (let ring = 1; ring <= rings; ring++) {
      const radius = r * ring / rings;
      let span: [number, number] | null = null;
      for (let angle = 180; angle < 360; angle += stepDeg) {
        const middle = (angle + stepDeg / 2) * Math.PI / 180;
        const x = centre[0] + radius * Math.cos(middle);
        const y = centre[1] + radius * Math.sin(middle);
        if (!front.some(other => hypot(x - other[0], y - other[1]) < r - 1e-6)) {
          span = span ? [span[0], angle + stepDeg] : [angle, angle + stepDeg];
        } else if (span) {
          arcs.push({ centre, radius, from: span[0], to: span[1] });
          span = null;
        }
      }
      if (span) arcs.push({ centre, radius, from: span[0], to: span[1] });
    }
  }
  return arcs;
}
