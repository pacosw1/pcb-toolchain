// A reviewed engineering contract on a placement problem. prepareProblem attaches it, checkProblem screens a pose under it
// and refuses a model that changed. The search itself runs in Rust (core/src/engineering.rs) on a model verified here.
//
// A problem is read with readTyped, so a whole float stays a Float and the anchor hash keeps its bytes.
import { verifyBinding } from '../lib/block-bindings.ts';
import { contractDigest, evaluate, exactTree, inputsCurrent, point, reviewedContract, transformedBox, type Contract, type Geometry, type Part, type ReviewServices, type Rule } from '../lib/engineering-constraints.ts';
import { fingerprint } from '../lib/fingerprint.ts';
import { parseTyped } from '../lib/json-file.ts';
import { verifyManifest } from '../lib/part-review.ts';
import { Float, jsonDumps, number } from '../lib/py-compat.mjs';
import { pyMod } from '../lib/py-math.ts';
import { resolvePath } from '../lib/py-path.ts';
import type { Dict } from '../lib/py-values.ts';
import { verifyEscapeEvidence } from '../lib/route-decision-escape.ts';
import { deepCopy, type Pose, type Problem } from './compact-geometry.ts';

/** The reviewed contract as a problem file holds it, with its anchors. */
export interface ContractRecord extends Dict {
  root: string; board: string; manifest: string; native: string;
  rules: Dict[]; inputs: Dict; geometry: Dict; bindings: Dict[];
  where: Record<string, number>; model_anchor_sha256: string; review_sha256: string;
}

export type ReviewedProblem = Problem & { board_file: string; engineering?: ContractRecord };

export interface Screen { status: string; qualified: false; blockers: Dict[]; measurements?: Dict[]; coverage?: string }

const plain = (value: unknown): Dict => JSON.parse(jsonDumps(value)) as Dict;

export const reviewServices: ReviewServices = {
  verifyManifest: (root, id, path) => plain(verifyManifest(root, id, path)),
  verifyEscapeEvidence: (contract, candidate, evidence) => verifyEscapeEvidence(plain(contract) as never, candidate, evidence) as unknown as Dict[],
};

const plainNumber = (value: unknown): number => number(value as number | Float);

const point2 = (value: unknown): [number, number] => {
  const [x, y] = (value as unknown[]).map(plainNumber);
  return [x as number, y as number];
};

function partOf(row: Dict): Part {
  const pads = Object.entries(row.pads as Dict).map(([name, rows]) => [name, (rows as Dict[]).map(pad => ({
    ...pad, center: point2(pad.center), size: point2(pad.size),
  }))] as const);
  const courtyard = row.courtyard as unknown[] | null;
  return {
    origin: point2(row.origin), quarter: plainNumber(row.quarter), pads: new Map(pads) as unknown as Part['pads'], locked: row.locked as boolean,
    courtyard: courtyard ? courtyard.map(plainNumber) as Part['courtyard'] : null,
  };
}

/** The contract of a problem file in the form the screens take. */
export function loadContract(record: ContractRecord): Contract {
  const { refs, bounds } = record.geometry as { refs: Dict; bounds: unknown[] | null };
  return {
    schema: record.schema as string, root: record.root, board: record.board, manifest: record.manifest, native: record.native,
    inputs: new Map(Object.entries(record.inputs) as [string, string][]), rules: exactTree(record.rules) as Rule[],
    geometry: {
      refs: new Map(Object.entries(refs).map(([ref, row]) => [ref, partOf(row as Dict)])),
      bounds: bounds ? bounds.map(plainNumber) as Geometry['bounds'] : null,
    },
    bindings: record.bindings as never, qualified: false, review_sha256: record.review_sha256,
  };
}

export const modelAnchor = (problem: Problem): string => fingerprint({
  units: problem.units.map(({ name, refs, x, y, fixed }) => ({ name, refs, x, y, fixed })), outline: problem.board.outline,
});

const whereOf = (problem: Problem): Record<string, number> => Object.fromEntries(problem.units.flatMap((unit, i) => (unit.refs ?? []).map(ref => [ref, i])));

const partCount = (problem: Problem): number => problem.units.reduce((sum, unit) => sum + (unit.refs?.length ?? 0), 0);

function splitGroup(contract: { rules: readonly { kind?: unknown; refs?: unknown }[] }, where: Record<string, number>): boolean {
  return contract.rules.some(rule => rule.kind === 'rigid_group' && new Set((rule.refs as string[]).map(ref => where[ref])).size !== 1);
}

/** The reviewed part groups a read must keep whole. */
export const rigidGroups = (contract: Contract): string[][] => contract.rules.filter(rule => rule.kind === 'rigid_group').map(rule => rule.refs as string[]);

function geometryForPose(problem: Problem, contract: Contract, where: Record<string, number>, pose: Pose): Geometry {
  const refs = new Map<string, Part>();
  for (const [ref, source] of contract.geometry.refs) {
    const i = where[ref] as number;
    const unit = problem.units[i], at = pose[i];
    if (!unit || !at) throw new Error('invalid engineering placement pose');
    const [x, y, q] = at.map(plainNumber) as [number, number, number];
    if (![0, 1, 2, 3].includes(q) || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error('invalid engineering placement pose');
    const ox = plainNumber(unit.x), oy = plainNumber(unit.y);
    const moved = ([a, b]: readonly number[]) => point((a as number) - ox, (b as number) - oy, q, [x, y]);
    const pads = [...source.pads].map(([name, rows]) => [name, rows.map(pad => ({
      ...pad, center: moved(pad.center), size: q % 2 ? [...pad.size].reverse() : pad.size,
    }))] as const);
    const box = source.courtyard;
    refs.set(ref, {
      ...source, origin: moved(source.origin), quarter: pyMod(source.quarter + q, 4), pads: new Map(pads),
      courtyard: box ? transformedBox([box[0] - ox, box[1] - oy, box[2] - ox, box[3] - oy], q, [x, y]) : null,
    });
  }
  return { refs, bounds: contract.geometry.bounds };
}

const trusted = new Map<string, Contract>();

function verifyOriginalSources(contract: Contract, record: ContractRecord, services: ReviewServices): void {
  inputsCurrent(contract.inputs);
  const key = JSON.stringify([record.root, record.board, record.manifest]);
  const review = trusted.get(key) ?? reviewedContract(record.root, record.board, record.manifest, services);
  trusted.set(key, review);
  inputsCurrent(review.inputs);
  if (contractDigest(contract) !== review.review_sha256) throw new Error('engineering model differs from the actual reviewed source contract');
  for (const binding of contract.bindings) verifyBinding(binding);
}

export interface CheckOptions { verifySources?: boolean; services?: ReviewServices }

/** Screens a pose, by default the places in the file. With verifySources false only the model itself is checked. */
export function checkProblem(problem: ReviewedProblem, pose: Pose | null = null, options: CheckOptions = {}): Screen {
  const { verifySources = true, services = reviewServices } = options;
  const record = problem.engineering;
  if (!record) return { status: 'legacy_unreviewed', qualified: false, blockers: [], coverage: 'no reviewed engineering constraints attached' };
  const contract = loadContract(record);
  if (contractDigest(contract) !== record.review_sha256) throw new Error('reviewed engineering contract payload changed');
  if (resolvePath(problem.board_file) !== record.native) throw new Error('engineering model source differs from the reviewed native board');
  if (modelAnchor(problem) !== record.model_anchor_sha256) throw new Error('engineering placement model anchors changed');
  const where = whereOf(problem);
  if (fingerprint(where) !== fingerprint(record.where) || partCount(problem) !== Object.keys(where).length) {
    throw new Error('engineering model reference-to-unit mapping changed');
  }
  if (verifySources) verifyOriginalSources(contract, record, services);
  if (splitGroup(contract, where)) throw new Error('engineering rigid group was split before search/write');
  const places = pose ?? problem.units.map(unit => [unit.x, unit.y, 0]);
  if (places.length !== problem.units.length) throw new Error('placement pose cardinality differs from reviewed model');
  const { blockers, measurements } = evaluate(contract, geometryForPose(problem, contract, where, places));
  return { status: blockers.length ? 'blocked' : 'passed', qualified: false, blockers, measurements };
}

/** The contract as the problem file will hold it. */
const contractRecord = (contract: Contract): ContractRecord => parseTyped(jsonDumps(contract));

/** The problem with its reviewed contract attached. A geometric failure is what a search may repair: it does not stop here. */
export function prepareProblem(root: string, board: string, manifest: string, problem: ReviewedProblem, services: ReviewServices = reviewServices): ReviewedProblem {
  const contract = reviewedContract(root, board, manifest, services);
  if (resolvePath(problem.board_file) !== contract.native) throw new Error('placement model belongs to another native source');
  const out = deepCopy(problem);
  const where = whereOf(out);
  const population = [...contract.geometry.refs.keys()].sort();
  if (fingerprint(Object.keys(where).sort()) !== fingerprint(population) || partCount(out) !== population.length) {
    throw new Error('placement model differs from exact reviewed native population');
  }
  for (const rule of contract.rules) {
    if (rule.kind === 'rigid_group' && new Set((rule.refs as string[]).map(ref => where[ref])).size !== 1) {
      throw new Error(`reviewed rigid group must be read as one intact placement unit: ${rule.id}`);
    }
    if (rule.kind === 'fixed' || rule.retained_internal_copper) {
      for (const ref of rule.refs as string[]) (out.units[where[ref] as number] as { fixed: boolean }).fixed = true;
    }
  }
  const record = contractRecord(contract);
  record.where = where;
  record.model_anchor_sha256 = modelAnchor(out);
  out.engineering = record;
  record.initial_screen = checkProblem(out, null, { verifySources: false, services });
  return out;
}
