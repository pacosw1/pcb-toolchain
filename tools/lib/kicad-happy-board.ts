// Corrections to the analyze_pcb JSON before analyze_emc reads it, for what kicad-happy a6bba1a gets wrong.
//
// The document is the tree of jsonLoads (dict = Map, int = BigInt, float = Float), not JSON.parse: it goes back to
// kicad-happy, and JSON.parse would turn 1.0 into 1 and move integer-like keys. Pads and samples are only read.
import type { Finding } from './kicad-happy-findings.ts';
import { readJson } from './json-file.ts';
import { Float, number, pyRepr, pyStr, readText } from './py-compat.mjs';
import { round } from './py-numbers.ts';

export type Tree = Map<string, unknown>;
type Xy = readonly [number, number];

export interface Pad {
  type?: string;
  shape?: string;
  abs_x: number;
  abs_y: number;
  angle?: number;
  width?: number;
  height?: number;
  net_name?: string;
  net?: string;
}
export interface Sample { net?: string; hit?: boolean; x: number; y: number }
/** A net whose reference plane coverage changed: percentages as kicad-happy and this credit give them. */
export interface Credit { net: string; old: unknown; pct: number }

const STITCH_RADIUS_MM = 1.0; // the kicad-happy radius for dielectrics up to 0.5 mm
const MIN_RETURN_RADIUS_MM = 1.0;
const FULL_COVERAGE_PCT = 95;
const DEFAULT_ZONE_CLEARANCE_MM = 0.2;
const CLEARANCE_SLACK_MM = 1e-9;
const THROUGH_HOLE = ['thru_hole', 'through_hole', 'pth'];

/** A jsonLoads value for reading only: dict to object, int and float to number. NaN stays, which JSON.parse would refuse. */
export function plainJson(value: unknown): unknown {
  if (value instanceof Float) return value.value;
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(plainJson);
  if (value instanceof Map) return Object.fromEntries([...value].map(([key, item]) => [key, plainJson(item)]));
  return value;
}

const dict = (value: unknown): Tree => (value instanceof Map ? value : new Map<string, unknown>());
const trees = (value: unknown): Tree[] => (Array.isArray(value) ? value as Tree[] : []);
const numeric = (value: unknown): number => (value === undefined || value === null ? 0 : number(value));
const vias = (doc: Tree) => trees(dict(doc.get('vias')).get('vias'));
const transitions = (doc: Tree) => trees(doc.get('layer_transitions'));
const positionOf = (tree: Tree): Xy => [numeric(tree.get('x')), numeric(tree.get('y'))];
const near = (a: Xy, b: Xy, radius: number) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= radius;
const isGround = (name: string) => name.toUpperCase().endsWith('GND') || name.toUpperCase() === '0V';

function netNames(doc: Tree): Map<string, string> {
  return new Map([...dict(doc.get('nets'))].map(([id, name]) => [id, String(name)]));
}

const viaNet = (via: Tree, names: Map<string, string>) =>
  (via.get('net_name') as string | undefined) || names.get(pyStr(via.get('net') ?? null)) || '';

/**
 * kicad-happy a6bba1a finds ground vias by net name only (GND, *GND, 0V), so RP-001 misses a domain ground such as
 * FIELD_0V. A name in grounds that is not a board net is an error.
 */
export function markGroundVias(doc: Tree, grounds: string[]): void {
  const names = netNames(doc);
  const known = new Set(names.values());
  const missing = [...new Set(grounds)].filter(ground => !known.has(ground)).sort();
  if (missing.length) throw new Error(`--ground: no such net on the board: ${pyRepr(missing)}`);
  for (const via of vias(doc)) {
    if (grounds.includes(names.get(pyStr(via.get('net') ?? null)) ?? '')) via.set('net_name', 'GND');
  }
}

/**
 * kicad-happy a6bba1a stops RP-001 after 20 nets, so a board with more flagged nets hides the rest. For each exempt net
 * with a via that has no ground via within 1.0 mm, the transition is removed and an RP-001 finding is returned for it,
 * so the exemption still matches. A stitched exempt net stays in the input: its exemption goes stale.
 */
export function takeExemptTransitions(doc: Tree, nets: Set<string>): Finding[] {
  if (!nets.size) return [];
  const names = netNames(doc);
  const grounds = vias(doc).filter(via => isGround(viaNet(via, names))).map(positionOf);
  const found: Finding[] = [];
  const keep = transitions(doc).filter(transition => {
    const net = transition.get('net') as string;
    const open = trees(transition.get('via_positions')).some(via => !grounds.some(ground => near(positionOf(via), ground, STITCH_RADIUS_MM)));
    if (!nets.has(net) || !open) return true;
    found.push({ rule_id: 'RP-001', severity: 'warning', nets: [net],
      title: `Missing stitching via at layer transition: ${net} (checked by the gate)` });
    return false;
  });
  doc.set('layer_transitions', keep);
  return found;
}

function returnPlanes(planesPath: string): [string, string] | null {
  try {
    const { adjacent } = readJson<{ adjacent: Record<string, string> }>(planesPath);
    const planes = [...new Set(Object.values(adjacent))].sort();
    return planes.length === 2 ? [planes[0]!, planes[1]!] : null;
  } catch {
    return null;
  }
}

/**
 * RP-001 radius from the rule's own formula, max(2 x dielectric height, 1.0 mm) (kicad-happy references/pcb-emc-rules.md
 * RP-001: Ott, "PCB Stack-Up Part 6"; Sierra Circuits return path guide), with h the dielectric the return current
 * crosses: between the reference planes of the two signal layers (reference-planes.json 'adjacent', e.g. F.Cu -> In1.Cu
 * and B.Cu -> In2.Cu: the In1-In2 core). kicad-happy a6bba1a takes the first dielectric of the stackup instead. Null when
 * the spec or the stackup does not say.
 */
export function returnRadius(pcbPath: string, planesPath: string): number | null {
  const planes = returnPlanes(planesPath);
  if (!planes) return null;
  const stackup = /\(stackup(.*?)\(copper_finish/s.exec(readText(pcbPath));
  if (!stackup) return null;
  const layers = [...stackup[1]!.matchAll(/\(layer "([^"]+)"(.*?)(?=\(layer "|$)/gs)].map(match => ({ name: match[1]!, body: match[2]! }));
  const [first, second] = planes.map(plane => layers.findIndex(layer => layer.name === plane)).sort((a, b) => a - b) as [number, number];
  if (first < 0) return null;
  let height = 0;
  for (const { name, body } of layers.slice(first + 1, second)) {
    const thickness = /\(thickness ([0-9.]+)/.exec(body);
    if (name.includes('dielectric') && thickness) height += Number(thickness[1]);
  }
  return height > 0 ? Math.max(2 * height, MIN_RETURN_RADIUS_MM) : null;
}

/**
 * Drops the layer transitions whose every via has a ground via or a ground through-hole pad (it joins the planes as a
 * via does) within radius; the analyzer then flags only the rest. Returns the number dropped.
 */
export function takeReturnStitched(doc: Tree, radius: number, pads: Pad[]): number {
  const names = netNames(doc);
  const grounds: Xy[] = [
    ...vias(doc).filter(via => isGround(viaNet(via, names))).map(positionOf),
    ...pads.filter(pad => THROUGH_HOLE.includes(pad.type ?? '') && isGround(String(pad.net_name || pad.net || '')))
      .map(pad => [pad.abs_x, pad.abs_y] as const),
  ];
  const keep = transitions(doc).filter(transition => {
    const stitched = trees(transition.get('via_positions'));
    return !stitched.length || !stitched.every(via => grounds.some(ground => near(positionOf(via), ground, radius)));
  });
  const dropped = transitions(doc).length - keep.length;
  doc.set('layer_transitions', keep);
  return dropped;
}

/** Distance from (x, y) to the copper of a pad: circle, oval (capsule) or rectangle. */
export function padDistance(pad: Pad, x: number, y: number): number {
  const angle = (pad.angle || 0) * (Math.PI / 180);
  const dx = x - pad.abs_x;
  const dy = y - pad.abs_y;
  const localX = dx * Math.cos(angle) - dy * Math.sin(angle);
  const localY = dx * Math.sin(angle) + dy * Math.cos(angle);
  const halfWidth = (pad.width ?? 0) / 2;
  const halfHeight = (pad.height ?? 0) / 2;
  if (pad.shape === 'circle' || pad.shape === 'oval') {
    const radius = Math.min(halfWidth, halfHeight);
    return Math.hypot(Math.max(Math.abs(localX) - (halfWidth - radius), 0), Math.max(Math.abs(localY) - (halfHeight - radius), 0)) - radius;
  }
  return Math.hypot(Math.max(Math.abs(localX) - halfWidth, 0), Math.max(Math.abs(localY) - halfHeight, 0));
}

/** Through-hole pads and vias of each net, the copper a plane keeps its antipad around. */
function holesByNet(doc: Tree, pads: Pad[]): Map<string, Pad[]> {
  const names = netNames(doc);
  const holes = new Map<string, Pad[]>();
  const add = (net: string, hole: Pad) => holes.set(net, [...holes.get(net) ?? [], hole]);
  for (const pad of pads) if (pad.type === 'thru_hole' && pad.net_name) add(pad.net_name, pad);
  for (const via of vias(doc)) {
    const size = numeric(via.get('size'));
    add(viaNet(via, names), { shape: 'circle', abs_x: number(via.get('x')), abs_y: number(via.get('y')), width: size, height: size });
  }
  return holes;
}

/** The net's clearance: the largest zone clearance or its net class clearance, whichever is larger. */
function clearanceFor(doc: Tree): (net: string) => number {
  const zone = Math.max(...trees(doc.get('zones')).map(item => numeric(item.get('clearance'))), DEFAULT_ZONE_CLEARANCE_MM);
  const byClass = new Map<string, number>();
  let fallback = 0;
  for (const netClass of trees(doc.get('net_classes'))) {
    const clearance = numeric(netClass.get('clearance'));
    if (netClass.get('name') === 'Default') fallback = clearance;
    for (const net of (netClass.get('nets') ?? []) as string[]) byClass.set(net, clearance);
  }
  return net => Math.max(zone, byClass.get(net) ?? fallback);
}

/**
 * GP-001: counts a missed sample inside the antipad of its own net's hole as covered. kicad-happy a6bba1a credits the
 * antipad of a via (KH-392) but not of a through-hole pad, so a track that ends in its own TH pad (a battery clip, a
 * connector pin) reads as a plane gap. A miss at the hole of another net or in a plane void stays a gap. samples are the
 * analyze_pcb --gp001-debug samples. return_path_continuity is updated in place, an entry going at 95 % or more, as in
 * kicad-happy.
 */
export function creditOwnHoles(doc: Tree, samples: Sample[], pads: Pad[]): Credit[] {
  const holes = holesByNet(doc, pads);
  const clearance = clearanceFor(doc);
  const credits: Credit[] = [];
  const keep = trees(doc.get('return_path_continuity')).filter(entry => {
    const net = entry.get('net') as string;
    const own = samples.filter(sample => sample.net === net);
    const reach = clearance(net) + CLEARANCE_SLACK_MM;
    const gaps = own.filter(sample => !sample.hit
      && !(holes.get(net) ?? []).some(hole => padDistance(hole, sample.x, sample.y) <= reach));
    if (!own.length || gaps.length === own.length - numeric(entry.get('samples_with_reference_plane'))) return true;
    const pct = round((1 - gaps.length / own.length) * 100, 1);
    credits.push({ net, old: entry.get('reference_plane_coverage_pct'), pct });
    if (pct >= FULL_COVERAGE_PCT) return false;
    entry.set('samples_with_reference_plane', own.length - gaps.length);
    entry.set('reference_plane_coverage_pct', new Float(pct));
    return true;
  });
  doc.set('return_path_continuity', keep);
  return credits;
}
