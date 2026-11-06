// Source-bound engineering screens for actual native placement geometry. These checks do not establish electrical,
// routing, enclosure or bench qualification. Unsupported geometry or rules stop the reviewed workflow.
//
// The placer's problem-level screens are in tools/placer/engineering-problem.ts and, for the search,
// tools/placer/core/src/engineering.rs.
import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { verifyBinding, type Binding } from './block-bindings.ts';
import { readBlock } from './block-reuse.ts';
import { errorText } from './cli.ts';
import { fingerprint } from './fingerprint.ts';
import { readObject, sha256File } from './json-file.ts';
import { footprints, footprintSignature, rotate } from './native-board.ts';
import { boardConfig } from './pcb-workflow.ts';
import { compare, Float, jsonCanonical, jsonDumps } from './py-compat.mjs';
import { dist, hypot, pyMod } from './py-math.ts';
import { round } from './py-numbers.ts';
import { joinPath, resolvePath, textOf, withSuffix } from './py-path.ts';
import { isDict, need, pyFloat, sameValue, type Dict } from './py-values.ts';
import { field, forms, type SList } from './sexpr.ts';

export const SCHEMA = 'iot-lab.engineering-constraints.v1';
const KINDS = ['fixed', 'rigid_group', 'pin_distance', 'part_distance', 'region', 'clearance', 'connector_access', 'escape'];
const CORE_FIELDS = ['schema', 'root', 'board', 'manifest', 'native', 'inputs', 'rules', 'geometry', 'bindings'] as const;
export const RULE_FIELDS: Record<string, string[]> = {
  fixed: ['refs'], rigid_group: ['refs', 'binding'], pin_distance: ['a', 'b', 'metric', 'min_mm', 'max_mm'],
  part_distance: ['a', 'b', 'metric', 'min_mm', 'max_mm'], region: ['refs', 'box_mm', 'placement', 'metric'],
  clearance: ['a', 'b', 'metric', 'min_mm'], connector_access: ['ref', 'metric', 'corridor_mm', 'exit_side'],
  escape: ['refs', 'pads', 'metric', 'layers', 'width_mm', 'clearance_mm', 'reach_mm', 'grid_mm'],
};
const ESCAPE_OVERRIDES = ['layers', 'width_mm', 'clearance_mm', 'reach_mm', 'grid_mm'];

type Box = [number, number, number, number];
type Point = [number, number];

export interface Pad { center: number[]; shape: string; size: number[]; axis_aligned: boolean; layers: SList; kind: string }
export interface Part { origin: Point; quarter: number; pads: Map<string, Pad[]>; courtyard: Box | null; locked: boolean }
export interface Geometry { refs: Map<string, Part>; bounds: Box | null }

export interface Rule extends Dict { id: string; kind: string; source: unknown }

export interface Contract {
  schema: string;
  root: string;
  board: string;
  manifest: string;
  native: string;
  inputs: Map<string, string>;
  rules: Rule[];
  geometry: Geometry;
  bindings: Binding[];
  qualified: false;
  review_sha256?: string;
}

/** The two checks this module borrows: their owners are the parts and routing clusters. */
export interface ReviewServices {
  verifyManifest: (root: string, board: string, manifest: string) => Dict;
  verifyEscapeEvidence: (contract: Contract, candidate: string, evidence: string) => Dict[];
}

/** Every geometry number is a float in the hashed text, also a whole one: 10.0, not 10. */
function floatTree(value: unknown): unknown {
  if (typeof value === 'number') return new Float(value);
  if (Array.isArray(value)) return value.map(floatTree);
  if (value instanceof Map) return new Map([...value].map(([key, item]) => [key, floatTree(item)]));
  if (isDict(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, floatTree(item)]));
  return value;
}

const hashable = (contract: Contract): Dict => ({ ...contract, geometry: floatTree(contract.geometry) });

export const contractDigest = (contract: Contract): string => {
  const whole = hashable(contract);
  return fingerprint(Object.fromEntries(CORE_FIELDS.map(key => [key, whole[key]])));
};

const read = (path: string): Dict => readObject<Dict>(path, `expected JSON object: ${path}`);
const resolveIn = (base: string, name: unknown): string => resolvePath(joinPath(base, name));

/**
 * Reviewed rules as plain objects, from the Map, Float and bigint values of jsonLoads. Numbers stay exact: the digest must see
 * 1.0 where the file says 1.0, as Python's dict did, or stored hashes stop verifying. Only arithmetic goes through numeric().
 */
export function exactTree(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || value instanceof Float) return value;
  if (Array.isArray(value)) return value.map(exactTree);
  const entries = value instanceof Map ? [...value] : Object.entries(value);
  return Object.fromEntries(entries.map(([key, item]) => [key, exactTree(item)]));
}

function numeric(value: unknown): number {
  const number = value instanceof Float ? value.value : typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) throw new Error('finite numeric constraint required');
  return number;
}

const limit = (rule: Rule, key: string, otherwise: number): number => (key in rule ? numeric(rule[key]) : otherwise);

function sourceDocument(base: string, source: unknown): string {
  const whole = isDict(source) && (typeof source.page === 'bigint' || Number.isInteger(source.page));
  if (!whole || Number(source.page) < 1) {
    throw new Error('constraint requires a reviewed document and one-based page');
  }
  if (typeof source.path !== 'string' || isAbsolute(source.path) || source.path.split(/[\\/]/).includes('..') || relative(realpathSync(base), realpathSync(resolveIn(base, source.path))).startsWith('..')) throw new Error('constraint source must stay inside project root');
  const path = resolveIn(base, need(source, 'path'));
  if (sha256File(path) !== source.sha256) throw new Error(`constraint source changed: ${path}`);
  return path;
}

export function point(x: number, y: number, q: number, origin: readonly number[]): Point {
  let a: number, b: number;
  if ([0, 1, 2, 3].includes(q)) {
    [a, b] = rotate(x, y, q, value => -value);
  } else {
    const angle = q * 90 * (Math.PI / 180);
    a = x * Math.cos(angle) + y * Math.sin(angle);
    b = -x * Math.sin(angle) + y * Math.cos(angle);
  }
  return [(origin[0] as number) + a, (origin[1] as number) + b];
}

const boundsOf = (points: readonly number[][]): Box => [
  Math.min(...points.map(p => p[0] as number)), Math.min(...points.map(p => p[1] as number)),
  Math.max(...points.map(p => p[0] as number)), Math.max(...points.map(p => p[1] as number)),
];

export function transformedBox([x0, y0, x1, y1]: number[], q: number, origin: readonly number[]): Box {
  const corners = ([[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as Point[]).map(([x, y]) => point(x, y, q, origin));
  return boundsOf(corners);
}

const floats = (fields: SList | undefined): number[] => (fields ?? []).map(value => pyFloat(value as string));

function nativePad(item: SList, q: number, origin: Point, footprintAngle: number, ref: string): Pad {
  const at = field(item, 'at') ?? ['0', '0'];
  const size = field(item, 'size');
  if (!size || size.length !== 2) throw new Error(`missing native pad size: ${ref}`);
  const [x, y] = floats(at.slice(0, 2)) as Point;
  const padQuarter = pyMod(at.length === 3 ? pyFloat(at[2] as string) : footprintAngle, 360) / 90;
  let [width, height] = floats(size) as Point;
  if (width <= 0 || height <= 0) throw new Error('native pad size must be positive');
  if (padQuarter % 2) [width, height] = [height, width];
  return {
    center: point(x, y, q, origin), shape: item[3] as string, size: [width, height],
    axis_aligned: [0, 1, 2, 3].includes(padQuarter), layers: field(item, 'layers') ?? [], kind: item[2] as string,
  };
}

/** Corner points of one courtyard item, or null for a shape the model does not read. */
function courtyardPoints(item: SList, q: number, origin: Point): number[][] | null {
  const local = (name: string): Point => point(...(floats(field(item, name)) as Point), q, origin);
  if (item[0] === 'fp_line' || item[0] === 'fp_rect') return [local('start'), local('end')];
  if (item[0] !== 'fp_circle') return null;
  const [cx, cy] = floats(field(item, 'center')) as Point, [ex, ey] = floats(field(item, 'end')) as Point;
  const radius = hypot(cx - ex, cy - ey);
  const [x, y] = point(cx, cy, q, origin);
  return [[x - radius, y - radius], [x + radius, y + radius]];
}

function nativePart(form: SList, pose: number[], ref: string): Part {
  const [x, y, angle] = pose as [number, number, number];
  const origin: Point = [x, y], q = pyMod(angle, 360) / 90;
  const pads = new Map<string, Pad[]>();
  const courtyard: number[][] = [];
  let unsupported = false;
  for (const item of form.slice(2)) {
    if (!Array.isArray(item) || !item.length) continue;
    if (item[0] === 'pad') {
      const name = item[1] as string;
      pads.set(name, [...pads.get(name) ?? [], nativePad(item, q, origin, angle, ref)]);
    } else if (['F.CrtYd', 'B.CrtYd'].includes((field(item, 'layer') ?? [''])[0] as string)) {
      const points = courtyardPoints(item, q, origin);
      if (points) courtyard.push(...points);
      else unsupported = true;
    }
  }
  const lock = field(form, 'locked');
  return {
    origin, quarter: q, pads, courtyard: courtyard.length && !unsupported ? boundsOf(courtyard) : null,
    locked: form.includes('locked') || (lock !== undefined && !sameValue(lock, ['no'])),
  };
}

/** Exact pad centers; limited copper shapes and conservative courtyards. */
export function nativeGeometry(path: string): Geometry {
  const root = forms(textOf(path))[0] as SList;
  const edges: number[][] = [];
  for (const form of root.slice(1)) {
    if (!Array.isArray(form) || !form.length) continue;
    if ((form[0] === 'gr_line' || form[0] === 'gr_rect') && (field(form, 'layer') ?? [''])[0] === 'Edge.Cuts') {
      edges.push(floats(field(form, 'start')), floats(field(form, 'end')));
    }
  }
  const refs = new Map<string, Part>();
  for (const { props, pose, form } of footprints(path)) {
    const ref = props.get('Reference');
    if (!ref || refs.has(ref)) throw new Error('missing or duplicate native reference');
    refs.set(ref, nativePart(form, pose.map(value => value.toNumber()), ref));
  }
  const geometry: Geometry = { refs, bounds: edges.length ? boundsOf(edges) : null };
  jsonCanonical(geometry.bounds);
  jsonCanonical([...refs.values()].map(part => ({ ...part, pads: [...part.pads.values()] })));   // A native NaN cannot become a passing comparison.
  return geometry;
}

function endpoint(geometry: Geometry, selector: unknown): Pad {
  if (!isDict(selector) || !sameValue(Object.keys(selector).sort(), ['pad', 'ref'])) throw new Error('pad endpoint requires exact ref and pad');
  const part = geometry.refs.get(selector.ref as string);
  if (!part) throw new Error(`'${String(selector.ref)}'`);
  const rows = part.pads.get(String(selector.pad)) ?? [];
  if (rows.length !== 1) throw new Error(`pad endpoint missing or ambiguous: ${jsonDumps(selector)}`);
  return rows[0] as Pad;
}

function ruleRefs(rule: Rule): Set<string> {
  if (['fixed', 'rigid_group', 'escape', 'region'].includes(rule.kind)) return new Set(need<string[]>(rule, 'refs'));
  if (rule.kind === 'part_distance') return new Set([rule.a as string, ...(rule.b as string[])]);
  if (rule.kind === 'connector_access') return new Set([need<string>(rule, 'ref')]);
  return new Set([need<string>(need(rule, 'a'), 'ref'), need<string>(need(rule, 'b'), 'ref')]);
}

const sortedRefs = (rule: Rule): string[] => [...ruleRefs(rule)].sort(compare);
const overlaps = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => [...a].some(item => b.has(item));

function checkBoundBlock(rule: Rule, refs: Set<string>, declared: Map<unknown, Rule>, root: string, sources: Map<string, string>): Binding {
  const descriptor = rule.binding as Dict;
  const path = resolveIn(root, need(descriptor, 'path'));
  if (sha256File(path) !== descriptor.sha256) throw new Error('block binding evidence changed');
  const binding = verifyBinding(read(path) as never);
  if (!sameValue([...binding.refs.values()].sort(compare), [...refs].sort(compare))) throw new Error('bound instance refs differ from rigid group');
  const block = readBlock(binding.source_directory);
  const mapping = descriptor.layout_rule_ids;
  const indexes = block.layout_rules.map((_, index) => String(index));
  if (!isDict(mapping) || !sameValue(Object.keys(mapping).sort(compare), indexes.sort(compare))) {
    throw new Error(`reviewed block layout-rule coverage missing: ${rule.id}`);
  }
  if (Object.values(mapping).some(ids => !Array.isArray(ids) || !ids.length || ids.some(id => !declared.has(id)))) {
    throw new Error('reviewed block rule mapping needs exact sourced constraint IDs');
  }
  const boundary = descriptor.boundary_rule_ids;
  if (!Array.isArray(boundary) || !boundary.length || boundary.some(id => !declared.has(id))) {
    throw new Error(`reviewed block boundary constraints missing: ${rule.id}`);
  }
  for (const id of boundary) {
    const other = declared.get(id) as Rule;
    const targets = ruleRefs(other);
    if (!['clearance', 'connector_access', 'escape'].includes(other.kind) || !overlaps(targets, refs)
        || (other.kind === 'clearance' && ![...targets].some(ref => !refs.has(ref)))) {
      throw new Error(`block boundary rule does not constrain actual external geometry: ${String(id)}`);
    }
  }
  sources.set(path, sha256File(path));
  const pcb = forms(textOf(joinPath(binding.source_directory, `${binding.block_id}.kicad_pcb`)))[0] as SList;
  rule.retained_internal_copper = pcb.some(form => Array.isArray(form) && ['segment', 'arc', 'via', 'zone'].includes(form[0] as string));
  return binding;
}

function checkDistance(rule: Rule, geometry: Geometry): void {
  const a = endpoint(geometry, rule.a), b = endpoint(geometry, rule.b);
  const clearance = rule.kind === 'clearance';
  if (rule.metric !== (clearance ? 'copper_edge_2d' : 'pad_center_euclidean')) throw new Error(`unsupported engineering metric: ${String(rule.metric)}`);
  if ((!('min_mm' in rule) && !('max_mm' in rule)) || (clearance && (!('min_mm' in rule) || 'max_mm' in rule))) throw new Error('sourced min/max distance required');
  for (const key of ['min_mm', 'max_mm']) if (key in rule && numeric(rule[key]) < 0) throw new Error('negative sourced distance');
  if (limit(rule, 'min_mm', 0) > limit(rule, 'max_mm', Infinity)) throw new Error('contradictory sourced distances');
  if (clearance && [a, b].some(pad => !['rect', 'circle'].includes(pad.shape) || pad.kind === 'np_thru_hole' || !pad.axis_aligned)) {
    throw new Error(`unsupported exact copper shape for clearance: ${rule.id}`);
  }
}

function checkConnector(rule: Rule, geometry: Geometry): void {
  if (rule.metric !== 'courtyard_corridor_2d' || !['L', 'R', 'T', 'B'].includes(rule.exit_side as string)) throw new Error('unsupported connector access metric');
  const box = (rule.corridor_mm ?? []) as unknown[];
  if (box.length !== 4) throw new Error('connector corridor requires a nonempty local rectangle');
  const [x0, y0, x1, y1] = box.map(numeric) as Box;
  if (!(x0 < x1 && y0 < y1)) throw new Error('connector corridor requires a nonempty local rectangle');
  if (!(x0 <= 0 && 0 <= x1 && y0 <= 0 && 0 <= y1)) throw new Error('connector corridor must include its native reference origin');
  if (geometry.bounds === null || [...geometry.refs.values()].some(part => part.courtyard === null)) {
    throw new Error('connector access needs board edges and every footprint courtyard');
  }
}

function checkEscape(rule: Rule, refs: Set<string>, geometry: Geometry): void {
  if (rule.metric !== 'native_minimum_track_escape') throw new Error('unsupported native escape metric');
  const overrides = ESCAPE_OVERRIDES.filter(name => name in rule).sort(compare);
  if (overrides.length) throw new Error(`unsupported native escape overrides: ${overrides.join(',')}`);
  for (const selected of (rule.pads ?? []) as Dict[]) {
    endpoint(geometry, selected);
    if (!refs.has(selected.ref as string)) throw new Error('escape pad selector is outside reviewed refs');
  }
}

export function normalizedRules(root: string, envelope: Dict, geometry: Geometry): { rules: Rule[]; sources: Map<string, string>; bindings: Binding[] } {
  if (envelope.schema !== SCHEMA || !Array.isArray(envelope.rules)) throw new Error('reviewed placement constraints schema missing');
  const given = exactTree(envelope.rules) as Dict[];
  if (given.some(rule => !isDict(rule))) throw new Error('constraint must be an object');
  const declared = new Map(given.filter(isDict).map(rule => [rule.id, rule as Rule]));
  const rules: Rule[] = [], sources = new Map<string, string>(), bindings: Binding[] = [], seen = new Set<string>();
  for (const original of given) {
    const rule = exactTree(original) as Rule;
    if (typeof rule.id !== 'string' || !rule.id || seen.has(rule.id)) throw new Error('constraint needs a distinct reviewed ID');
    seen.add(rule.id);
    if (!KINDS.includes(rule.kind)) throw new Error(`unsupported engineering constraint: ${String(rule.kind ?? 'None')}`);
    const allowed = new Set(['id', 'kind', 'source', ...RULE_FIELDS[rule.kind] as string[]]);
    const unknown = Object.keys(rule).filter(key => !allowed.has(key)).sort(compare);
    if (unknown.length) throw new Error(`unsupported constraint fields: ${unknown.join(',')}`);
    const path = sourceDocument(root, need(rule, 'source'));
    sources.set(path, sha256File(path));
    if (rule.kind === 'part_distance' && (typeof rule.a !== 'string' || !Array.isArray(rule.b) || !rule.b.length || rule.b.some(ref => typeof ref !== 'string') || new Set(rule.b).size !== rule.b.length)) throw new Error('part distance needs an origin and distinct nearest refs');
    if (['fixed', 'rigid_group', 'escape', 'region'].includes(rule.kind) && !Array.isArray(rule.refs)) throw new Error('constraint needs distinct exact native refs');
    const refs = ruleRefs(rule);
    if (!refs.size || [...refs].some(ref => !geometry.refs.has(ref))) throw new Error(`constraint references absent native parts: ${rule.id}`);
    const { kind } = rule;
    if (['fixed', 'rigid_group', 'escape', 'region'].includes(kind) && (!Array.isArray(rule.refs) || refs.size !== rule.refs.length)) {
      throw new Error('constraint needs distinct exact native refs');
    }
    if (kind === 'rigid_group') {
      if (refs.size < 2) throw new Error('rigid group requires at least two parts');
      if (rule.binding) bindings.push(checkBoundBlock(rule, refs, declared, root, sources));
    } else if (kind === 'part_distance') {
      if (rule.metric !== 'origin_nearest_euclidean') throw new Error('unsupported part distance metric');
      if (!('min_mm' in rule) && !('max_mm' in rule)) throw new Error('sourced min/max distance required');
      for (const key of ['min_mm', 'max_mm']) if (key in rule && numeric(rule[key]) < 0) throw new Error('negative sourced distance');
      if (limit(rule, 'min_mm', 0) > limit(rule, 'max_mm', Infinity)) throw new Error('contradictory sourced distances');
    } else if (kind === 'region') {
      if (rule.metric !== 'origin_in_box' || !['inside', 'outside'].includes(rule.placement as string)) throw new Error('unsupported region metric or placement');
      if (!Array.isArray(rule.box_mm) || rule.box_mm.length !== 4) throw new Error('region requires a nonempty rectangle');
      const [a, b, c, d] = rule.box_mm.map(numeric) as Box;
      if (!(a < c && b < d)) throw new Error('region requires a nonempty rectangle');
    } else if (kind === 'pin_distance' || kind === 'clearance') {
      checkDistance(rule, geometry);
    } else if (kind === 'connector_access') {
      checkConnector(rule, geometry);
    } else if (kind === 'escape') {
      checkEscape(rule, refs, geometry);
    }
    rules.push(rule);
  }
  return { rules, sources, bindings };
}

function padGap(first: Pad, second: Pad): number {
  let a = first, b = second;
  if (!a.layers.some(layer => b.layers.includes(layer)) && !a.layers.includes('*.Cu') && !b.layers.includes('*.Cu')) {
    throw new Error('clearance endpoints have no common modeled copper layer');
  }
  const round_ = (pad: Pad): void => {
    if (pad.size[0] !== pad.size[1]) throw new Error('noncircular native circle pad');
  };
  if (a.shape === 'circle' && b.shape === 'circle') {
    round_(a);
    round_(b);
    return dist(a.center, b.center) - ((a.size[0] as number) + (b.size[0] as number)) / 2;
  }
  if (a.shape === 'circle') [a, b] = [b, a];
  const dx = Math.abs((a.center[0] as number) - (b.center[0] as number)) - (a.size[0] as number) / 2;
  const dy = Math.abs((a.center[1] as number) - (b.center[1] as number)) - (a.size[1] as number) / 2;
  if (b.shape === 'circle') {
    round_(b);
    return hypot(Math.max(dx, 0), Math.max(dy, 0)) - (b.size[0] as number) / 2;
  }
  return hypot(Math.max(dx - (b.size[0] as number) / 2, 0), Math.max(dy - (b.size[1] as number) / 2, 0));
}

type Measured = { miss: number; detail: Dict };

function measureMove(rule: Rule, original: Geometry, geometry: Geometry): Measured {
  const transforms = (rule.refs as string[]).map(ref => {
    const before = original.refs.get(ref) as Part, after = geometry.refs.get(ref) as Part;
    const q = pyMod(after.quarter - before.quarter, 4);
    const [x, y] = point(...before.origin, q, [0, 0]);
    return [q, round(after.origin[0] - x, 6), round(after.origin[1] - y, 6)] as [number, number, number];
  });
  const retained = Boolean(rule.retained_internal_copper);
  const bad = rule.kind === 'fixed' || retained
    ? transforms.some(move => move.some(value => value !== 0))
    : new Set(transforms.map(move => move.map(value => value + 0).join(' '))).size !== 1;
  return { miss: bad ? 1 : 0, detail: { measured: bad ? 1 : 0, max: 0, margin: bad ? -1 : 0, transforms, policy: retained ? 'fixed_retained_copper' : rule.kind } };
}

function measureDistance(rule: Rule, geometry: Geometry): Measured {
  if (rule.kind === 'part_distance') {
    const origin = geometry.refs.get(rule.a as string)!.origin;
    return distanceMeasurement(rule, Math.min(...(rule.b as string[]).map(ref => dist(origin, geometry.refs.get(ref)!.origin))));
  }
  const a = endpoint(geometry, rule.a), b = endpoint(geometry, rule.b);
  const measured = rule.kind === 'pin_distance' ? dist(a.center, b.center) : padGap(a, b);
  return distanceMeasurement(rule, measured);
}

function distanceMeasurement(rule: Rule, measured: number): Measured {
  const low = limit(rule, 'min_mm', 0), high = limit(rule, 'max_mm', Infinity);
  const limits = Object.fromEntries(['min_mm', 'max_mm'].filter(key => key in rule).map(key => [key, rule[key]]));
  return { miss: Math.max(low - measured, 0, measured - high), detail: { measured_mm: measured, metric: rule.metric, margin_mm: Math.min('min_mm' in rule ? measured - low : Infinity, high - measured), ...limits } };
}

function measureRegion(rule: Rule, geometry: Geometry): Measured {
  const [x0, y0, x1, y1] = (rule.box_mm as unknown[]).map(numeric) as Box;
  const margins = (rule.refs as string[]).map(ref => {
    const [x, y] = geometry.refs.get(ref)!.origin;
    const outside = hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1));
    const inside = Math.min(x - x0, x1 - x, y - y0, y1 - y);
    const signed = outside > 0 ? -outside : inside;
    return { ref, margin_mm: rule.placement === 'inside' ? signed : -signed };
  });
  const margin = Math.min(...margins.map(row => row.margin_mm));
  return { miss: Math.max(0, -margin), detail: { measured_mm: margin, min_mm: 0, margin_mm: margin, placement: rule.placement, box_mm: rule.box_mm, origins: margins } };
}

function measureConnector(rule: Rule, geometry: Geometry): Measured {
  const part = geometry.refs.get(rule.ref as string) as Part;
  const box = transformedBox((rule.corridor_mm as unknown[]).map(numeric), part.quarter, part.origin);
  const [x0, y0, x1, y1] = geometry.bounds as Box;
  const exits: Record<string, boolean> = { L: box[0] <= x0, R: box[2] >= x1, T: box[1] <= y0, B: box[3] >= y1 };
  const clashes = [...geometry.refs].filter(([ref, other]) => {
    if (ref === rule.ref) return false;
    const [a, b, c, d] = other.courtyard as Box;
    return Math.min(box[2], c) > Math.max(box[0], a) && Math.min(box[3], d) > Math.max(box[1], b);
  }).map(([ref]) => ref);
  const reaches = exits[rule.exit_side as string] as boolean;
  return {
    miss: clashes.length || !reaches ? 1 : 0,
    detail: {
      measured: clashes.length || !reaches ? 1 : 0, max: 0, margin: clashes.length || !reaches ? -1 : 0,
      corridor_world_mm: box, blocking_refs: clashes, reaches_requested_edge: reaches,
      scope: 'conservative_2d_courtyard_screen; enclosure/harness/3d review remains required',
    },
  };
}

export function evaluate(contract: Contract, geometry: Geometry): { blockers: Dict[]; measurements: Dict[] } {
  const blockers: Dict[] = [], measurements: Dict[] = [];
  const original = contract.geometry;
  for (const rule of contract.rules) {
    if (rule.kind === 'escape') continue;   // Exact native evidence is checked separately, never a pose proxy.
    const { miss, detail } = rule.kind === 'fixed' || rule.kind === 'rigid_group' ? measureMove(rule, original, geometry)
      : rule.kind === 'region' ? measureRegion(rule, geometry) : rule.kind === 'connector_access' ? measureConnector(rule, geometry) : measureDistance(rule, geometry);
    const refs = sortedRefs(rule);
    measurements.push({ id: rule.id, kind: rule.kind, refs, ...detail });
    if (miss) blockers.push({ code: 'constraint_violation', id: rule.id, kind: rule.kind, refs, miss, source: rule.source, ...detail });
  }
  for (const [ref, after] of geometry.refs) {
    const before = original.refs.get(ref) as Part;
    if (before.locked && (!sameValue(before.origin, after.origin) || before.quarter !== after.quarter)) {
      blockers.push({ code: 'native_locked_part_moved', id: `native-lock:${ref}`, refs: [ref], miss: 1, reference: ref, source: contract.native });
    }
  }
  return { blockers, measurements };
}

export function inputsCurrent(inputs: ReadonlyMap<string, string>): void {
  for (const [name, expected] of inputs) if (sha256File(name) !== expected) throw new Error(`engineering input changed: ${name}`);
}

export function reviewedContract(rootPath: string, board: string, manifestPath: string, services: ReviewServices): Contract {
  const root = resolvePath(rootPath), manifest = resolvePath(manifestPath);
  const report = services.verifyManifest(root, board, manifest);
  if (report.status !== 'passed') throw new Error(`part engineering review is incomplete: ${jsonDumps(report.blockers ?? [])}`);
  const { project } = boardConfig(root, board);
  const native = withSuffix(project, '.kicad_pcb');
  const geometry = nativeGeometry(native);
  const { rules, sources, bindings } = normalizedRules(root, (report.constraints ?? {}) as Dict, geometry);
  const inputs = new Map([[manifest, sha256File(manifest)], ...sources]);
  for (const key of ['inputs', 'native_inputs']) {
    for (const [name, value] of Object.entries((report[key] ?? {}) as Dict)) inputs.set(resolveIn(root, name), value as string);
  }
  for (const binding of bindings) {
    if (resolvePath(binding.target) !== native) throw new Error('reviewed block binding targets another native board');
    for (const [name, digest] of readBlock(binding.source_directory).files) inputs.set(joinPath(binding.source_directory, name), digest);
  }
  inputs.set(native, sha256File(native));
  inputsCurrent(inputs);
  const contract: Contract = { schema: SCHEMA, root, board, manifest, native, inputs, rules, geometry, bindings, qualified: false };
  contract.review_sha256 = contractDigest(contract);
  return contract;
}

function escapeChecks(contract: Contract, candidate: string, evidence: string | null | undefined, services: ReviewServices): Dict[] {
  const rules = contract.rules.filter(rule => rule.kind === 'escape');
  if (!rules.length) return [];
  if (!evidence) {
    return [{ code: 'native_escape_evidence_missing', ids: rules.map(rule => rule.id), detail: 'provide exact native escape evidence before placement/routing' }];
  }
  return services.verifyEscapeEvidence(contract, candidate, evidence);
}

function checkCandidate(contract: Contract, native: string): void {
  const signatures = (path: string) => new Map(footprints(path).map(part => [part.props.get('Reference') as string, footprintSignature(part)]));
  if (!sameValue(signatures(native), signatures(contract.native))) throw new Error('candidate part identity, footprint geometry or pad nets changed');
}

export interface CheckOptions { candidate?: string | null; escapeEvidence?: string | null }

export function checkManifest(root: string, board: string, manifest: string, services: ReviewServices, { candidate, escapeEvidence }: CheckOptions = {}) {
  const report: Dict = {
    schema: 'iot-lab.engineering-placement-check.v1', board, qualified: false, scope: 'reviewed_native_placement_screen',
    status: 'blocked', blockers: [], measurements: [], unsupported: [], inputs: {},
  };
  try {
    const contract = reviewedContract(root, board, manifest, services);
    const native = candidate ? resolvePath(candidate) : contract.native;
    const geometry = nativeGeometry(native);
    if (!sameValue([...geometry.refs.keys()].sort(compare), [...contract.geometry.refs.keys()].sort(compare))) {
      throw new Error('candidate native population differs from reviewed source');
    }
    if (candidate) checkCandidate(contract, native);
    const { blockers, measurements } = evaluate(contract, geometry);
    blockers.push(...escapeChecks(contract, native, escapeEvidence, services));
    inputsCurrent(contract.inputs);
    Object.assign(report, {
      status: blockers.length ? 'blocked' : 'passed', blockers, measurements, inputs: contract.inputs, native, candidate_sha256: sha256File(native),
      contract_sha256: fingerprint(hashable(contract)), rules: contract.rules.length,
      reuse: contract.bindings.map(binding => ({ block_id: binding.block_id, instance_path: binding.instance_path, qualification_transferred: false })),
    });
  } catch (error) {
    const text = errorText(error);
    report.status = text.includes('changed') || text.includes('stale') ? 'stale' : 'blocked';
    report.blockers = [{ code: 'engineering_review_required', detail: text }];
    if (text.includes('unsupported')) report.unsupported = [text];
  }
  return report;
}
