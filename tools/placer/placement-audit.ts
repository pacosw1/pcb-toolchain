// Attributed placement diagnostics; no automatic score tuning or board promotion. placement_audit.py stays for
// tools/placement_outcomes.py, which still takes spearman and archive from it.
//
// identity is the hash of Python's json.dumps(sort_keys=True). A whole float only keeps its .0 as a Float, so what is
// hashed must come from readTyped, or from compact.ts, which keeps those types. JSON.parse would make 1.0 an int: other bytes.
import { identity } from '../lib/fingerprint.ts';
import { readPyJson, sha256File } from '../lib/json-file.ts';
import { Float, number, PyError, sorted, truthy } from '../lib/py-compat.mjs';
import { hypot, pyMod } from '../lib/py-math.ts';
import { caught, isFile, joinPath } from '../lib/py-path.ts';
import type { Dict } from '../lib/py-values.ts';
import type { Num, Pose, Problem } from './compact.ts';

export { identity };
export const digest = sha256File;

const FIXED_TOLERANCE_MM = 1e-6;
const CONGESTION_HINT_MM = 0.25;
const UPDATE_LIMIT_MM = 0.5;
const MAX_REFS_PER_UPDATE = 8;
const SEEDED_FORBIDDEN = ['p_swap', 'p_rot', 'global', 'rotate', 'legal_rotate'];

export interface Movement { unit: string; refs: string[]; fixed: boolean; displacement_mm: Float; turn_delta: Num }
export type Params = Record<string, unknown>;
export interface AuditCandidate {
  pose: Pose; cost: Num; illegal: string[]; timeout?: unknown; components?: unknown; prelegal_pose?: Pose | null; mains?: unknown[];
  [key: string]: unknown;
}
type Hints = Record<string, number>;

const malformed = () => new PyError('ValueError', 'nonfinite or malformed pose');

/** An int minus an int stays an int, so the record prints as Python's does. */
function turnDelta(before: Num, after: Num): Num {
  const delta = pyMod(number(after) - number(before), 4);
  return before instanceof Float || after instanceof Float ? new Float(delta) : delta;
}

/** Per unit: how far `pose` is from `baseline`, by default the place in the problem. */
export function movement(pr: Problem, pose: Pose, baseline: Pose | null = null): Movement[] {
  const before: Pose = baseline?.length ? baseline : pr.units.map(unit => [unit.x, unit.y, 0]);
  if (pose.length !== pr.units.length || before.length !== pose.length) throw new PyError('ValueError', 'pose/unit cardinality mismatch');
  return pr.units.map((unit, index) => {
    const [a, b] = [before[index], pose[index]];
    if (b.length !== 3 || !b.every(value => Number.isFinite(number(value)))) throw malformed();
    const displacement = hypot(number(b[0]) - number(a[0]), number(b[1]) - number(a[1]));
    return { unit: unit.name, refs: unit.refs ?? [], fixed: truthy(unit.fixed), displacement_mm: new Float(displacement), turn_delta: turnDelta(a[2], b[2]) };
  });
}

function movementFaults(rows: Movement[], seeded: boolean, maxDisplacement: number | null): string[] {
  return rows.flatMap(row => {
    const moved = row.displacement_mm.value;
    return [
      ...(row.fixed && (moved > FIXED_TOLERANCE_MM || truthy(row.turn_delta)) ? [`fixed unit moved: ${row.unit}`] : []),
      ...(seeded && truthy(row.turn_delta) ? [`seeded turn changed: ${row.unit}`] : []),
      ...(maxDisplacement !== null && moved > maxDisplacement + FIXED_TOLERANCE_MM ? [`displacement cap exceeded: ${row.unit}`] : []),
    ];
  });
}

const samePlace = (a: Num[], b: Num[]): boolean => number(a[0]) === number(b[0]) && number(a[1]) === number(b[1]);

/** Two units that took each other's anchors: a swap the seeded policy does not allow. */
function swapFaults(pr: Problem, pose: Pose): string[] {
  const anchors = pr.units.map(unit => [unit.x, unit.y]);
  const faults: string[] = [];
  anchors.forEach((a, i) => {
    for (let j = 0; j < i; j++) {
      const b = anchors[j];
      if (!samePlace(a, b) && samePlace(pose[i], b) && samePlace(pose[j], a)) faults.push(`seeded units swapped: ${pr.units[i].name}/${pr.units[j].name}`);
    }
  });
  return faults;
}

function constraints(pr: Problem, candidate: AuditCandidate, rows: Movement[]): Dict {
  const count = (value: unknown) => ((value ?? []) as unknown[]).length;
  return {
    problem_sha256: identity(pr), fixed_units: rows.filter(row => row.fixed).map(row => row.unit),
    fixed_copper_items: count(pr.board.fixed_copper), keepout_areas: count(pr.board.keepouts), via_keepout_areas: count(pr.board.via_keepouts),
    edge_clearance_mm: pr.board.edge_clearance ?? null, route_rules: pr.route_rules ?? null,
    functional_groups: pr.units.filter(unit => (unit.refs ?? []).length > 1).length,
    via_nets: pr.via_nets ?? [], mains_faults: candidate.mains ?? [], domain_areas: count(pr.domain_areas), class_gaps: pr.class_gaps ?? null,
    decoupling_pairs: count(pr.decaps), unsupported: pr.dru_ignored ?? [], note: 'native preflight and full gate remain mandatory',
  };
}

export function candidateReport(pr: Problem, candidate: AuditCandidate, params: Params, seeded = false, maxDisplacement: number | null = null): Dict {
  const rows = movement(pr, candidate.pose);
  const faults = [
    ...(candidate.illegal ?? []),
    ...(truthy(candidate.timeout) ? ['incomplete placement'] : []),
    ...movementFaults(rows, seeded, maxDisplacement),
    ...(seeded && SEEDED_FORBIDDEN.some(key => truthy(params[key] ?? 0)) ? ['seeded policy incompatible with actual search parameters'] : []),
    ...(seeded ? swapFaults(pr, candidate.pose) : []),
  ];
  const before = candidate.prelegal_pose ?? null;
  return {
    candidate_sha256: identity({ pose: candidate.pose, problem: pr, params }), components: candidate.components ?? null, params, movement: rows,
    legalizer_movement: before === null ? null : movement(pr, candidate.pose, before), illegal: faults, qualified: false,
    constraints: constraints(pr, candidate, rows),
  };
}

function routeRecords(folder: string): [Dict, Dict] | null {
  try {
    return [readPyJson<Dict>(joinPath(folder, 'input-manifest.json')), readPyJson<Dict>(joinPath(folder, 'outcome.json'))];
  } catch (error) {
    if (caught(error, 'OSError', 'ValueError')) return null;
    throw error;
  }
}

function hintSources(folder: string, congestion: boolean): { additions: Map<string, number>; sources: Record<string, string> } {
  const additions = new Map<string, number>();
  const sources: Record<string, string> = {};
  const escape = joinPath(folder, 'pin-escape.json');
  if (isFile(escape)) {
    for (const [ref, value] of Object.entries(readPyJson<Dict>(escape).halo_hint ?? {})) additions.set(ref, number(value));
    sources[escape] = digest(escape);
  }
  const triage = joinPath(folder, 'open-triage.json');
  if (congestion && isFile(triage)) {
    for (const connection of (readPyJson<Dict>(triage).connections ?? []) as Dict[]) {
      if (connection.class !== 'ENCLOSED') continue;
      for (const ref of (connection.blocking_parts ?? []) as string[]) additions.set(ref, Math.max(additions.get(ref) ?? 0, CONGESTION_HINT_MM));
    }
    sources[triage] = digest(triage);
  }
  return { additions, sources };
}

/** Only complete, clean native results on this exact candidate may teach hints. Gives [hints, evidence]. */
export function boundedFeedback(pr: Problem, routeDir: string, boardSha256: string, prior: Hints, capMm: number, congestion = false): [Hints, Dict] {
  const records = routeRecords(routeDir);
  if (records === null) return [{ ...prior }, { accepted: false, reason: 'missing complete attributed evidence' }];
  const [manifest, outcome] = records;
  const routed = joinPath(routeDir, 'routed.kicad_pcb');
  if (manifest.board_sha256 !== boardSha256 || outcome.status !== 'complete' || outcome.errors !== 0 || !isFile(routed) || outcome.board_sha256 !== digest(routed)) {
    return [{ ...prior }, { accepted: false, reason: 'candidate mismatch, incomplete or native errors' }];
  }
  const allowed = new Set(pr.units.filter(unit => !truthy(unit.fixed)).flatMap(unit => unit.refs ?? [unit.name]));
  const { additions, sources } = hintSources(routeDir, congestion);
  const out = { ...prior };
  for (const ref of (sorted([...additions.keys()].filter(key => allowed.has(key))) as string[]).slice(0, MAX_REFS_PER_UPDATE)) {
    const value = additions.get(ref) as number;
    if (Number.isFinite(value) && value > 0) out[ref] = Math.min(capMm, (out[ref] ?? 0) + Math.min(value, UPDATE_LIMIT_MM));
  }
  const hints = Object.fromEntries(Object.entries(out).map(([ref, value]) => [ref, new Float(value)]));
  return [out, {
    accepted: true, source_board_sha256: boardSha256, sources, cap_mm: new Float(capMm), per_update_limit_mm: UPDATE_LIMIT_MM,
    max_refs_per_update: MAX_REFS_PER_UPDATE, hints, note: 'bounded soft spacing; never relaxes native constraints or moves fixed units',
  }];
}

/** Sort key of a candidate: a legal, complete one first, however low the score of another. */
export const candidateKey = (candidate: AuditCandidate): number[] =>
  [candidate.illegal.length, Number(truthy(candidate.timeout)), (candidate.mains ?? []).length, number(candidate.cost)];

/** For candidates.sort: the order of Python's sort(key=candidate_key). */
export function compareCandidates(a: AuditCandidate, b: AuditCandidate): number {
  const [x, y] = [candidateKey(a), candidateKey(b)];
  const at = x.findIndex((value, index) => value !== y[index]);
  return at < 0 ? 0 : x[at] - y[at];
}
