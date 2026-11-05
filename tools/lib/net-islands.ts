// The copper islands of one net and the pad pairs that would join them, as KiCad's ratsnest shows them. The joins follow
// CN_VISITOR of connectivity_algo.cpp (KiCad 10): items on a common layer whose shapes collide; a zone island takes a track by an end
// inside it, a pad or via by its centre inside or its shape touching, and another island by a vertex inside its outline. Fills are
// the ones in the file. Graphics on copper are not read: the document gives them no net. Every via is taken as through.
import { polygonContains, polygonCollides, polygonNear, polygonNearSegment, polygonsOverlap, ringContains, trackLine, pointSegmentSq, segmentSegmentSq, copperContains, padHit } from './board-hit.ts';
import { mmPoint } from './board-obstacles.ts';
import { tracks, vias, type Board, type Pad, type PadCopper, type Polygon, type Pt, type Rect, type Track, type Via } from './board-types.ts';
import { UnionFind } from './copper-graph.ts';
import { dist } from './py-math.ts';
import type { Xy } from './route-spec.ts';

/** A pad of the net: `key` is its uuid, `name` REF.PAD. */
export interface NetPad { key: string; name: string; at: Xy; pad: Pad }
export type PadPair = [NetPad, NetPad];

type Item =
  | { kind: 'track'; track: Track; line: Pt[]; half: number; box: Rect }
  | { kind: 'via'; via: Via; radius: number; box: Rect }
  | { kind: 'pad'; pad: Pad; box: Rect }
  | { kind: 'island'; island: Polygon; layer: string; box: Rect };

const boxOf = (points: Pt[], margin = 0): Rect => ({
  left: Math.min(...points.map(p => p.x)) - margin, top: Math.min(...points.map(p => p.y)) - margin,
  right: Math.max(...points.map(p => p.x)) + margin, bottom: Math.max(...points.map(p => p.y)) + margin,
});
const boxesMeet = (a: Rect, b: Rect): boolean => a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom;

function padBox(pad: Pad): Rect {
  const rings = Object.values(pad.polygons).map(polygon => polygon.outline);
  if (rings.length) return boxOf(rings.flat());
  const reach = Math.max(pad.size.x, pad.size.y, pad.drill.x, pad.drill.y);
  return boxOf([pad.position], reach);
}

function netItems(board: Board, net: string): Item[] {
  const items: Item[] = [];
  for (const track of tracks(board).filter(item => item.net === net)) {
    const line = trackLine(track);
    const half = Math.trunc(track.width / 2);
    items.push({ kind: 'track', track, line, half, box: boxOf(line, half) });
  }
  for (const via of vias(board).filter(item => item.net === net)) {
    const radius = Math.trunc(via.size / 2);
    items.push({ kind: 'via', via, radius, box: boxOf([via.at], radius) });
  }
  for (const pad of board.footprints.flatMap(footprint => footprint.pads).filter(item => item.net === net)) items.push({ kind: 'pad', pad, box: padBox(pad) });
  for (const zone of board.zones.filter(item => !item.rule_area && item.net === net)) {
    for (const { layer, polygons } of zone.filled) {
      for (const island of polygons) items.push({ kind: 'island', island, layer, box: boxOf(island.outline) });
    }
  }
  return items;
}

function pieceNearSegment(piece: PadCopper, a: Pt, b: Pt, half: number): boolean {
  if ('Circle' in piece) return pointSegmentSq(piece.Circle.center, a, b) < (piece.Circle.radius + half) ** 2;
  if ('Segment' in piece) return segmentSegmentSq(piece.Segment.a, piece.Segment.b, a, b) < (piece.Segment.width / 2 + half) ** 2;
  return polygonNearSegment({ outline: piece.Polygon, holes: [] }, a, b, half);
}

const padNearSegment = (pad: Pad, layer: string, a: Pt, b: Pt, half: number): boolean => {
  const polygon = pad.polygons[layer];
  return polygon ? polygonNearSegment(polygon, a, b, half) : pad.copper.some(piece => pieceNearSegment(piece, a, b, half));
};

const padNearPoint = (pad: Pad, layer: string, p: Pt, radius: number): boolean => {
  const polygon = pad.polygons[layer];
  return polygon ? polygonNear(polygon, p, radius) : pad.copper.some(piece => copperContains(piece, p, radius));
};

const padsOverlap = (a: Pad, b: Pad): boolean => a.layers.some(layer => {
  if (!b.layers.includes(layer)) return false;
  const [first, second] = [a.polygons[layer], b.polygons[layer]];
  return first && second ? polygonsOverlap(first, second) : padHit(a, b.position) || padHit(b, a.position);
});

const segments = (line: Pt[]): [Pt, Pt][] => line.slice(1).map((point, i) => [line[i]!, point]);

function linesTouch(a: Item & { kind: 'track' }, b: Item & { kind: 'track' }): boolean {
  if (a.track.layer !== b.track.layer) return false;
  const reach = (a.half + b.half) ** 2;
  return segments(a.line).some(([p, q]) => segments(b.line).some(([r, s]) => segmentSegmentSq(p, q, r, s) < reach));
}

function islandTouches(island: Item & { kind: 'island' }, other: Item): boolean {
  const { island: polygon, layer } = island;
  if (other.kind === 'track') return other.track.layer === layer && [other.track.start, other.track.end].some(end => polygonContains(polygon, end));
  if (other.kind === 'via') return polygonContains(polygon, other.via.at) || polygonNear(polygon, other.via.at, other.radius);
  if (other.kind === 'pad') return other.pad.layers.includes(layer) && (polygonContains(polygon, other.pad.position) || other.pad.copper.some(piece => polygonCollides(polygon, piece)));
  return other.layer === layer && (polygon.outline.some(point => ringContains(other.island.outline, point)) || other.island.outline.some(point => ringContains(polygon.outline, point)));
}

function touches(a: Item, b: Item): boolean {
  if (a.kind === 'island') return islandTouches(a, b);
  if (b.kind === 'island') return islandTouches(b, a);
  if (a.kind === 'track' && b.kind === 'track') return linesTouch(a, b);
  if (a.kind === 'via' && b.kind === 'via') return dist([a.via.at.x, a.via.at.y], [b.via.at.x, b.via.at.y]) < a.radius + b.radius;
  if (a.kind === 'pad' && b.kind === 'pad') return padsOverlap(a.pad, b.pad);
  if (a.kind === 'track' && b.kind === 'via') return segments(a.line).some(([p, q]) => pointSegmentSq(b.via.at, p, q) < (a.half + b.radius) ** 2);
  if (a.kind === 'track' && b.kind === 'pad') return b.pad.layers.includes(a.track.layer) && segments(a.line).some(([p, q]) => padNearSegment(b.pad, a.track.layer, p, q, a.half));
  if (a.kind === 'via' && b.kind === 'pad') return b.pad.layers.some(layer => padNearPoint(b.pad, layer, a.via.at, a.radius));
  return touches(b, a);
}

/** The island of each pad of the net, by pad uuid. */
function padIslands(board: Board, net: string): Map<string, number> {
  const items = netItems(board, net);
  const joined = new UnionFind();
  items.forEach((a, i) => {
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j]!;
      if (boxesMeet(a.box, b.box) && joined.find(i) !== joined.find(j) && touches(a, b)) joined.union(i, j);
    }
  });
  return new Map(items.flatMap((item, i): [string, number][] => (item.kind === 'pad' ? [[item.pad.id, joined.find(i)]] : [])));
}

const textOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const listOrder = (a: string[], b: string[]): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return textOrder(a[i]!, b[i]!);
  return a.length - b.length;
};

/** Ratsnest: joins the islands by the nearest pad pairs (Prim). Ties go to the lowest name, then the lowest island. */
export function mstPairs(islands: [name: string, at: Xy][][]): [string, string][] {
  const done = new Set([0]);
  const pairs: [string, string][] = [];
  while (done.size < islands.length) {
    let best: { distance: number; from: string; island: number; to: string } | null = null;
    for (const i of done) {
      for (const [from, a] of islands[i]!) {
        islands.forEach((island, j) => {
          if (done.has(j)) return;
          for (const [to, b] of island) {
            const distance = dist(a, b);
            if (!best || distance < best.distance || (distance === best.distance && (from < best.from || (from === best.from && (j < best.island || (j === best.island && to < best.to)))))) {
              best = { distance, from, island: j, to };
            }
          }
        });
      }
    }
    const { from, island, to } = best!;
    done.add(island);
    pairs.push([from, to]);
  }
  return pairs;
}

/** The numbered pads of a net by uuid, a shared uuid once: the last pad, in the place of the first. */
function netPads(board: Board, net: string): Map<string, NetPad> {
  return new Map(board.footprints.flatMap(footprint => footprint.pads.filter(pad => pad.net === net && pad.number)
    .map((pad): [string, NetPad] => [pad.id, { key: pad.id, name: `${footprint.reference}.${pad.number}`, at: mmPoint(pad.position), pad }])));
}

/** The pad pairs of a net that are not joined yet, nearest first as the ratsnest finds them. */
export function netPadPairs(board: Board, net: string): PadPair[] {
  const pads = netPads(board, net);
  const islands = padIslands(board, net);
  const groups = new Map<number, NetPad[]>();
  for (const pad of pads.values()) {
    const island = islands.get(pad.key)!;
    groups.set(island, [...(groups.get(island) ?? []), pad]);
  }
  const ordered = [...groups.values()].map(group => ({ group, names: group.map(pad => pad.name).sort(textOrder) })).sort((a, b) => listOrder(a.names, b.names));
  return mstPairs(ordered.map(({ group }) => group.map((pad): [string, Xy] => [pad.key, pad.at]))).map(([a, b]) => [pads.get(a)!, pads.get(b)!]);
}
