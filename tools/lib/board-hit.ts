// The point and shape tests of pcbnew on board JSON, in whole nanometres. The polygon tests mirror
// tools/router/core/src/kicad/geom/polygon.rs. The item tests follow KiCad 10: PAD::HitTest, PCB_TRACK::HitTest,
// PCB_ARC::HitTest, PCB_VIA::HitTest, TestSegmentHit, SHAPE_LINE_CHAIN_BASE::PointInside. A test point must be whole: take it
// from a document or through fromMm.
import { NM_PER_MM, type Pad, type PadCopper, type Polygon, type Pt, type Track, type Via } from './board-types.ts';

/** pcbnew.FromMM: cut toward zero, not rounded. */
export const fromMm = (mm: number): number => Math.trunc(mm * NM_PER_MM);

/** KiCad's KiROUND: to the nearest, half away from zero. */
const kiRound = (v: number): number => Math.sign(v) * Math.round(Math.abs(v));

/** The point turned about the origin, as KiCad's RotatePoint: quarter turns are exact. */
export function rotated(p: Pt, degrees: number): Pt {
  const angle = ((degrees % 360) + 360) % 360;
  if (angle === 0) return p;
  if (angle === 90) return { x: p.y, y: -p.x };
  if (angle === 180) return { x: -p.x, y: -p.y };
  if (angle === 270) return { x: -p.y, y: p.x };
  const radians = angle * Math.PI / 180;
  return { x: kiRound(p.y * Math.sin(radians) + p.x * Math.cos(radians)), y: kiRound(p.y * Math.cos(radians) - p.x * Math.sin(radians)) };
}

/** `a * b / c` rounded to the nearest, as KiCad's rescale. The product passes 2^53 on a board, so it is exact here. */
function rescale(a: number, b: number, c: number): number {
  const n = BigInt(a) * BigInt(b);
  const d = BigInt(c);
  const half = (d < 0n ? -d : d) / 2n;
  return Number((n < 0n) !== (d < 0n) ? (n - half) / d : (n + half) / d);
}

/** SHAPE_LINE_CHAIN::PointInside with no accuracy margin: an even-odd ray to +x, so a left or top edge is inside. */
export function ringContains(ring: Pt[], p: Pt): boolean {
  if (ring.length < 3) return false;
  let inside = false;
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length]!;
    if (a.y !== b.y && (a.y >= p.y) !== (b.y >= p.y) && p.x - a.x < rescale(b.x - a.x, p.y - a.y, b.y - a.y)) inside = !inside;
  });
  return inside;
}

const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y;
const minus = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });

/** Squared distance from a point to a segment. */
export function pointSegmentSq(p: Pt, a: Pt, b: Pt): number {
  const ab = minus(b, a);
  const ap = minus(p, a);
  const length = dot(ab, ab);
  const t = length === 0 ? 0 : Math.min(1, Math.max(0, dot(ap, ab) / length));
  const dx = ap.x - t * ab.x;
  const dy = ap.y - t * ab.y;
  return dx * dx + dy * dy;
}

const sign = (v: bigint): number => (v > 0n ? 1 : v < 0n ? -1 : 0);
/** Two products of board coordinates pass 2^53, so a side test is exact only in BigInt. */
function cross(o: Pt, a: Pt, b: Pt): bigint {
  return BigInt(a.x - o.x) * BigInt(b.y - o.y) - BigInt(a.y - o.y) * BigInt(b.x - o.x);
}

/** Four collinear points: do the spans overlap? */
function overlapOnLine(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  return Math.min(a.x, b.x) <= Math.max(c.x, d.x) && Math.min(c.x, d.x) <= Math.max(a.x, b.x)
    && Math.min(a.y, b.y) <= Math.max(c.y, d.y) && Math.min(c.y, d.y) <= Math.max(a.y, b.y);
}

export function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const [d1, d2, d3, d4] = [cross(c, d, a), cross(c, d, b), cross(a, b, c), cross(a, b, d)];
  return sign(d1) * sign(d2) <= 0 && sign(d3) * sign(d4) <= 0
    && (d1 !== 0n || d2 !== 0n || d3 !== 0n || d4 !== 0n || overlapOnLine(a, b, c, d));
}

/** Squared distance between two segments, 0 when they cross. */
export function segmentSegmentSq(a: Pt, b: Pt, c: Pt, d: Pt): number {
  if (segmentsCross(a, b, c, d)) return 0;
  return Math.min(pointSegmentSq(a, c, d), pointSegmentSq(b, c, d), pointSegmentSq(c, a, b), pointSegmentSq(d, a, b));
}

function ringEdges(ring: Pt[]): [Pt, Pt][] {
  return ring.map((a, i) => [a, ring[(i + 1) % ring.length]!]);
}

const polygonEdges = (polygon: Polygon): [Pt, Pt][] => [polygon.outline, ...polygon.holes].flatMap(ringEdges);

/** SHAPE_POLY_SET::Contains with accuracy 0: inside the outline and in no hole. */
export function polygonContains(polygon: Polygon, p: Pt): boolean {
  return ringContains(polygon.outline, p) && !polygon.holes.some(hole => ringContains(hole, p));
}

/** SHAPE_POLY_SET::Contains over a set. */
export const polygonsContain = (polygons: Polygon[], p: Pt): boolean => polygons.some(polygon => polygonContains(polygon, p));

/** Squared distance to the polygon, 0 inside it. */
function polygonDistanceSq(polygon: Polygon, p: Pt): number {
  if (polygonContains(polygon, p)) return 0;
  return Math.min(...polygonEdges(polygon).map(([a, b]) => pointSegmentSq(p, a, b)));
}

/** SHAPE_POLY_SET::Collide of a point with a clearance: inside, or closer than `clearance`. */
export function polygonNear(polygon: Polygon, p: Pt, clearance: number): boolean {
  const distance = polygonDistanceSq(polygon, p);
  return distance === 0 || distance < clearance ** 2;
}

/** SHAPE_POLY_SET::Collide of a segment with a clearance. */
export function polygonNearSegment(polygon: Polygon, a: Pt, b: Pt, clearance: number): boolean {
  if (polygonContains(polygon, a) && polygonContains(polygon, b)) return true;
  const distance = Math.min(...polygonEdges(polygon).map(([c, d]) => segmentSegmentSq(a, b, c, d)));
  return distance === 0 || distance < clearance ** 2;
}

/** Do the polygons share any area or touch? Outline crossings, or one inside the other. */
export function polygonsOverlap(a: Polygon, b: Polygon): boolean {
  const edges = polygonEdges(b);
  return polygonEdges(a).some(([p, q]) => edges.some(([r, s]) => segmentsCross(p, q, r, s)))
    || (b.outline[0] !== undefined && polygonContains(a, b.outline[0]))
    || (a.outline[0] !== undefined && polygonContains(b, a.outline[0]));
}

/** Chords of an arc track, no further than `error` from it. */
function arcChords(track: Track & { mid: Pt }, error: number): Pt[] {
  const { start, mid, end } = track;
  const centre = circleCentre(start, mid, end);
  const radius = Math.hypot(start.x - centre.x, start.y - centre.y);
  const startAngle = Math.atan2(start.y - centre.y, start.x - centre.x);
  const turn = (to: Pt): number => normalize180(angleOf(minus(to, centre)) - angleOf(minus(start, centre)));
  const sweep = (turn(mid) + normalize180(angleOf(minus(end, centre)) - angleOf(minus(mid, centre)))) * Math.PI / 180;
  const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (2 * Math.acos(Math.max(0, 1 - error / radius)))));
  return Array.from({ length: steps + 1 }, (_, i) => {
    const angle = startAngle + sweep * i / steps;
    return i === steps ? end : { x: Math.round(centre.x + radius * Math.cos(angle)), y: Math.round(centre.y + radius * Math.sin(angle)) };
  });
}

/** The centre line of a track: its two ends, or an arc cut into chords within `error`, as pcbnew's polygon of it was. */
export const trackLine = (track: Track, error = 1000): Pt[] => (track.mid ? arcChords({ ...track, mid: track.mid }, error) : [track.start, track.end]);

/** Does a track's copper reach into the polygon? */
export function polygonNearTrack(polygon: Polygon, track: Track, error = 1000): boolean {
  const half = Math.trunc(track.width / 2);
  const points = trackLine(track, error);
  return points.slice(1).some((point, i) => polygonNearSegment(polygon, points[i]!, point, half));
}

/** SHAPE_POLY_SET::Collide of a piece of copper. */
export function polygonCollides(polygon: Polygon, copper: PadCopper): boolean {
  if ('Circle' in copper) return polygonNear(polygon, copper.Circle.center, copper.Circle.radius);
  if ('Segment' in copper) {
    const { a, b, width } = copper.Segment;
    return polygonNearSegment(polygon, a, b, Math.trunc(width / 2));
  }
  return polygonsOverlap(polygon, { outline: copper.Polygon, holes: [] });
}

/** Is the point on a piece of copper, or within `accuracy` of it? */
export function copperContains(copper: PadCopper, p: Pt, accuracy = 0): boolean {
  if ('Circle' in copper) {
    const offset = minus(p, copper.Circle.center);
    return dot(offset, offset) <= (copper.Circle.radius + accuracy) ** 2;
  }
  if ('Segment' in copper) {
    const { a, b, width } = copper.Segment;
    return pointSegmentSq(p, a, b) <= (width / 2 + accuracy) ** 2;
  }
  return ringContains(copper.Polygon, p) || (accuracy > 1 && onRing(copper.Polygon, p, accuracy));
}

/** SHAPE_LINE_CHAIN_BASE::PointOnEdge: within accuracy + 1 of an edge. */
function onRing(ring: Pt[], p: Pt, accuracy: number): boolean {
  return ringEdges(ring).some(([a, b]) => pointSegmentSq(p, a, b) <= (accuracy + 1) ** 2);
}

/** SHAPE_POLY_SET::Contains with an accuracy: the margin grows the outline, not the holes. */
function polygonWithin(polygon: Polygon, p: Pt, accuracy: number): boolean {
  const inOutline = ringContains(polygon.outline, p) || (accuracy > 1 && onRing(polygon.outline, p, accuracy));
  return inOutline && !polygon.holes.some(hole => ringContains(hole, p));
}

/** A drill as PAD::GetEffectiveHoleShape: a round hole, or a slot along the longer side of an oval one, turned with the pad. */
function holeHit(pad: Pad, p: Pt, accuracy: number): boolean {
  const { x, y } = pad.drill;
  if (x <= 0 && y <= 0) return false;
  const half = Math.trunc(Math.min(x, y) / 2);
  const leg = rotated({ x: Math.trunc(x / 2) - half, y: Math.trunc(y / 2) - half }, pad.orientation);
  const a ={ x: pad.position.x - leg.x, y: pad.position.y - leg.y };
  const b = { x: pad.position.x + leg.x, y: pad.position.y + leg.y };
  const distance = pointSegmentSq(p, a, b);
  return distance === 0 || distance < (half + accuracy) ** 2;
}

/** PAD::HitTest: the effective shape, accuracy as a distance to its outline, or the hole. A pad that shares its uuid with another has no polygons in the document: then its copper. */
export function padHit(pad: Pad, p: Pt, accuracy = 0): boolean {
  const polygons = Object.values(pad.polygons);
  const copper = polygons.length > 0 ? polygons.some(polygon => polygonWithin(polygon, p, accuracy)) : pad.copper.some(piece => copperContains(piece, p, accuracy));
  return copper || holeHit(pad, p, accuracy);
}

/** GetEffectiveShape(layer)->Collide(SHAPE_CIRCLE): the pad's polygon on the layer, else its copper. */
export function padCollidesCircle(pad: Pad, layer: string, center: Pt, radius: number): boolean {
  const polygon = pad.polygons[layer];
  if (polygon) return polygonNear(polygon, center, radius);
  return pad.copper.some(piece => copperContains(piece, center, radius));
}

/** TestSegmentHit. */
function segmentHit(p: Pt, a: Pt, b: Pt, distance: number): boolean {
  return pointSegmentSq(p, a, b) < (distance + 1) ** 2;
}

/** The centre of the circle through three points, as CalcArcCenter for an arc that is not a line. */
function circleCentre(a: Pt, b: Pt, c: Pt): Pt {
  const ab = minus(b, a);
  const ac = minus(c, a);
  const d = 2 * (ab.x * ac.y - ab.y * ac.x);
  const abSq = dot(ab, ab);
  const acSq = dot(ac, ac);
  return { x: a.x + (ac.y * abSq - ab.y * acSq) / d, y: a.y + (ab.x * acSq - ac.x * abSq) / d };
}

const angleOf = (v: Pt): number => Math.atan2(v.y, v.x) * 180 / Math.PI;
/** EDA_ANGLE::Normalize180, into (-180, 180]: pcbnew's GetOrientationDegrees gives -90 where the document holds 270. */
export const normalize180 = (deg: number): number => { const d = ((deg % 360) + 360) % 360; return d > 180 ? d - 360 : d; };
const normalize360 = (deg: number): number => ((deg % 360) + 360) % 360;

/** PCB_ARC::HitTest. */
function arcHit(track: Track & { mid: Pt }, p: Pt, accuracy: number): boolean {
  const reach = accuracy + track.width / 2;
  const { start, mid, end } = track;
  if (Math.hypot(start.x - p.x, start.y - p.y) <= reach || Math.hypot(end.x - p.x, end.y - p.y) <= reach) return true;
  const centre = circleCentre(start, mid, end);
  const radius = Math.hypot(start.x - centre.x, start.y - centre.y);
  const relative = minus(p, centre);
  if (Math.abs(Math.trunc(Math.hypot(relative.x, relative.y)) - radius) > reach) return false;
  const startAngle = angleOf(minus(start, centre));
  const sweep = normalize180(angleOf(minus(mid, centre)) - startAngle) + normalize180(angleOf(minus(end, centre)) - angleOf(minus(mid, centre)));
  const hit = normalize360(angleOf(relative) - normalize360(startAngle));
  return sweep < 0 ? hit >= 360 + sweep : hit <= sweep;
}

/** PCB_TRACK::HitTest and PCB_ARC::HitTest: within width / 2 + accuracy of the centre line. */
export function trackHit(track: Track, p: Pt, accuracy = 0): boolean {
  if (track.mid) return arcHit({ ...track, mid: track.mid }, p, accuracy);
  return segmentHit(p, track.start, track.end, accuracy + Math.trunc(track.width / 2));
}

/** PCB_VIA::HitTest: within size / 2 + accuracy of the position. */
export function viaHit(via: Via, p: Pt, accuracy = 0): boolean {
  const offset = minus(p, via.at);
  return dot(offset, offset) <= (accuracy + Math.trunc(via.size / 2)) ** 2;
}
