// Exact local routing patterns over the shared KiCad API board types. Reads never parse board text.
import { createHash } from 'node:crypto';
import { Decimal } from './decimal.ts';
import { fingerprint } from './fingerprint.ts';
import { NM_PER_MM, tracks, vias } from './board-types.ts';
import type { Board, Pt, Track, Via } from './board-types.ts';
import type { DrcReport } from './route-decision-evidence.ts';

export type Point = readonly [number, number];
export interface GapChoice {
  strategy: 'straight_gap_bridge'; native_open_index: number; net: string; layer: string; width_mm: string;
  endpoint_ids: [string, string]; points_mm: [string[], string[]];
}
export interface ViaChoice {
  strategy: 'via_shift_bridge'; net: string; via_id: string; along_trace_id: string; fraction: number;
  conflict_error_indices: number[]; pad_ids: string[]; destination_mm: string[]; bridge_length_mm: number;
}
export type Choice = GapChoice | ViaChoice;
export interface RejectedGap { native_open_index: number; cause: string }
const point = (p: Pt): Point => [p.x, p.y];
const equal = (a: Point, b: Point): boolean => a[0] === b[0] && a[1] === b[1];
const big = (n: number): bigint => { if (!Number.isSafeInteger(n)) throw new Error('native coordinate is not an exact integer nanometre'); return BigInt(n); };
const cross = (a: Point, b: Point, c: Point): bigint =>
  (big(b[0]) - big(a[0])) * (big(c[1]) - big(a[1])) - (big(b[1]) - big(a[1])) * (big(c[0]) - big(a[0]));
const on = (a: Point, b: Point, p: Point): boolean => cross(a, b, p) === 0n
  && a.every((n, i) => Math.min(n, b[i]!) <= p[i]! && p[i]! <= Math.max(n, b[i]!));
export function intersects(a: Point, b: Point, c: Point, d: Point): boolean {
  const p = cross(a, b, c), q = cross(a, b, d), r = cross(c, d, a), s = cross(c, d, b);
  return (p * q < 0n && r * s < 0n) || on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b);
}
export function nm(mm: unknown): number {
  if (typeof mm !== 'string' && typeof mm !== 'number') throw new Error('missing exact native diagnostic point');
  const d = Decimal.of(String(mm)), power = d.exponent + 6;
  const unit = 10n ** BigInt(Math.abs(power));
  if (power < 0 && d.digits % unit !== 0n) throw new Error('diagnostic point is not on the native nanometre grid');
  const digits = power >= 0 ? d.digits * unit : d.digits / unit;
  const n = Number(d.negative ? -digits : digits); big(n); return n;
}
export function mm(n: number): string {
  big(n); const sign = n < 0 ? '-' : '', digits = String(Math.abs(n)).padStart(7, '0');
  const fraction = digits.slice(-6).replace(/0+$/, '');
  return `${sign}${digits.slice(0, -6)}${fraction ? `.${fraction}` : ''}`;
}
const squared = (a: Point, b: Point): bigint => (big(a[0]) - big(b[0])) ** 2n + (big(a[1]) - big(b[1])) ** 2n;
const segments = (b: Board): Track[] => tracks(b).filter(t => t.mid === null);
function envelope(a: Point, b: Point, center: Pt, radius: number): boolean {
  const corners: Point[] = [[center.x - radius, center.y - radius], [center.x + radius, center.y - radius],
    [center.x + radius, center.y + radius], [center.x - radius, center.y + radius]];
  return corners.some((c, i) => intersects(a, b, c, corners[(i + 1) % 4]!))
    || Math.abs(a[0] - center.x) <= radius && Math.abs(a[1] - center.y) <= radius;
}
/** Conservative envelopes reject only; native DRC still decides actual clearance. */
export function crossingGuard(board: Board, net: string, layer: string, a: Point, b: Point): void {
  for (const t of tracks(board)) {
    if (t.net === net) continue;
    if (t.mid) throw new Error('retained other-net arcs require exact native geometric reconciliation');
    if (t.layer === layer && intersects(a, b, point(t.start), point(t.end))) throw new Error('straight bridge crosses protected other-net copper: ' + t.id);
  }
  for (const v of vias(board)) {
    // Double coordinates preserve the half-nanometre radius exactly.
    if (v.net !== net && envelope(a.map(n => n * 2) as unknown as Point, b.map(n => n * 2) as unknown as Point,
      { x: v.at.x * 2, y: v.at.y * 2 }, v.size)) throw new Error('straight bridge crosses protected other-net via envelope: ' + v.id);
  }
  for (const f of board.footprints) for (const p of f.pads) {
    if (p.net === net || !p.layers.includes(layer)) continue;
    if (!p.id || p.size.x <= 0 || p.size.y <= 0) throw new Error('unresolved native pad envelope');
    // The square is rounded outward to the API's native integer unit. This is a rejection envelope, never clearance credit.
    const radius = Math.ceil(Math.hypot(p.size.x, p.size.y) / 2);
    if (envelope(a, b, p.position, radius)) throw new Error('straight bridge crosses other-net pad envelope: ' + f.reference);
  }
}
function validateCopperIds(board: Board): void {
  const ids = board.copper.map(item => 'Track' in item ? item.Track.id : item.Via.id);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error('ambiguous native copper identity');
}
export function selectGap(board: Board, report: DrcReport): { choice: GapChoice | null; rejected: RejectedGap[] } {
  validateCopperIds(board);
  const items = new Map(tracks(board).map(t => [t.id, t]));
  const exposed = (self: Track, endpoint: Point): boolean => {
    for (const t of tracks(board)) if (t.id !== self.id && t.net === self.net && t.layer === self.layer) {
      if (!t.mid && on(point(t.start), point(t.end), endpoint)) return false;
      if (t.mid && (equal(endpoint, point(t.start)) || equal(endpoint, point(t.end)))) return false;
    }
    return !vias(board).some(v => v.net === self.net && equal(point(v.at), endpoint));
  };
  const choices: GapChoice[] = [], rejected: RejectedGap[] = [];
  report.unconnected_items.forEach((row, index) => {
    if (row.items?.length !== 2) return;
    try {
      const selected = row.items.map(item => {
        const t = items.get(item.uuid ?? '');
        if (!t || t.mid) throw new Error('gap endpoints must identify two exact native straight tracks');
        const pos: Point = [nm(item.pos?.x), nm(item.pos?.y)];
        if (![point(t.start), point(t.end)].some(end => equal(pos, end))) throw new Error('native diagnostic point is not an exact source track endpoint');
        if (t.locked) throw new Error('locked endpoint requires explicit design ownership');
        return { track: t, ends: [point(t.start), point(t.end)].filter(end => exposed(t, end)) };
      });
      const [left, right] = selected as [typeof selected[number], typeof selected[number]];
      const l = left.track, r = right.track;
      if (l.id === r.id || l.net !== r.net || l.layer !== r.layer || l.width !== r.width) throw new Error('gap must share exact source net, layer and width');
      const pairs = left.ends.flatMap(a => right.ends.filter(b => !equal(a, b)).map(b => ({ a, b, distance: squared(a, b) })));
      pairs.sort((a, b) => a.distance < b.distance ? -1 : a.distance > b.distance ? 1 : 0);
      if (!pairs.length || pairs.length > 1 && pairs[0]!.distance === pairs[1]!.distance) throw new Error('native source endpoints do not identify one unambiguous exposed gap');
      const { a, b } = pairs[0]!, dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]);
      if (dx && dy && dx !== dy) throw new Error('gap is not a single 0/45/90-degree source pattern');
      crossingGuard(board, l.net, l.layer, a, b);
      choices.push({ strategy: 'straight_gap_bridge', native_open_index: index, net: l.net, layer: l.layer,
        width_mm: mm(l.width), endpoint_ids: [l.id, r.id], points_mm: [a.map(mm), b.map(mm)] });
    } catch (error) { rejected.push({ native_open_index: index, cause: String((error as Error).message) }); }
  });
  choices.sort((a, b) => compare(a.net, b.net) || compare(a.layer, b.layer) || compare(a.endpoint_ids.join('\0'), b.endpoint_ids.join('\0')));
  return { choice: choices[0] ?? null, rejected };
}
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export interface Shift { via: Via; along: Track; other: Track; origin: Point; destination: Point }
function roundEven(numerator: bigint, denominator: bigint): number {
  const sign = numerator < 0n ? -1n : 1n, n = numerator * sign;
  const q = n / denominator, r = n % denominator;
  return Number((q + (2n * r > denominator || 2n * r === denominator && q % 2n !== 0n ? 1n : 0n)) * sign);
}
export function prepareShift(board: Board, viaId: string, alongId: string, fraction: number): Shift {
  if (![.25, .5, .75].includes(fraction)) throw new Error('fraction must be one of the admitted incident pattern fractions');
  if ([...board.copper_layers].sort().join(',') !== 'B.Cu,F.Cu') throw new Error('this local pattern requires a two-layer board');
  const via = vias(board).find(v => v.id === viaId);
  const extent = via as (Via & { via_type?: string; layers?: string[] }) | undefined;
  if (!via || via.locked || extent?.via_type !== 'Through' || extent.layers?.join(',') !== 'F.Cu,B.Cu') throw new Error('unlocked through via with exact API type/layer extent required');
  const origin = point(via.at), incident: Track[] = [];
  for (const t of tracks(board).filter(t => t.net === via.net)) {
    if ([point(t.start), point(t.end)].some(p => equal(p, origin))) {
      if (t.mid) throw new Error('incident arc requires a richer repair'); incident.push(t);
    } else if (!t.mid && on(point(t.start), point(t.end), origin)) throw new Error('via lies inside another segment; branch repair required');
  }
  if (incident.length !== 2 || !incident.some(t => t.id === alongId)) throw new Error('exactly two incident source segments required');
  const along = incident.find(t => t.id === alongId)!, other = incident.find(t => t.id !== alongId)!;
  if (along.locked || other.locked) throw new Error('locked incident copper requires explicit ownership handling');
  if ([along.layer, other.layer].sort().join(',') !== 'B.Cu,F.Cu') throw new Error('incident traces must occupy opposite layers');
  const anchor = [point(along.start), point(along.end)].find(p => !equal(p, origin));
  if (!anchor) throw new Error('zero-length incident trace');
  const numerator = BigInt(fraction * 4);
  const destination = origin.map((n, i) => roundEven(big(n) * 4n + (big(anchor[i]!) - big(n)) * numerator, 4n)) as unknown as Point;
  if (equal(destination, origin) || equal(destination, anchor)) throw new Error('fraction collapses at native coordinate precision');
  if (cross(origin, anchor, destination) !== 0n) throw new Error('quantized position is not on the incident centreline');
  return { via, along, other, origin, destination };
}
export function selectVia(board: Board, report: DrcReport): ViaChoice | null {
  validateCopperIds(board);
  const groups = new Map<string, { pads: Set<string>; errors: number[] }>(), copper = new Map(vias(board).map(v => [v.id, v]));
  report.violations.filter(v => v.severity === 'error').forEach((row, index) => {
    const ids = row.items?.map(i => i.uuid ?? '') ?? [], via = ids.filter(id => copper.has(id));
    if (!['clearance', 'hole_clearance'].includes(row.type ?? '') || ids.length !== 2 || new Set(ids).size !== 2 || via.length !== 1) return;
    const group = groups.get(via[0]!) ?? { pads: new Set<string>(), errors: [] };
    group.pads.add(ids.find(id => id !== via[0])!); group.errors.push(index); groups.set(via[0]!, group);
  });
  const pads = new Map<string, Pt>();
  for (const f of board.footprints) for (const p of f.pads) { if (pads.has(p.id)) throw new Error('duplicate native pad identity'); pads.set(p.id, p.position); }
  const candidates: { choice: ViaChoice; distance: bigint }[] = [];
  for (const [viaId, group] of [...groups].sort(([a], [b]) => compare(a, b))) {
    if ([...group.pads].some(id => !pads.has(id))) continue;
    const nativeVia = copper.get(viaId)!, origin = point(nativeVia.at);
    const incident = segments(board).filter(t => t.net === nativeVia.net && [point(t.start), point(t.end)].some(p => equal(p, origin)));
    for (const along of incident.sort((a, b) => compare(a.id, b.id))) for (const fraction of [.25, .5, .75]) {
      try {
        const shift = prepareShift(board, viaId, along.id, fraction), { origin, destination } = shift;
        if ([...group.pads].some(id => { const p = pads.get(id)!; return (big(destination[0]) - big(origin[0])) * (big(origin[0]) - big(p.x))
          + (big(destination[1]) - big(origin[1])) * (big(origin[1]) - big(p.y)) <= 0n; })) continue;
        const distance = squared(origin, destination);
        candidates.push({ distance, choice: { strategy: 'via_shift_bridge', net: shift.via.net, via_id: viaId, along_trace_id: along.id,
          fraction, conflict_error_indices: group.errors, pad_ids: [...group.pads].sort(), destination_mm: destination.map(mm), bridge_length_mm: Math.sqrt(Number(distance)) / NM_PER_MM } });
      } catch { /* An inadmissible local topology contributes no proposal. */ }
    }
  }
  candidates.sort((a, b) => b.choice.conflict_error_indices.length - a.choice.conflict_error_indices.length
    || (a.distance < b.distance ? -1 : a.distance > b.distance ? 1 : 0) || compare(a.choice.via_id, b.choice.via_id)
    || compare(a.choice.along_trace_id, b.choice.along_trace_id) || a.choice.fraction - b.choice.fraction);
  return candidates[0]?.choice ?? null;
}
/** One RFC 4122 URL-namespace UUID, preserving the original deterministic repair identity. */
export function bridgeUuid(name: string): string {
  const digest = createHash('sha1').update(Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex')).update(name).digest().subarray(0, 16);
  digest[6] = (digest[6]! & 15) | 80; digest[8] = (digest[8]! & 63) | 128;
  return digest.toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}
export function verifyCopperScope(source: Board, candidate: Board, choice: Choice, addedId: string): void {
  validateCopperIds(source); validateCopperIds(candidate);
  const original = new Map(source.copper.map(item => ['Track' in item ? item.Track.id : item.Via.id, item]));
  const after = new Map(candidate.copper.map(item => ['Track' in item ? item.Track.id : item.Via.id, item]));
  if (original.has(addedId) || after.size !== original.size + 1 || [...original.keys()].some(id => !after.has(id)) || !after.has(addedId)) throw new Error('local repair added/deleted copper outside its single bridge scope');
  for (const [id, item] of original) {
    if (choice.strategy === 'via_shift_bridge' && id === choice.via_id) {
      const old = 'Via' in item ? item.Via : null, changed = after.get(id)!;
      if (!old || !('Via' in changed) || fingerprint({ ...old, at: null }) !== fingerprint({ ...changed.Via, at: null })
        || !equal(point(changed.Via.at), choice.destination_mm.map(nm) as unknown as Point)) throw new Error('local repair changed protected via geometry/net/layers');
    } else if (fingerprint(item) !== fingerprint(after.get(id))) throw new Error('local repair changed protected original copper: ' + id);
  }
  const bridge = after.get(addedId)!;
  if (!('Track' in bridge) || bridge.Track.mid || bridge.Track.net !== choice.net) throw new Error('local bridge has wrong source net or native shape');
  let ends: Point[], layer: string, width: number;
  if (choice.strategy === 'via_shift_bridge') { const shift = prepareShift(source, choice.via_id, choice.along_trace_id, choice.fraction); ends = [shift.origin, shift.destination]; layer = shift.other.layer; width = shift.other.width; }
  else { ends = choice.points_mm.map(p => p.map(nm) as unknown as Point); layer = choice.layer; width = nm(choice.width_mm); }
  if (![point(bridge.Track.start), point(bridge.Track.end)].every(p => ends.some(end => equal(p, end))) || equal(point(bridge.Track.start), point(bridge.Track.end))
    || bridge.Track.layer !== layer || bridge.Track.width !== width) throw new Error('bridge endpoint, layer or width differs from exact source pattern');
}
export function protectedGeometry(board: Board, omit: string[] = []): string {
  const sorted = <T>(items: T[]): T[] => [...items].sort((a, b) => compare(fingerprint(a), fingerprint(b)));
  const zones = (items: Board['zones']) => sorted(items.map(({ filled: _cache, ...settings }) => settings));
  return fingerprint({ ...board, path: null, zones: zones(board.zones), graphics: sorted(board.graphics),
    footprints: sorted(board.footprints.map(fp => ({ ...fp, pads: sorted(fp.pads), graphics: sorted(fp.graphics), zones: zones(fp.zones) }))),
    copper: sorted(board.copper.filter(item => !omit.includes('Track' in item ? item.Track.id : item.Via.id))) });
}
