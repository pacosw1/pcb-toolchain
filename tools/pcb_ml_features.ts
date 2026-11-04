// Pre-decision measurements from the typed KiCad API. No rule limits, routing outcomes, or engineering scores.
import { statSync } from 'node:fs';
import { arch, endianness, release, type as osType, version as osVersion } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardJson, BOARD_JSON_SCHEMA, pinnedKicadCommit } from './lib/board-json.ts';
import { toMm, tracks, vias, type Board, type BoardDocument, type Pt } from './lib/board-types.ts';
import { dist } from './lib/py-math.ts';
import { withSuffix } from './lib/py-path.ts';
import {
  artifactIdentity, finite, float, isFile, isObject, number, resolve, sha256File, truthy,
  type Bindings, type Obj,
} from './pcb_ml_json.ts';
import type { Features } from './pcb_ml_data.ts';
import { fsum } from './pcb_ml_numeric.ts';

export type Adapter = 'routing' | 'workflow';
export type BoardReader = (path: string) => BoardDocument;
export type Measurements = [Features, Obj[]];
export const ROUTING_FEATURES = [
  ['footprint_count', 'count'], ['pad_count', 'count'], ['declared_net_count', 'count'], ['copper_layer_count', 'count'],
  ['retained_track_count', 'count'], ['retained_via_count', 'count'], ['retained_zone_count', 'count'], ['retained_track_length_mm', 'mm'],
  ['all_net_pad_hpwl_mm', 'mm'], ['all_net_pairwise_distance_sum_mm', 'mm'], ['two_pad_net_count', 'count'],
  ['two_pad_distance_sum_mm', 'mm'], ['two_pad_distance_max_mm', 'mm'], ['edge_bbox_area_mm2', 'mm2'],
] as const;
export const OPERATIONS = ['check', 'build', 'edit', 'route', 'repair', 'release', 'parts', 'placement', 'routing', 'schematic', 'design', 'outcomes', 'blocks', 'readiness', 'ml'];
export const WORKFLOW_FEATURES: readonly (readonly [string, string])[] = [
  ['budget_s', 's'], ['has_project', 'indicator'], ['has_engineering_manifest', 'indicator'], ['has_design_contract', 'indicator'], ['has_from_run', 'indicator'],
  ...OPERATIONS.map(name => [`operation_${name}`, 'indicator'] as const),
];
export const ADDED_LENGTH_DEFINITION: Obj = {
  id: 'iot-lab.api-added-straight-track-length.v1', version: 1, unit: 'mm', direction: 'min',
  formula: 'accepted final API track length minus original retained API track length',
  scope: 'all nets/layers; straight copper centerlines only, excluding pad/zone copper and vertical via length',
  requires: 'complete accepted within-budget controlled run; exact original source and preserved complete API track/via geometry multiset',
};
export const QUANTITY_CONTRACTS: Obj = {
  retained_track_length_mm: { id: 'iot-lab.api-retained-straight-track-length.v1', version: 1, unit: 'mm', source: 'original pre-decision PCB via pinned KiCad API',
    formula: 'sum of supported straight copper segment centerlines; whole-nanometre endpoints converted to mm' },
  added_route_track_length_mm: ADDED_LENGTH_DEFINITION,
};
const tools = dirname(fileURLToPath(import.meta.url));
export const IMPLEMENTATIONS = ['pcb_ml_features.ts', 'pcb_ml_json.ts', 'pcb_ml_numeric.ts', 'lib/board-json.ts', 'lib/board-types.ts',
  'lib/board-edit.ts', 'lib/env.mjs', 'lib/env-paths.mjs', 'lib/project-root.mjs', 'lib/fingerprint.ts', 'lib/json-file.ts', 'lib/py-compat.mjs', 'lib/py-path.ts',
  'lib/py-math.ts', 'lib/sexpr.ts', 'router/core/proto/PIN'];
const runtimeHashes = new Map<string, { stat: string; digest: string }>();
function runtimeDigest(path: string): string {
  const signature = () => { const s = statSync(path, { bigint: true }); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; };
  const stat = signature(), previous = runtimeHashes.get(path);
  if (previous?.stat === stat) return previous.digest;
  const digest = sha256File(path);
  if (signature() !== stat) throw new Error('numeric producer runtime changed while hashing: ' + path);
  runtimeHashes.set(path, { stat, digest }); return digest;
}
export function numericProducer(): Obj {
  return { id: 'iot-lab.pcb-ml-host-numeric-producer.v2', version: 2,
    scope: 'runtime-bound attribution, not portable bitwise equivalence; require frozen runtime and exact replay',
    implementation: 'node', node_build: process.version, v8: process.versions.v8,
    float_abi: { radix: 2, mant_dig: 53, epsilon: float(Number.EPSILON) }, byteorder: endianness(),
    os: { system: osType(), release: release(), build: osVersion(), architecture: arch() },
    binaries: { runtime: { sha256: runtimeDigest(process.execPath) } },
    operations: { coordinates: 'KiCad API whole-nanometre board positions converted to mm', distances: 'shared exact binary64 hypot/distance', reductions: 'error-free partial summation, binary64 round-to-nearest-even' } };
}
export function featureContract(adapter: Adapter): Obj {
  if (adapter !== 'routing' && adapter !== 'workflow') throw new Error('unsupported feature adapter: ' + adapter);
  const result: Obj = { id: 'iot-lab.pcb-ml-predecision.' + adapter, version: adapter === 'routing' ? 5 : 1, adapter,
    features: (adapter === 'routing' ? ROUTING_FEATURES : WORKFLOW_FEATURES).map(([name, unit]) => ({ name, unit })),
    implementation_sha256: Object.fromEntries(IMPLEMENTATIONS.map(name => [`tools/${name}`, sha256File(resolve(tools, name))])) };
  if (adapter === 'routing') Object.assign(result, { quantity_contracts: QUANTITY_CONTRACTS, numeric_producer: numericProducer(),
    board_api: { schema: BOARD_JSON_SCHEMA, kicad_commit: pinnedKicadCommit() } });
  return result;
}
export const boardSources = (path: string): string[] => [path, withSuffix(path, '.kicad_pro'), withSuffix(path, '.kicad_dru')];
export function readBoard(path: string, reader: BoardReader = boardJson): Board {
  const document = reader(path);
  if (document.schema !== BOARD_JSON_SCHEMA || document.kicad_commit !== pinnedKicadCommit() || document.board_sha256 !== sha256File(path)) throw new Error('board JSON schema/source binding differs from requested board or pinned KiCad commit');
  for (const [extension, digest] of [['.kicad_pro', document.project_sha256], ['.kicad_dru', document.rules_sha256]]) {
    const sidecar = withSuffix(path, extension);
    if ((isFile(sidecar) ? sha256File(sidecar) : '') !== digest) throw new Error('board JSON sidecar binding differs from requested source: ' + sidecar);
  }
  return document.board;
}
const point = (p: Pt): [number, number] => {
  if (!p || !Number.isSafeInteger(p.x) || !Number.isSafeInteger(p.y)) throw new Error('invalid API whole-nanometre coordinate');
  return [toMm(p.x), toMm(p.y)];
};
const distance = dist;
const copperLayer = (layer: string): boolean => /^(?:F|B|In[1-9]\d*)\.Cu$/.test(layer);
export interface CopperMetrics { track_length_mm: number | null; copper: Map<string, number> | null; unknowns: Record<string, string> }
export function nativeCopperMetrics(board: Board): CopperMetrics {
  const result: CopperMetrics = { track_length_mm: null, copper: null, unknowns: {} };
  const straight = () => tracks(board).map(track => {
    if (track.mid !== null) throw new Error('copper arc centreline measurement is unsupported');
    if (!Number.isSafeInteger(track.width) || track.width <= 0 || !copperLayer(track.layer)) throw new Error('unsupported track width or copper layer');
    point(track.start); point(track.end); return track;
  });
  try { result.track_length_mm = fsum(straight().map(t => distance(point(t.start), point(t.end)))); }
  catch (error) { result.unknowns.track_length_mm = (error as Error).message; }
  try {
    // v1 omits via layer span/type. Comparing only its diameter/position could falsely prove retention.
    if (vias(board).length) throw new Error('board JSON v1 omits via layer/type fields required for retained-copper proof');
    const geometry = new Map<string, number>();
    for (const track of straight()) {
      if (typeof track.net !== 'string') throw new Error('missing API copper net');
      const ends = [track.start, track.end].sort((a, b) => a.x - b.x || a.y - b.y);
      const key = artifactIdentity({ type: 'segment', net: track.net, ends, width: track.width, layer: track.layer });
      geometry.set(key, (geometry.get(key) ?? 0) + 1);
    }
    result.copper = geometry;
  } catch (error) { result.unknowns.copper = (error as Error).message; }
  return result;
}

function outlineArea(board: Board): number | null {
  const outline: [number, number][] = [];
  if (board.footprints.some(fp => fp.graphics.some(g => g.layer === 'Edge.Cuts'))) return null;
  for (const graphic of board.graphics.filter(g => g.layer === 'Edge.Cuts')) {
    const geometry = graphic.geometry;
    if (geometry === 'Other') return null;
    if ('Segment' in geometry) outline.push(point(geometry.Segment.start), point(geometry.Segment.end));
    else if ('Rect' in geometry) outline.push(point(geometry.Rect.top_left), point(geometry.Rect.bottom_right));
    else if ('Poly' in geometry && geometry.Poly.rings.length && geometry.Poly.rings.every(ring => ring.length)) outline.push(...geometry.Poly.rings.flatMap(ring => ring.map(point)));
    else return null;
  }
  if (!outline.length) return null;
  const xs = outline.map(p => p[0]), ys = outline.map(p => p[1]);
  return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
}
export function routingFeatures(board: Board): Measurements {
  const pads = board.footprints.flatMap(fp => fp.pads), groups = new Map<string, [number, number][]>(), reasons: Obj[] = [];
  let geometryKnown = true;
  for (const pad of pads) {
    if (!pad.net) continue;
    try {
      const center = point(pad.position);
      if (!groups.has(pad.net)) groups.set(pad.net, []);
      groups.get(pad.net)!.push(center);
    } catch (error) { geometryKnown = false; reasons.push({ code: 'pad_center_unknown', cause: (error as Error).message }); }
  }
  const hpwl: number[] = [], twoPad: number[] = [];
  for (const group of groups.values()) {
    const xs = group.map(p => p[0]), ys = group.map(p => p[1]);
    hpwl.push(Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys));
    if (group.length === 2) twoPad.push(distance(group[0], group[1]));
  }
  function* pairwise(): Generator<number> {
    for (const group of groups.values()) for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) yield distance(group[i], group[j]);
  }
  let area: number | null = null;
  try { area = outlineArea(board); } catch { /* unsupported outline remains unknown */ }
  const length = nativeCopperMetrics(board).track_length_mm;
  const values: Features = { footprint_count: board.footprints.length, pad_count: pads.length,
    declared_net_count: new Set([...Object.keys(board.nets), ...pads.map(p => p.net)].filter(Boolean)).size,
    copper_layer_count: board.copper_layers.length, retained_track_count: tracks(board).length,
    retained_via_count: vias(board).length, retained_zone_count: board.zones.length,
    retained_track_length_mm: length === null ? null : float(length), all_net_pad_hpwl_mm: geometryKnown ? float(fsum(hpwl)) : null,
    all_net_pairwise_distance_sum_mm: geometryKnown ? float(fsum(pairwise())) : null,
    two_pad_net_count: geometryKnown ? twoPad.length : null, two_pad_distance_sum_mm: geometryKnown ? float(fsum(twoPad)) : null,
    two_pad_distance_max_mm: geometryKnown ? float(Math.max(0, ...twoPad)) : null, edge_bbox_area_mm2: area === null ? null : float(area) };
  for (const [feature] of ROUTING_FEATURES) if (values[feature] === null) reasons.push({ code: 'feature_unknown', feature, cause: 'native geometry or field is missing or unsupported' });
  return [values, reasons];
}
export function workflowFeatures(manifest: unknown): Measurements {
  if (!isObject(manifest)) throw new Error('workflow source must be a run manifest');
  const budget = manifest.timeout_s, operation = manifest.operation, known = OPERATIONS.includes(operation as string);
  const values: Features = { budget_s: finite(budget) && number(budget) > 0 ? budget : null,
    has_project: Number(truthy(manifest.project)), has_engineering_manifest: Number(truthy(manifest.engineering_manifest)),
    has_design_contract: Number(truthy(manifest.design_contract)), has_from_run: Number(truthy(manifest.from_run)),
    ...Object.fromEntries(OPERATIONS.map(name => [`operation_${name}`, known ? Number(operation === name) : null])) };
  return [values, Object.entries(values).filter(([, value]) => value === null).map(([feature]) => ({ code: 'feature_unknown', feature, cause: 'pre-run field is missing or unsupported' }))];
}
export function workflowCase(manifest: Obj): string {
  const value = Object.fromEntries(['operation', 'board', 'project', 'kind', 'router', 'spec', 'arguments'].map(name => [name, manifest[name] ?? null]));
  for (const name of ['engineering_manifest', 'design_contract', 'plan']) {
    const descriptor = manifest[name];
    value[name] = isObject(descriptor) ? Object.fromEntries(['sha256', 'content'].map(key => [key, descriptor[key] ?? null])) : descriptor ?? null;
  }
  value.from_run = isObject(manifest.from_run) ? manifest.from_run.result_sha256 ?? null : null;
  return artifactIdentity(value);
}
export function implementationInputs(): Bindings {
  return Object.fromEntries([...IMPLEMENTATIONS.map(name => [resolve(tools, name), sha256File(resolve(tools, name))]), [resolve('/', process.execPath), runtimeDigest(process.execPath)]]);
}
