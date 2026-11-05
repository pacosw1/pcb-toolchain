// The copper of one net as a graph of current capacities, and the current between two pads (pcbtool paths).
// Nodes are strings: nodeId for a track end, `p|REF.PAD` for a pad, `z|...` for a zone island, `v|...` for a via group.
import { fromMm, padHit, polygonCollides, polygonContains, trackHit, viaHit } from './board-hit.ts';
import { toMm, tracks, vias, type Board, type Footprint, type Pad, type PadCopper, type Polygon, type Pt, type Track, type Via, type Zone } from './board-types.ts';
import {
  chainEndEvidence, DEFAULT_COPPER_MM, ipcAmps, neckChains, nodeId, pinEscape, THERMAL_SPOKES, trackAmps, viaGroupAmps, type Evidence, type Piece, type Xy,
} from './copper-current.ts';
import { MinHeap } from './min-heap.ts';
import { footprintPinRating, type PinCurrent, type PinRatings } from './pin-ratings.ts';
import { fixed, floatRepr, sorted } from './py-compat.mjs';
import { dist } from './py-math.ts';
import { round } from './py-numbers.ts';

export interface Edge { u: string; v: string; amps: number; label: string }
export interface NetGraph { edges: Edge[]; pads: Set<string> }
export interface Conditions { thickness: ReadonlyMap<string, number>; rise: number; plating: number; ratings: PinRatings }

export const padNode = (label: string): string => `p|${label}`;
const mmPoint = (p: Pt): Xy => [round(toMm(p.x), 3), round(toMm(p.y), 3)];
const boardPoint = (point: Xy): Pt => ({ x: fromMm(point[0]), y: fromMm(point[1]) });
const pointText = (point: Xy): string => `(${floatRepr(point[0])}, ${floatRepr(point[1])})`;
const samePoint = (a: Xy, b: Xy): boolean => a[0] === b[0] && a[1] === b[1];

/** The point of segment a-c nearest to q, clamped to the segment, rounded to 1 um. */
export function project(a: Xy, c: Xy, q: Xy): Xy {
  const dx = c[0] - a[0];
  const dy = c[1] - a[1];
  const t = Math.min(1, Math.max(0, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / ((dx * dx + dy * dy) || 1)));
  return [round(a[0] + t * dx, 3), round(a[1] + t * dy, 3)];
}

/** One item per exact geometry, never per UUID: the first position, the lowest rank. */
function physicalConductors<T>(items: T[], identity: (item: T) => string, rank: (item: T) => number): T[] {
  const unique = new Map<string, T>();
  for (const item of items) {
    const key = identity(item);
    const held = unique.get(key);
    if (held === undefined || rank(item) < rank(held)) unique.set(key, item);
  }
  return [...unique.values()];
}

function trackShape(t: Track): string {
  const ends = [t.start, t.end].sort((a, b) => a.x - b.x || a.y - b.y);
  return JSON.stringify([t.mid !== null, t.layer, ends, t.mid]);
}

interface NetPad { label: string; pad: Pad; footprint: Footprint }

function netPads(board: Board, net: string): NetPad[] {
  return board.footprints.flatMap(footprint => footprint.pads.filter(pad => pad.number && pad.net === net)
    .map(pad => ({ label: `${footprint.reference}.${pad.number}`, pad, footprint })));
}

/** The pad of each label, the last of pads that share one. */
const padsByLabel = (pads: NetPad[]): Map<string, NetPad> => new Map(pads.map(item => [item.label, item]));

/** A track with where it is cut: another end on it (a T junction), or a pad or via it passes through. */
function trackCuts(t: Track, ends: [string, Xy][], pads: NetPad[], throughVias: Via[]): Xy[] {
  const [a, c] = [mmPoint(t.start), mmPoint(t.end)];
  const cuts = new Map<string, Xy>();
  const add = (point: Xy): void => { cuts.set(`${point[0]},${point[1]}`, point); };
  for (const [layer, end] of ends) {
    if (layer === t.layer && !samePoint(end, a) && !samePoint(end, c) && trackHit(t, boardPoint(end))) add(end);
  }
  const passing: [Pt, (p: Pt) => boolean][] = [
    ...pads.filter(({ pad }) => pad.layers.includes(t.layer)).map(({ pad }): [Pt, (p: Pt) => boolean] => [pad.position, p => padHit(pad, p)]),
    ...throughVias.map((via): [Pt, (p: Pt) => boolean] => [via.at, p => viaHit(via, p)]),
  ];
  for (const [position, hit] of passing) {
    const q = project(a, c, mmPoint(position));
    if (!samePoint(q, a) && !samePoint(q, c) && hit(boardPoint(q))) add(q);
  }
  return [...cuts.values()].sort((p, q) => dist(a, p) - dist(a, q));
}

/** What the graph builder gathers on its way. */
interface Build {
  edges: Edge[]; stops: Set<string>; evidence: Map<string, Evidence[]>; padNodes: Map<string, string[]>; links: Set<string>[]; onPlane: Set<string>;
}

function addEvidence(build: Build, node: string, item: Evidence): void {
  build.evidence.set(node, [...(build.evidence.get(node) ?? []), item]);
}

/** The piece of a cut track with the whole track it came from: a pin escape measures that. */
interface CutPiece extends Piece { whole: readonly [Xy, Xy] }

function cutTracks(segments: Track[], pads: NetPad[], throughVias: Via[], thickness: ReadonlyMap<string, number>): { pieces: CutPiece[]; nodes: Map<string, [string, Xy]> } {
  const ends = segments.flatMap((t): [string, Xy][] => [[t.layer, mmPoint(t.start)], [t.layer, mmPoint(t.end)]]);
  const nodes = new Map<string, [string, Xy]>(ends.map(([layer, point]) => [nodeId(layer, point), [layer, point]]));
  const pieces: CutPiece[] = [];
  for (const t of segments) {
    const [a, c] = [mmPoint(t.start), mmPoint(t.end)];
    const cuts = trackCuts(t, ends, pads, throughVias);
    for (const cut of cuts) nodes.set(nodeId(t.layer, cut), [t.layer, cut]);
    const chain = [a, ...cuts, c];
    chain.slice(1).forEach((v, i) => {
      if (!samePoint(chain[i]!, v)) {
        pieces.push({ group: t.layer, u: chain[i]!, v, width: round(toMm(t.width), 3), thickness: thickness.get(t.layer) ?? DEFAULT_COPPER_MM, whole: [a, c] });
      }
    });
  }
  return { pieces, nodes };
}

function joinPads(build: Build, pads: Map<string, NetPad>, nodes: Map<string, [string, Xy]>): void {
  for (const [label, { pad }] of pads) {
    for (const [node, [layer, point]] of nodes) {
      if (pad.layers.includes(layer) && padHit(pad, boardPoint(point))) {
        build.edges.push({ u: padNode(label), v: node, amps: Infinity, label: 'pad' });
        build.stops.add(node);
        addEvidence(build, node, { kind: 'pad' });
        build.padNodes.set(label, [...(build.padNodes.get(label) ?? []), node]);
      }
    }
  }
}

function joinVias(build: Build, throughVias: Via[], pads: Map<string, NetPad>, nodes: Map<string, [string, Xy]>, copperLayers: string[]): void {
  throughVias.forEach((via, i) => {
    for (const [node, [, point]] of nodes) {
      if (viaHit(via, boardPoint(point))) { build.links[i]!.add(node); build.stops.add(node); }
    }
    for (const [label, { pad }] of pads) {
      if (copperLayers.some(layer => pad.layers.includes(layer)) && padHit(pad, via.at)) build.links[i]!.add(padNode(label));
    }
  });
}

/** Does the pad join this zone solidly? A thermal is the other answer. */
function solidJoin(pad: Pad, zone: Zone): boolean {
  const connection = pad.zone_connection ?? zone.fill?.pad_connection;
  return connection === 'Full' || (connection === 'ThtThermal' && pad.kind === 'Smd');
}

function joinIsland(build: Build, island: Polygon, id: string, zone: Zone, layer: string, context: { pads: Map<string, NetPad>; nodes: Map<string, [string, Xy]>; throughVias: Via[]; conditions: Conditions }): void {
  const { pads, nodes, throughVias, conditions } = context;
  for (const [node, [nodeLayer, point]] of nodes) {
    if (nodeLayer === layer && polygonContains(island, boardPoint(point))) {
      build.edges.push({ u: id, v: node, amps: Infinity, label: 'zone' });
      build.stops.add(node);
      addEvidence(build, node, { kind: 'plane' });
    }
  }
  const spoke = round(toMm(zone.fill?.spoke_width ?? 0), 3);
  for (const [label, { pad }] of pads) {
    if (!pad.layers.includes(layer) || !pad.copper.some(piece => polygonCollides(island, piece))) continue;
    const solid = solidJoin(pad, zone);
    if (solid) build.onPlane.add(label);
    build.edges.push({
      u: id, v: padNode(label), amps: solid ? Infinity : THERMAL_SPOKES * ipcAmps(spoke, conditions.thickness.get(layer) ?? DEFAULT_COPPER_MM, conditions.rise),
      label: `zone ${layer} ${solid ? 'solid' : `thermal ${THERMAL_SPOKES} x ${floatRepr(spoke)} mm spokes to ${label}`}`,
    });
  }
  throughVias.forEach((via, i) => {
    const barrel: PadCopper = { Circle: { center: via.at, radius: Math.trunc(via.size / 2) } };
    if (polygonCollides(island, barrel)) build.links[i]!.add(id);
  });
}

/** Vias that join the same copper are in parallel: their barrel areas add. */
function addViaEdges(build: Build, throughVias: Via[], conditions: Conditions): void {
  const groups = new Map<string, number[]>();
  build.links.forEach((ends, i) => {
    if (ends.size === 0) return;
    const key = [...ends].sort().join('\n');
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  for (const group of groups.values()) {
    const first = group[0]!;
    const drills = group.map(i => toMm(throughVias[i]!.drill));
    const amps = viaGroupAmps(drills, conditions.plating, conditions.rise);
    const at = pointText(mmPoint(throughVias[first]!.at));
    const label = group.length === 1 ? `via drill ${fixed(drills[0]!, 2)} at ${at}`
      : `${group.length} vias in parallel (drill ${fixed(Math.min(...drills), 2)}-${fixed(Math.max(...drills), 2)}) at ${at}`;
    for (const end of build.links[first]!) build.edges.push({ u: `v|${first}`, v: end, amps, label });
  }
}

/** A via that joins a same-net zone is a plane end, and so are the nodes of a pad solidly on one. */
function planeEvidence(build: Build): void {
  for (const ends of build.links) {
    if (![...ends].some(end => end.startsWith('z|'))) continue;
    for (const end of ends) if (end.startsWith('n|')) addEvidence(build, end, { kind: 'plane' });
  }
  for (const label of build.onPlane) for (const node of build.padNodes.get(label) ?? []) addEvidence(build, node, { kind: 'plane' });
}

interface RatedPad extends NetPad { rating: PinCurrent }

/** The capacity and label of a piece: IPC, a neck with end evidence, or the pin rating of a pad it escapes from. */
function pieceEdge(piece: CutPiece, amps: number, neckMm: number, neck: boolean, rated: RatedPad[], padNodes: Map<string, string[]>): Edge {
  const name = `${piece.group} ${floatRepr(piece.width)} mm ${pointText(piece.u)}-${pointText(piece.v)}`;
  let best = amps;
  let label = name + (neck ? ` (neck ${fixed(neckMm, 2)} mm, end evidence)` : '');
  const [a, c] = piece.whole;
  for (const { label: pad, pad: { size }, rating } of rated) {
    const nodes = padNodes.get(pad) ?? [];
    if (rating.amps === null || !(nodes.includes(nodeId(piece.group, a)) || nodes.includes(nodeId(piece.group, c)))) continue;
    const [minor, major] = [toMm(Math.min(size.x, size.y)), toMm(Math.max(size.x, size.y))];
    if (pinEscape(dist(a, c), piece.width, minor, major, rating.amps, 0) && rating.amps > best) {
      best = rating.amps;
      label = `${name} (pin escape of ${pad}: ${rating.source})`;
    }
  }
  return { u: nodeId(piece.group, piece.u), v: nodeId(piece.group, piece.v), amps: best, label };
}

/**
 * The physical copper of a net, with D-124c end-evidence necks and rated pin escapes. Coincident conductors count once. A via
 * is taken as through: the document holds no layer span, so a blind or buried via would join every layer here.
 */
export function netGraph(board: Board, net: string, conditions: Conditions): NetGraph {
  const onNet = <T extends { net: string }>(items: T[]): T[] => items.filter(item => item.net === net);
  const segments = physicalConductors(onNet(tracks(board)), trackShape, t => -t.width);
  const throughVias = physicalConductors(onNet(vias(board)), v => `${v.at.x},${v.at.y}`, v => v.drill);
  const allPads = netPads(board, net);
  const pads = padsByLabel(allPads);
  const { pieces, nodes } = cutTracks(segments, allPads, throughVias, conditions.thickness);
  const build: Build = { edges: [], stops: new Set(), evidence: new Map(), padNodes: new Map(), links: throughVias.map(() => new Set()), onPlane: new Set() };
  joinPads(build, pads, nodes);
  joinVias(build, throughVias, pads, nodes, board.copper_layers);
  board.zones.forEach((zone, z) => {
    if (zone.rule_area !== null || zone.net !== net) return;
    for (const layer of zone.layers) {
      (zone.filled.find(fill => fill.layer === layer)?.polygons ?? []).forEach((island, k) => {
        joinIsland(build, island, `z|${z}|${layer}|${k}`, zone, layer, { pads, nodes, throughVias, conditions });
      });
    }
  });
  addViaEdges(build, throughVias, conditions);
  planeEvidence(build);
  const chains = neckChains(pieces, build.stops);
  const ends = chainEndEvidence(pieces, chains, build.evidence);
  const rated = [...pads.values()].map(item => ({ ...item, rating: footprintPinRating(conditions.ratings, item.footprint, item.pad.number) }));
  pieces.forEach((piece, i) => {
    const amps = trackAmps(piece.width, piece.thickness, conditions.rise, chains[i]!, ends[i]);
    const neck = amps > ipcAmps(piece.width, piece.thickness, conditions.rise) + 1e-12;
    build.edges.push(pieceEdge(piece, amps, chains[i]!.length, neck, rated, build.padNodes));
  });
  return { edges: build.edges, pads: new Set(pads.keys()) };
}

/** The path from a to b with the highest bottleneck current. Parallel paths do not add (conservative). */
export function widestPath(edges: readonly Edge[], a: string, b: string): { amps: number; items: string[] } {
  const adjacent = new Map<string, { to: string; amps: number; label: string }[]>();
  const link = (from: string, to: string, amps: number, label: string): void => { adjacent.set(from, [...(adjacent.get(from) ?? []), { to, amps, label }]); };
  for (const { u, v, amps, label } of edges) { link(u, v, amps, label); link(v, u, amps, label); }
  const best = new Map([[a, Infinity]]);
  const previous = new Map<string, { from: string; label: string }>();
  const heap = new MinHeap<{ capacity: number; order: number; node: string }>((x, y) => x.capacity > y.capacity || (x.capacity === y.capacity && x.order < y.order));
  heap.push({ capacity: Infinity, order: 0, node: a });
  let order = 0;
  while (heap.size) {
    const { capacity, node } = heap.pop()!;
    if (capacity < (best.get(node) ?? -1)) continue;
    if (node === b) {
      const items: string[] = [];
      for (let at = node; at !== a;) { const step = previous.get(at)!; items.push(step.label); at = step.from; }
      return { amps: capacity, items: items.reverse() };
    }
    for (const { to, amps, label } of adjacent.get(node) ?? []) {
      const through = Math.min(capacity, amps);
      if (through > (best.get(to) ?? -1)) {
        best.set(to, through);
        previous.set(to, { from: node, label });
        order += 1;
        heap.push({ capacity: through, order, node: to });
      }
    }
  }
  return { amps: 0, items: [] };
}

function reach(adjacent: ReadonlyMap<string, Set<string>>, start: string, open: (u: string, v: string) => boolean): Set<string> {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const u = stack.pop()!;
    for (const v of adjacent.get(u) ?? []) {
      if (!seen.has(v) && open(u, v)) { seen.add(v); stack.push(v); }
    }
  }
  return seen;
}

const arc = (u: string, v: string): string => `${u}\n${v}`;
const pairKey = (u: string, v: string): string => (u < v ? arc(u, v) : arc(v, u));

/** One breadth-first augmenting path from a to b, or null. */
function augmentingPath(adjacent: ReadonlyMap<string, Set<string>>, capacity: ReadonlyMap<string, number>, a: string, b: string): [string, string][] | null {
  const previous = new Map<string, string | null>([[a, null]]);
  const queue = [a];
  for (let head = 0; head < queue.length && !previous.has(b); head += 1) {
    const u = queue[head]!;
    for (const v of adjacent.get(u)!) {
      if (!previous.has(v) && capacity.get(arc(u, v))! > 1e-12) { previous.set(v, u); queue.push(v); }
    }
  }
  if (!previous.has(b)) return null;
  const path: [string, string][] = [];
  for (let v = b; previous.get(v) !== null;) { const u = previous.get(v)!; path.push([u, v]); v = u; }
  return path;
}

/** The current from a to b with parallel paths added (Edmonds-Karp), and the labels of the min cut. A path of only unlimited edges gives Infinity and no items. */
export function maxFlow(edges: readonly Edge[], a: string, b: string): { amps: number; items: string[] } {
  const adjacent = new Map<string, Set<string>>();
  const link = (u: string, v: string): void => { adjacent.set(u, (adjacent.get(u) ?? new Set()).add(v)); };
  for (const { u, v } of edges) { link(u, v); link(v, u); }
  if (!adjacent.has(a) || !adjacent.has(b)) return { amps: 0, items: [] };
  const unlimited = new Set(edges.filter(e => e.amps === Infinity).map(e => pairKey(e.u, e.v)));
  if (reach(adjacent, a, (u, v) => unlimited.has(pairKey(u, v))).has(b)) return { amps: Infinity, items: [] };
  const big = edges.filter(e => e.amps !== Infinity).reduce((sum, e) => sum + e.amps, 0) + 1;
  const capacity = new Map<string, number>();
  const raise = (key: string, by: number): void => { capacity.set(key, (capacity.get(key) ?? 0) + by); };
  for (const { u, v, amps } of edges) {
    const limit = amps === Infinity ? big : amps;
    raise(arc(u, v), limit);
    raise(arc(v, u), limit);
  }
  let total = 0;
  for (let path = augmentingPath(adjacent, capacity, a, b); path; path = augmentingPath(adjacent, capacity, a, b)) {
    const push = Math.min(...path.map(([u, v]) => capacity.get(arc(u, v))!));
    for (const [u, v] of path) { raise(arc(u, v), -push); raise(arc(v, u), push); }
    total += push;
  }
  const side = reach(adjacent, a, (u, v) => capacity.get(arc(u, v))! > 1e-12);
  const cut = new Set(edges.filter(e => side.has(e.u) !== side.has(e.v)).map(e => e.label));
  return { amps: round(total, 9), items: sorted(cut) as string[] };
}

/** Max flow and min cut when parallel, else the widest single path and its items. */
export const pairCapacity = (edges: readonly Edge[], a: string, b: string, parallel: boolean): { amps: number; items: string[] } =>
  (parallel ? maxFlow(edges, a, b) : widestPath(edges, a, b));
