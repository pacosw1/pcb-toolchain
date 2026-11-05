// What pcbtool reads from reference-planes.json: the grounds and their domains, and which nets may use a mixed plane layer. The
// rules are those of the reference gate (tools/si_planes.ts). This reader checks the keys and the
// sections it uses and stops on a bad one, fail closed; alt_refs, exempt, edge_classes, receivers and offboard stay the gate's.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { polygonsContain } from './board-hit.ts';
import { netRules, type ProjectFile } from './board-obstacles.ts';
import type { Board } from './board-types.ts';
import type { Obstacle, Obstacles, Shape } from './copper-gap.ts';
import { fnmatchCase } from './fnmatch.ts';
import { readJson } from './json-file.ts';
import { CommandFailure } from './pcbtool-cli.ts';
import { pyRepr } from './py-compat.mjs';
import { OTHER_SIDE } from './route-spec.ts';

export type NetKind = 'fast' | 'power' | 'slow';
/** Kind of a net on each mixed layer. */
export type MixedKinds = Record<string, NetKind>;

interface MixedLayer { allow: 'slow'; fast_file: string; power: string[]; reason: string; fast: string[] }
export interface PlanesSpec {
  adjacent: Record<string, string>; plane_layers: string[]; grounds: string[]; domains: Record<string, string[]>;
  mixed_layers: Record<string, MixedLayer>;
}

const REQUIRED = ['about', 'adjacent', 'plane_layers', 'grounds'];
const NUMBERS = ['via_allow_mm', 'step_mm'];
const KEYS = new Set([...REQUIRED, ...NUMBERS, 'alt_refs', 'domains', 'exempt', 'mixed_layers', 'fast_file', 'power', 'edge_classes', 'receivers', 'offboard', 'schematic']);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isTexts = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const isEmpty = (value: unknown): boolean => !value || (Array.isArray(value) && !value.length) || (isObject(value) && !Object.keys(value).length);

/** The keys and sections of a spec, or why it is refused. */
function specProblem(raw: unknown): string | null {
  if (!isObject(raw)) return 'spec must be a JSON object';
  const unknown = Object.keys(raw).filter(key => !KEYS.has(key)).sort();
  if (unknown.length) return `unknown spec keys: ${pyRepr(unknown)}`;
  // plane_layers may be empty: a 2-layer board has no plane layer.
  const missing = REQUIRED.filter(key => !(key in raw) || (key !== 'plane_layers' && isEmpty(raw[key])));
  if (missing.length) return `missing spec keys: ${pyRepr(missing)}`;
  for (const key of NUMBERS) {
    if (key in raw && !(typeof raw[key] === 'number' && Number.isFinite(raw[key]) && raw[key] > 0)) return `${key} must be a number > 0`;
  }
  if (!isObject(raw.adjacent) || !Array.isArray(raw.plane_layers) || !Array.isArray(raw.grounds)) return 'adjacent must be an object; plane_layers and grounds must be lists';
  for (const [ground, patterns] of Object.entries(raw.domains as object ?? {})) {
    if (!raw.grounds.includes(ground) || !Array.isArray(patterns)) return `domains ${ground}: key must be a ground, value a list of net patterns`;
  }
  for (const [layer, mixed] of Object.entries(raw.mixed_layers as object ?? {})) {
    if (!raw.plane_layers.includes(layer) || !isObject(mixed)) return `mixed_layers ${layer}: must be a plane layer with an object value`;
    if (mixed.allow !== 'slow' || typeof mixed.fast_file !== 'string' || !mixed.fast_file) return `mixed_layers ${layer}: needs "allow": "slow" and "fast_file"`;
    if (!isTexts(mixed.power)) return `mixed_layers ${layer}: "power" must be a list of net patterns`;
    if (typeof mixed.reason !== 'string' || !mixed.reason.trim()) return `mixed_layers ${layer}: a written reason is required`;
  }
  return null;
}

const isFile = (file: string): boolean => existsSync(file) && statSync(file).isFile();

/** The "fast" patterns of a mixed layer's fast file. */
function fastPatterns(layer: string, file: string): string[] {
  if (!isFile(file)) throw new Error(`mixed_layers ${layer}: no fast net file ${file}`);
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const patterns = isObject(raw) ? raw.fast : null;
  if (!isTexts(patterns) || !patterns.length) throw new Error(`${file}: "fast" must be a list of net patterns`);
  return patterns;
}

/** The spec with the fast patterns of its mixed layers. A bad spec or fast file stops the tool: fail closed. */
export function readPlanes(file: string): PlanesSpec {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const problem = specProblem(raw);
    if (problem) throw new Error(problem);
    const spec = raw as Omit<PlanesSpec, 'mixed_layers' | 'domains'> & { mixed_layers?: Record<string, Omit<MixedLayer, 'fast'>> | null; domains?: Record<string, string[]> | null; fast_file?: unknown };
    const folder = dirname(resolve(file));
    const mixed = Object.entries(spec.mixed_layers ?? {}).map(([layer, entry]) => [layer, { ...entry, fast: fastPatterns(layer, join(folder, entry.fast_file)) }]);
    if (typeof spec.fast_file === 'string' && spec.fast_file) {
      const named = join(folder, spec.fast_file);
      if (!isFile(named)) throw new Error(`fast_file: no fast net file ${named}`);
      JSON.parse(readFileSync(named, 'utf8'));
    }
    return { ...spec, domains: spec.domains ?? {}, mixed_layers: Object.fromEntries(mixed) };
  } catch (error) {
    throw new CommandFailure(`${file}: ${(error as Error).message}`);
  }
}

/** The kind of a net on a mixed layer. Every ground is power. */
export function netKind(net: string, layer: MixedLayer, spec: PlanesSpec): NetKind {
  if (layer.fast.some(pattern => fnmatchCase(net, pattern))) return 'fast';
  if (spec.grounds.includes(net) || layer.power.some(pattern => fnmatchCase(net, pattern))) return 'power';
  return 'slow';
}

/** The kinds of a net on the mixed layers of a spec. A net of the POWER class is power too. */
export function kindsOf(net: string, spec: PlanesSpec, project: ProjectFile): MixedKinds {
  return Object.fromEntries(Object.entries(spec.mixed_layers).map(([layer, mixed]) => {
    const kind = netKind(net, mixed, spec);
    return [layer, kind === 'slow' && netRules(project, net).className === 'POWER' ? 'power' : kind];
  }));
}

/** kindsOf from a spec file. No file means no mixed layer. */
export const mixedKinds = (net: string, planes: string, project: ProjectFile): MixedKinds => (existsSync(planes) ? kindsOf(net, readPlanes(planes), project) : {});

/** Why `net` may not use these layers, or null. F.Cu and B.Cu are always allowed; a mixed layer only for a slow net. */
export function layersError(net: string, layers: string[], mixed: MixedKinds): string | null {
  for (const layer of layers) {
    if (layer in OTHER_SIDE) continue;
    const kind = mixed[layer];
    if (kind === undefined) return `${layer} is not a routing layer (F.Cu, B.Cu, or a mixed layer of reference-planes.json)`;
    if (kind !== 'slow') return `${net} is a ${kind} net: ${layer} is for slow nets only (reference-planes.json mixed_layers)`;
  }
  return null;
}

export interface NetShape { net: string; shape: Shape }

/**
 * What keeps ground fill of the mixed layer under every fast track on the outer layer `under` (the gate rule fast-unreferenced). A net
 * on the mixed layer keeps `clearance` from the fast tracks on `under`; a fast net on `under` keeps it from the other nets' tracks on
 * the mixed layer. `clearance` is the fill clearance of the ground zone.
 */
export function referenceObstacles(net: string, kind: NetKind, layers: string[], mixed: string, under: string, fast: NetShape[], onMixed: NetShape[], clearance: number): Obstacles {
  const out: Obstacles = {};
  const others = (list: NetShape[], label: (other: string) => string): Obstacle[] =>
    list.filter(item => item.net !== net).map(item => ({ shape: item.shape, clearance, label: label(item.net) }));
  if (layers.includes(mixed)) {
    const found = others(fast, other => `fast ref ${under} ${other}`);
    if (found.length) out[mixed] = found;
  }
  if (kind === 'fast' && layers.includes(under)) {
    const found = others(onMixed, other => `${mixed} track ${other}`);
    if (found.length) out[under] = found;
  }
  return out;
}

export const planesPath = (pcb: string, planes: string | null | undefined): string => planes ?? join(dirname(resolve(pcb)), '..', '..', 'reference-planes.json');

export interface GroundSpec { grounds: string[]; domains: Record<string, string[]> }

/** Grounds and domain patterns of a planes file, without its checks. No file: GND alone. */
export function groundSpec(file: string): GroundSpec {
  if (!existsSync(file)) return { grounds: ['GND'], domains: {} };
  const { grounds, domains } = readJson<GroundSpec>(file);
  return { grounds, domains: domains ?? {} };
}

/** A net's ground domain, as the reference gate finds it: a ground, a spec pattern, then the ground holding most of its pads. */
export function netDomain(net: string, padGrounds: (string | null)[], grounds: string[], patterns: Record<string, string[]>): string | null {
  if (grounds.includes(net)) return net;
  for (const [ground, globs] of Object.entries(patterns)) {
    if (globs.some(glob => fnmatchCase(net, glob))) return ground;
  }
  const counts = new Map<string, number>();
  for (const ground of padGrounds) if (ground) counts.set(ground, (counts.get(ground) ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1]);
  if (top.length && (top.length === 1 || top[0]![1] > top[1]![1])) return top[0]![0];
  return grounds.length === 1 ? grounds[0]! : null;
}

/** Per pad of the net: the ground whose zone outline holds the pad centre, else null. */
export function padGrounds(board: Board, net: string, grounds: string[]): (string | null)[] {
  const zones = board.zones.filter(zone => !zone.rule_area && grounds.includes(zone.net));
  return board.footprints.flatMap(footprint => footprint.pads).filter(pad => pad.net === net)
    .map(pad => zones.find(zone => polygonsContain(zone.outline, pad.position))?.net ?? null);
}

/** A pour of the net's own ground domain costs; any other pour blocks: the isolation barrier, every ground when the domain is unknown. */
export const pourRule = (zoneNet: string, domain: string | null): 'cost' | 'block' => (domain !== null && zoneNet === domain ? 'cost' : 'block');
