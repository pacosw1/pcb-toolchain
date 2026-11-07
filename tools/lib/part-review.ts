// Source-bound review of native part use. A verified review establishes only its explicit engineering facts; stock,
// ERC/DRC, assembly, release and qualification are separate.
//
// Manifests stay in the values jsonLoads gives: facts_sha256 is a hash over them, and 1.0 must stay 1.0. A review checks
// every part and reports all blockers; only a malformed manifest stops it.
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIso } from './iso-time.ts';
import { KINDS } from './engineering-constraints.ts';
import { atomicJson } from './json-file.ts';
import { digest, encoded, owned, readBoard, type Blocker as NativeBlocker, type PartFacts } from './part-native.ts';
import { registryRevision, sha } from './pcb-workflow.ts';
import { pdfPages } from './pdf-evidence.ts';
import { Float, get, item, jsonDumps, jsonLoads, number, osError, PyError, sorted, strip, truthy, typeName } from './py-compat.mjs';
import { caught, isFile, jsonOf, relativeTo, resolvePath, joinPath } from './py-path.ts';
import { deepCopy, fullMatch, isDict, iterate, pyEquals, sortKeys, type Dict } from './py-dict.ts';

export const SCHEMA = 'iot-lab.part-evidence.v1';
export const MANIFEST = 'iot-lab.part-use.v1';
export const PROFILE = 'iot-lab.part-profile.v1';
export const CONSTRAINTS = 'iot-lab.engineering-constraints.v1';

const BOARD_ID = /^[A-Z0-9][A-Z0-9-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const LCSC = /^C[0-9]+$/;
const DEPENDENCY_KINDS = new Set(['mate', 'contact', 'harness', 'battery', 'other']);
const REGISTRY = 'hardware-design/registry/boards.json';
const MANIFEST_FIELDS = ['schema', 'board', 'revision', 'project', 'spec', 'review', 'parts', 'budgets'];
const PART_FIELDS = ['reference', 'mpn', 'lcsc', 'manufacturer', 'package', 'datasheets', 'native', 'ratings', 'layout_constraints', 'assembly_dependencies', 'unresolved'];
const PROFILE_FIELDS = ['schema', 'review', 'mpn', 'lcsc', 'manufacturer', 'package', 'datasheets', 'native', 'ratings', 'layout_constraints', 'assembly_dependencies', 'unresolved'];
const USE_FIELDS = ['pad_net_map', 'required', 'conditions', 'refs', 'layout_constraints', 'assembly_dependencies', 'unresolved'];
const NATIVE_FIELDS: [keyof PartFacts, string][] = [
  ['symbol_sha256', 'native_asset_mismatch'], ['pin_map', 'pin_map_mismatch'], ['footprint', 'native_asset_mismatch'],
  ['footprint_sha256', 'native_asset_mismatch'], ['land_geometry_sha256', 'land_geometry_mismatch'], ['pad_net_map', 'native_asset_mismatch'],
];
/** `except (OSError, ValueError, KeyError, TypeError, RuntimeError)` of a part or budget. */
const PART_ERRORS = ['OSError', 'ValueError', 'KeyError', 'TypeError', 'RuntimeError'];
const MANIFEST_ERRORS = [...PART_ERRORS, 'subprocess.TimeoutExpired', 'subprocess.CalledProcessError'];
const LIB_FILES = ['./part-review.ts', './pdf-evidence.ts'].map(file => fileURLToPath(new URL(file, import.meta.url)));
const NATIVE_READER = fileURLToPath(new URL('./part-native.ts', import.meta.url));

export interface Blocker { code: string; detail: string; reference?: string; path?: string; references?: string[] }

export interface PartReport {
  schema: string;
  scope: string;
  board: unknown;
  status: string;
  qualified: boolean;
  stock_current: boolean;
  release_approved: boolean;
  blockers: (Blocker | NativeBlocker)[];
  constraints: { schema: string; rules: Dict[] };
  bindings: Map<string, PartFacts>;
  inputs: Record<string, string>;
  native_inputs: Record<string, string>;
  checked_ratings: { reference: unknown; id: unknown }[];
  checked_budgets: Record<string, unknown>[];
  tool_inputs?: Record<string, string>;
  manifest_sha256?: string;
  manifest?: string;
  selections?: Record<string, unknown>;
  profiles?: Record<string, string>;
  constraint_origins?: Record<string, unknown>;
  [field: string]: unknown;
}

const valueError = (message: string) => new PyError('ValueError', message);
const text = (value: unknown): string => value as string;
const isString = (value: unknown): value is string => typeof value === 'string';
const nonBlank = (value: unknown): boolean => isString(value) && strip(value) !== '';
const isFiniteNumber = (value: unknown): boolean =>
  typeof value === 'bigint' || (value instanceof Float && Number.isFinite(value.value));
const sourceKey = (source: unknown): string => `${text(get(source, 'path'))}\0${text(get(source, 'sha256'))}`;
const within = (inner: unknown, outer: unknown): boolean =>
  number(item(outer, 'min')) <= number(item(inner, 'min')) && number(item(inner, 'min')) <= number(item(inner, 'max')) && number(item(inner, 'max')) <= number(item(outer, 'max'));

export const factsDigest = (manifest: Dict): string => digest(encoded(new Map([...manifest].filter(([key]) => key !== 'review'))));

function exactKeys(value: unknown, allowed: readonly string[], name: string): void {
  if (!isDict(value) || [...value.keys()].some(key => !allowed.includes(key))) throw valueError(`unsupported ${name} fields`);
}

function timestamp(value: unknown): void {
  if (!isString(value) || !parseIso(value).zoned) throw valueError('review timestamp requires an ISO-8601 timezone');
}

/** Exact repository-relative evidence paths for snapshot closure. */
export function dependencyFiles(rootPath: string, manifest: string | Dict, includeNative = true): string[] {
  const root = resolvePath(rootPath);
  const value = isDict(manifest) ? manifest : jsonOf(manifest);
  const paths = new Set<string>();
  const profiles = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    if (!isDict(node)) return;
    const path = node.get('path');
    if (isString(path) && node.has('sha256')) {
      owned(root, path);
      paths.add(path);
    }
    const profile = node.get('profile');
    if (isDict(profile)) walkProfile(profile);
    [...node.values()].forEach(walk);
  };
  const walkProfile = (profile: Dict): void => {
    const path = item(profile, 'path');
    const target = owned(root, path);
    if (sha(target) !== get(profile, 'sha256')) throw valueError(`shared part profile is stale: ${text(path)}`);
    if (profiles.has(text(path))) return;
    profiles.add(text(path));
    walk(jsonOf(target));
  };
  walk(value);
  if (!isDict(manifest)) {
    try {
      paths.add(relativeTo(resolvePath(manifest), root));
    } catch (error) {
      if (!caught(error, 'ValueError')) throw error;
    }
  }
  if (includeNative) Object.keys(readBoard(root, get(value, 'board')).native_inputs).forEach(path => paths.add(path));
  if (isFile(joinPath(root, REGISTRY))) paths.add(REGISTRY);
  return sorted(paths) as string[];
}

/** What the checks need of a planned or an installed part. */
interface Bound { required: boolean; pad_net_map: Map<string, unknown> }

class Review {
  readonly root: string;
  readonly board: unknown;
  readonly nativeRequired: boolean;
  readonly report: PartReport;
  readonly boardPrefix: string;
  private readonly pageCounts = new Map<string, number>();

  constructor(root: string, board: unknown, nativeRequired: boolean) {
    this.root = root;
    this.board = board;
    this.nativeRequired = nativeRequired;
    this.boardPrefix = `hardware-design/boards/${String(board)}/`;
    this.report = {
      schema: SCHEMA, scope: 'reviewed_part_use', board, status: 'blocked', qualified: false, stock_current: false, release_approved: false,
      blockers: [], constraints: { schema: CONSTRAINTS, rules: [] }, bindings: new Map(), inputs: {}, native_inputs: {}, checked_ratings: [], checked_budgets: [],
    };
    if (!nativeRequired) {
      Object.assign(this.report, {
        scope: 'reviewed_part_selection', selections: {}, native_verified: false, cad_verified: false, stock_verified: false,
        connectivity_verified: false, layout_verified: false,
        limits: ['Only declared reviewed selections and applicability are checked; selection completeness is unknown before CAD.',
          'Native descriptors, planned pad nets and layout rules are declarations, not installed CAD evidence.',
          'Original PDF identity/page attribution is checked; reviewed facts are not automatically inferred from PDF text.'],
      });
    }
  }

  block(code: string, detail: string, reference?: unknown): void {
    this.report.blockers.push({ code, detail, ...(truthy(reference) ? { reference: text(reference) } : {}) });
  }

  need(ok: unknown, code: string, detail: string, reference?: unknown): boolean {
    if (!truthy(ok)) this.block(code, detail, reference);
    return truthy(ok);
  }

  private documentPages(target: string): number {
    const identity = sha(target);
    let pages = this.pageCounts.get(identity);
    if (pages === undefined) {
      pages = pdfPages(target, undefined, this.report.tool_inputs ??= {});
      this.pageCounts.set(identity, pages);
    }
    return pages;
  }

  /** Checks a cited source and records it as an input. A hash that changed blocks; a bad citation stops this entry. */
  source(spec: unknown, pdf = false): string {
    if (!isDict(spec) || !isString(spec.get('path')) || !fullMatch(SHA256, get(spec, 'sha256', ''))) throw valueError('evidence needs exact path and SHA-256');
    const path = text(spec.get('path'));
    const target = owned(this.root, path);
    const actual = sha(target);
    this.report.inputs[path] = actual;
    if (actual !== spec.get('sha256')) this.block('stale_source', `evidence hash changed: ${path}`);
    if (pdf || extname(target).toLowerCase() === '.pdf') {
      const page = spec.get('page');
      if (typeof page !== 'bigint' || page < 1n || page > this.documentPages(target)) throw valueError('PDF source needs an actual one-based page locator');
    } else if (!nonBlank(spec.get('section'))) throw valueError('non-PDF source needs a section/record locator');
    return target;
  }

  interval(value: unknown): Dict {
    if (!isDict(value) || !isString(value.get('unit')) || !value.get('unit')) throw valueError('numeric range needs explicit unit');
    if (!isFiniteNumber(value.get('min')) || !isFiniteNumber(value.get('max')) || number(value.get('min')) > number(value.get('max'))) {
      throw valueError('numeric range needs finite ordered min/max');
    }
    this.source(value.get('source'));
    return value;
  }
}

function applyUse(result: Dict, use: unknown, nativeRequired: boolean): void {
  const native = item(result, 'native');
  if (!isDict(native)) throw new PyError('TypeError', `'${typeName(native)}' object does not support item assignment`);
  if (native.has('pad_net_map')) throw valueError('shared profile must not contain board-specific pad nets');
  native.set('pad_net_map', nativeRequired ? item(use, 'pad_net_map') : get(use, 'pad_net_map', new Map()));
  const ratings = iterate(item(result, 'ratings'));
  const required = get(use, 'required', new Map());
  const conditions = get(use, 'conditions', new Map());
  const ids = new Set(ratings.map(rating => item(rating, 'id')));
  const sameKeys = (value: unknown, expected: Set<unknown>) => {
    const keys = new Set(iterate(value));
    return keys.size === expected.size && [...keys].every(key => expected.has(key));
  };
  if (!sameKeys(required, ids)) throw valueError('board use must cover every shared rating exactly');
  if (!sameKeys(conditions, ids)) throw valueError('board use must cover every shared applicability condition');
  for (const rating of ratings as Dict[]) {
    const id = text(item(rating, 'id'));
    rating.set('required', item(required, id));
    const wanted = item(conditions, id);
    const rows = iterate(item(rating, 'conditions')) as Dict[];
    if (!sameKeys(wanted, new Set(rows.map(row => item(row, 'quantity'))))) throw valueError('board use applicability conditions differ from shared profile');
    for (const row of rows) row.set('required', item(wanted, text(item(row, 'quantity'))));
  }
}

function remap(value: unknown, mapping: Dict, key?: string): unknown {
  if (isDict(value)) return new Map([...value].map(([name, child]) => [name, remap(child, mapping, name)]));
  if (Array.isArray(value)) return value.map(child => remap(child, mapping, key === 'refs' ? 'ref' : undefined));
  if ((key === 'ref' || key === 'reference') && isString(value) && value.startsWith('$')) {
    const name = value.slice(1);
    if (!mapping.has(name)) throw valueError(`shared profile reference role has no board binding: ${value}`);
    return mapping.get(name);
  }
  return value;
}

const concat = (left: unknown, right: unknown): unknown[] => {
  if (!Array.isArray(left) || !Array.isArray(right)) throw new PyError('TypeError', `can only concatenate list (not "${typeName(right)}") to list`);
  return [...left, ...right];
};

/** A part that names a shared profile, as the plain part it stands for on this board. */
function expandPart(review: Review, entry: unknown): unknown {
  if (!isDict(entry) || !entry.has('profile')) return entry;
  exactKeys(entry, ['reference', 'profile', 'use'], 'profile-backed part');
  const reference = item(entry, 'reference');
  const descriptor = item(entry, 'profile');
  const use = get(entry, 'use', new Map());
  if (!isDict(descriptor)) throw new PyError('TypeError', `'${typeName(descriptor)}' object is not a mapping`);
  const target = review.source(new Map([...descriptor, ['section', 'Shared part profile']]));
  const profile = jsonOf(target) as Dict;
  exactKeys(profile, PROFILE_FIELDS, 'shared profile');
  if (profile.get('schema') !== PROFILE) throw valueError('unsupported shared part profile schema');
  const reviewed = get(profile, 'review', new Map());
  if (!isDict(reviewed)) throw valueError('shared profile review must be an object');
  timestamp(reviewed.get('reviewed_at_utc'));
  review.need(reviewed.get('verdict') === 'passed' && truthy(reviewed.get('reviewer')) && truthy(reviewed.get('reviewed_at_utc')),
    'profile_review_pending', 'shared part profile needs an attributable engineering review', reference);
  review.need(reviewed.get('facts_sha256') === factsDigest(profile), 'stale_profile_review', 'shared part profile facts changed', reference);
  review.source(reviewed.get('evidence'));
  exactKeys(use, USE_FIELDS, 'board use');
  const result = deepCopy(new Map([...profile].filter(([key]) => key !== 'schema' && key !== 'review')));
  result.set('reference', reference);
  applyUse(result, use, review.nativeRequired);
  const refs = get(use, 'refs', new Map());
  if (!isDict(refs)) throw new PyError('TypeError', `'${typeName(refs)}' object is not a mapping`);
  const mapping: Dict = new Map([['SELF', reference], ...refs]);
  if (mapping.get('SELF') !== reference || [...mapping.values()].some(value => !isString(value) || !value)) {
    throw valueError('invalid shared profile instance reference mapping');
  }
  for (const field of ['layout_constraints', 'assembly_dependencies']) {
    result.set(field, concat(remap(item(result, field), mapping), get(use, field, [])));
  }
  const inherited = iterate(item(profile, 'layout_constraints')).length;
  for (const rule of (item(result, 'layout_constraints') as Dict[]).slice(0, inherited)) {
    const originalId = item(rule, 'id');
    const id = `${text(reference)}:${text(originalId)}`;
    rule.set('id', id);
    (review.report.constraint_origins ??= {})[id] = {
      profile: item(descriptor, 'path'), profile_sha256: item(descriptor, 'sha256'), source_rule_id: originalId, reference,
    };
  }
  result.set('unresolved', concat(item(result, 'unresolved'), get(use, 'unresolved', [])));
  (review.report.profiles ??= {})[text(item(descriptor, 'path'))] = sha(target);
  return result;
}

function checkIdentity(review: Review, part: Dict, ref: unknown, actual: PartFacts | undefined): void {
  const mpn = part.get('mpn');
  const identity = isString(mpn) && strip(mpn) !== '' && mpn === strip(mpn) && fullMatch(LCSC, get(part, 'lcsc', ''));
  review.need(identity && (!actual || (mpn === actual.mpn && part.get('lcsc') === actual.lcsc)),
    'part_identity', 'exact native/planned MPN/LCSC differs or is missing', ref);
  const packaged = get(part, 'package', new Map());
  if (!isDict(packaged)) throw valueError('package identity must be an object');
  review.need(nonBlank(part.get('manufacturer')) && nonBlank(packaged.get('name')) && nonBlank(packaged.get('variant')),
    'package_identity', 'manufacturer, exact package and variant must be reviewed', ref);
}

function checkDatasheets(review: Review, part: Dict, ref: unknown): Set<string> {
  const documents = get(part, 'datasheets', []);
  if (!truthy(documents)) throw valueError('original exact datasheet/revision evidence required');
  const identities = new Set<string>();
  for (const document of iterate(documents)) {
    if (!isDict(document)) throw valueError('datasheet source must be an object');
    review.need(truthy(document.get('document_id')) && truthy(document.get('revision')), 'document_identity', 'actual datasheet identity and revision required', ref);
    review.source(document, true);
    identities.add(sourceKey(document));
  }
  return identities;
}

function checkInstalled(review: Review, expected: Dict, actual: PartFacts, ref: unknown): void {
  const unspecified = [...actual.pin_map].filter(([, pin]) => pin.type === 'unspecified').map(([number]) => number).sort();
  review.need(!unspecified.length, 'unspecified_pin_type', `reviewed native symbol needs functional electrical pin types; unspecified pins: ${unspecified.join(', ')}`, ref);
  for (const [field, code] of NATIVE_FIELDS) {
    review.need(expected.has(field) && pyEquals(expected.get(field), actual[field]), code, `installed native ${field} differs from reviewed facts`, ref);
  }
  const mechanical = expected.get('non_electrical_pads');
  const extra = new Set(Array.isArray(mechanical) ? mechanical : []);
  const pads = new Set(actual.pad_numbers);
  const pins = new Set(actual.pin_map.keys());
  const covered = new Set([...pins, ...extra]);
  const exact = Array.isArray(mechanical) && extra.size === mechanical.length && pads.size === covered.size
    && [...pads].every(pad => covered.has(pad)) && ![...pins].some(pin => extra.has(pin));
  review.need(exact, 'pin_pad_coverage', 'all physical pad numbers need exact pin/mechanical classification', ref);
}

function checkPlanned(review: Review, part: Dict, expected: Dict, ref: string, bound: Map<string, Bound>): void {
  const planned = get(expected, 'pad_net_map', new Map());
  const plain = isDict(planned) && [...planned].every(([pad, net]) => pad && isString(net) && net);
  if (!plain) throw valueError('planned pad nets require explicit string pad/net identities');
  bound.set(ref, { required: true, pad_net_map: planned as Dict });
  (review.report.selections as Record<string, unknown>)[ref] = {
    mpn: part.get('mpn'), lcsc: part.get('lcsc'), manufacturer: part.get('manufacturer'), package: deepCopy(part.get('package')),
    planned_native: deepCopy(expected), native_verified: false,
  };
}

function checkRatings(review: Review, part: Dict, ref: unknown, documents: Set<string>): void {
  const ratings = part.get('ratings');
  if (!Array.isArray(ratings) || !ratings.length) throw valueError('at least one sourced applicable rating/operating range required');
  const ids = ratings.filter(isDict).map(rating => rating.get('id'));
  if (ids.length !== new Set(ids).size) throw valueError('rating IDs must be unique for this part');
  for (const rating of ratings) {
    if (!isDict(rating)) throw valueError('rating must be an object');
    if (!truthy(rating.get('id')) || !truthy(rating.get('quantity')) || !Array.isArray(rating.get('conditions'))) {
      throw valueError('rating needs id, physical quantity and explicit applicability conditions');
    }
    const limit = review.interval(item(rating, 'limit'));
    const demand = review.interval(item(rating, 'required'));
    const id = text(rating.get('id'));
    review.need(text(item(item(demand, 'source'), 'path')).startsWith(review.boardPrefix), 'use_conditions_owner', 'operating demand must cite this board\'s requirements', ref);
    review.need(documents.has(sourceKey(limit.get('source'))), 'rating_source', 'rating limit must cite this exact part datasheet', ref);
    review.need(limit.get('unit') === demand.get('unit') && within(demand, limit), 'rating_exceeded', `required operating range exceeds sourced applicable rating or units differ: ${id}`, ref);
    for (const condition of rating.get('conditions') as unknown[]) checkCondition(review, condition, id, ref, documents);
    review.report.checked_ratings.push({ reference: ref, id: rating.get('id') });
  }
}

function checkCondition(review: Review, condition: unknown, id: string, ref: unknown, documents: Set<string>): void {
  if (!isDict(condition)) throw valueError('applicability condition must be an object');
  const valid = review.interval(item(condition, 'valid'));
  const required = review.interval(item(condition, 'required'));
  review.need(text(item(item(required, 'source'), 'path')).startsWith(review.boardPrefix), 'use_conditions_owner', 'operating conditions must cite this board\'s requirements', ref);
  review.need(documents.has(sourceKey(valid.get('source'))), 'rating_condition_source', 'applicability limit must cite this exact part datasheet', ref);
  review.need(truthy(condition.get('quantity')) && valid.get('unit') === required.get('unit') && within(required, valid),
    'rating_conditions', `rating applicability conditions not met: ${id}`, ref);
}

function checkLayout(review: Review, part: Dict, ref: unknown): void {
  const rules = part.get('layout_constraints');
  if (!Array.isArray(rules)) throw valueError('explicit layout constraints list required');
  for (const rule of rules) {
    if (!isDict(rule)) throw valueError('layout constraint must be an object');
    review.source(rule.get('source'));
    review.need(KINDS.includes(text(rule.get('kind'))) && isString(rule.get('id')) && rule.get('id'), 'unsupported_constraint', 'unrecognized or unnamed layout constraint', ref);
    review.report.constraints.rules.push(rule);
  }
}

function checkDependencies(review: Review, part: Dict, ref: unknown): void {
  const dependencies = part.get('assembly_dependencies');
  if (!Array.isArray(dependencies)) throw valueError('explicit connector/assembly dependency list required');
  for (const dependency of dependencies) {
    if (!isDict(dependency)) throw valueError('assembly dependency must be an object');
    const quantity = dependency.get('quantity');
    review.need(DEPENDENCY_KINDS.has(text(dependency.get('kind'))) && truthy(dependency.get('reference')) && truthy(dependency.get('mpn'))
      && typeof quantity === 'bigint' && quantity > 0n, 'assembly_dependency', 'exact assembly dependency identity/quantity missing', ref);
    review.source(dependency.get('source'));
  }
}

function checkPart(review: Review, entry: unknown, seen: Set<unknown>, bound: Map<string, Bound>, installed: Map<string, PartFacts>): void {
  const ref = isDict(entry) ? entry.get('reference') : null;
  const part = expandPart(review, entry) as Dict;
  exactKeys(part, PART_FIELDS, 'part');
  const known = !review.nativeRequired || (isString(ref) && installed.has(ref));
  if (!nonBlank(ref) || seen.has(ref) || !known) throw valueError('duplicate, missing or unknown native/planned reference');
  seen.add(ref);
  const actual = review.nativeRequired ? installed.get(text(ref)) : undefined;
  checkIdentity(review, part, ref, actual);
  const documents = checkDatasheets(review, part, ref);
  const expected = get(part, 'native', new Map());
  if (!isDict(expected)) throw valueError('native part binding must be an object');
  if (actual) checkInstalled(review, expected, actual, ref);
  else checkPlanned(review, part, expected, text(ref), bound);
  checkRatings(review, part, ref, documents);
  checkLayout(review, part, ref);
  checkDependencies(review, part, ref);
  const unresolved = part.get('unresolved');
  const detail = 'unresolved part engineering items remain';
  review.need(Array.isArray(unresolved) && !unresolved.length, 'unresolved_part_use',
    review.nativeRequired || !truthy(unresolved) ? detail : `${detail}: ${jsonDumps(unresolved)}`, ref);
}

function checkBudget(review: Review, budget: unknown, bound: Map<string, Bound>): void {
  const net = item(budget, 'net');
  const connected = new Set([...bound].filter(([, part]) => part.required && [...part.pad_net_map.values()].includes(net)).map(([ref]) => ref));
  const limit = review.interval(item(budget, 'limit'));
  const unit = limit.get('unit');
  review.need(connected.size > 0 && (unit === 'A' || unit === 'W'), 'budget_scope', 'budget needs declared net and current/power units');
  if (!review.nativeRequired) {
    review.need([...bound.values()].every(part => part.pad_net_map.size > 0), 'planned_budget_scope',
      'every selection needs planned pad nets before declared budget coverage can be checked');
  }
  const loads = new Set<unknown>();
  const excluded = new Set<unknown>();
  let total = 0;
  for (const load of iterate(item(budget, 'loads'))) {
    const required = review.interval(item(load, 'required'));
    const reference = item(load, 'reference');
    review.need(connected.has(text(reference)) && !loads.has(reference) && required.get('unit') === unit && number(item(required, 'min')) >= 0,
      'budget_load', 'budget load identity/units/coverage invalid');
    loads.add(reference);
    total += number(item(required, 'max'));
  }
  for (const exclusion of iterate(get(budget, 'exclusions', []))) {
    review.source(item(exclusion, 'source'));
    const reference = item(exclusion, 'reference');
    review.need(truthy(get(exclusion, 'reason')) && connected.has(text(reference)) && !excluded.has(reference),
      'budget_exclusion', 'budget exclusion requires unique native reference and sourced reason');
    excluded.add(reference);
  }
  const covered = new Set([...loads, ...excluded]);
  const complete = ![...loads].some(ref => excluded.has(ref)) && covered.size === connected.size && [...covered].every(ref => connected.has(text(ref)));
  review.need(complete && total <= number(item(limit, 'max')), 'budget_exceeded', 'native net coverage incomplete or summed worst-case loads exceed sourced budget');
  const result: Record<string, unknown> = { id: item(budget, 'id'), net, total: new Float(total), unit };
  if (!review.nativeRequired) result.scope = 'declared_planned_net_only';
  review.report.checked_budgets.push(result);
}

function checkRegistry(review: Review, manifest: Dict): void {
  if (!isFile(joinPath(review.root, REGISTRY))) return;
  const revision = registryRevision(review.root, text(review.board));
  review.report.inputs[REGISTRY] = sha(joinPath(review.root, REGISTRY));
  if (!revision.size) return;
  const path = `hardware-design/boards/${text(item(revision, 'directory'))}/${text(item(revision, 'spec'))}`;
  review.need(manifest.get('revision') === revision.get('revision') && item(item(manifest, 'spec'), 'path') === path,
    'revision_owner', 'manifest differs from registered native revision/spec ownership');
}

function checkReview(review: Review, manifest: Dict): void {
  const reviewed = get(manifest, 'review', new Map());
  if (!isDict(reviewed)) throw valueError('manifest review must be an object');
  review.need(reviewed.get('verdict') === 'passed' && nonBlank(reviewed.get('reviewer')), 'review_pending', 'explicit attributable engineering review required');
  try {
    timestamp(reviewed.get('reviewed_at_utc'));
  } catch (error) {
    if (!caught(error, 'ValueError', 'TypeError', 'KeyError')) throw error;
    review.block('review_timestamp', 'review timestamp missing/invalid');
  }
  review.need(reviewed.get('facts_sha256') === factsDigest(manifest), 'stale_review', 'review is not bound to these exact engineering facts');
  review.source(reviewed.get('evidence'));
}

/** Runs one check; what it raises blocks this entry and the review goes on. */
function guarded(review: Review, code: string, reference: unknown, check: () => void): void {
  try {
    check();
  } catch (error) {
    if (!caught(error, ...PART_ERRORS)) throw error;
    review.block(code, (error as Error).message, reference);
  }
}

function bindInstalled(review: Review, manifest: Dict): { project: boolean; parts: Map<string, PartFacts> } {
  const { report } = review;
  const native = readBoard(review.root, review.board);
  report.native_inputs = native.native_inputs;
  report.tool_inputs = { ...native.reader_inputs, ...Object.fromEntries(LIB_FILES.map(file => [file, sha(file)])) };
  Object.assign(report.inputs, native.native_inputs);
  report.bindings = native.parts;
  report.blockers.push(...native.blockers);
  return { project: manifest.get('project') === native.project, parts: native.parts };
}

function bindPlanned(review: Review, manifest: Dict): boolean {
  const { board, report } = review;
  if (!isString(board) || !BOARD_ID.test(board)) throw valueError('selection requires an exact planned board/design ID');
  const project = manifest.get('project');
  report.tool_inputs = Object.fromEntries([...LIB_FILES, NATIVE_READER].map(file => [file, sha(file)]));
  return isString(project) && project.startsWith(review.boardPrefix) && project.split('/').every(part => part && part !== '.' && part !== '..' && !part.includes('\\'));
}

function confirmUnchanged(review: Review, path: string, manifestInput: string): void {
  const { report } = review;
  for (const [name, expected] of Object.entries(report.inputs)) {
    const target = name === manifestInput ? path : owned(review.root, name);
    if (sha(target) !== expected) review.block('stale_source', `source changed during verification: ${name}`);
  }
  if (sha(path) !== report.manifest_sha256) review.block('stale_source', 'manifest changed during verification');
  for (const [name, expected] of Object.entries(report.tool_inputs ?? {})) {
    if (sha(name) !== expected) review.block('stale_tool', `verification tool changed: ${name}`);
  }
}

function readBytes(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    throw osError(error, path);
  }
}

function reviewManifest(review: Review, path: string): void {
  const { report, nativeRequired, root, board } = review;
  const raw = readBytes(path);
  const manifest = jsonLoads(raw) as Dict;
  exactKeys(manifest, MANIFEST_FIELDS, 'manifest');
  report.manifest_sha256 = digest(raw);
  report.manifest = path;
  const manifestInput = nativeRequired ? path : relativeTo(path, root);
  report.inputs[manifestInput] = report.manifest_sha256;
  if (!nativeRequired) Object.assign(report, { revision: get(manifest, 'revision'), project: get(manifest, 'project') });
  const installed = nativeRequired ? bindInstalled(review, manifest) : null;
  const projectMatches = installed ? installed.project : bindPlanned(review, manifest);
  const bound = new Map<string, Bound>(installed?.parts ?? []);
  review.need(manifest.get('schema') === MANIFEST && manifest.get('board') === board && projectMatches && isString(manifest.get('revision')) && manifest.get('revision'),
    'manifest_identity', 'exact board/revision/owned project identity required');
  review.source(manifest.get('spec'));
  review.need(text(item(item(manifest, 'spec'), 'path')).startsWith(review.boardPrefix), 'spec_owner', 'part use requires this board\'s specification');
  checkRegistry(review, manifest);
  checkReview(review, manifest);
  const parts = manifest.get('parts');
  if (!Array.isArray(parts) || !parts.length) throw valueError('manifest requires explicit reviewed parts');
  const seen = new Set<unknown>();
  for (const part of parts) {
    guarded(review, 'invalid_part_evidence', isDict(part) ? part.get('reference') : null,
      () => checkPart(review, part, seen, bound, installed?.parts ?? new Map()));
  }
  if (nativeRequired) {
    const missing = [...bound].filter(([ref, value]) => value.required && !seen.has(ref)).map(([ref]) => ref).sort();
    review.need(!missing.length, 'unreviewed_native_parts', `fitted native references lack reviewed evidence: ${missing.join(', ')}`);
  }
  const ids = report.constraints.rules.map(rule => rule.get('id')).filter(isString);
  review.need(ids.length === new Set(ids).size, 'constraint_identity', 'layout constraint IDs must be unique');
  for (const budget of iterate(get(manifest, 'budgets', []))) guarded(review, 'invalid_budget', null, () => checkBudget(review, budget, bound));
  confirmUnchanged(review, path, manifestInput);
}

function verify(rootPath: string, board: unknown, manifest: string, nativeRequired: boolean): PartReport {
  const review = new Review(resolvePath(rootPath), board, nativeRequired);
  const { report } = review;
  try {
    reviewManifest(review, resolvePath(manifest));
  } catch (error) {
    if (!caught(error, ...MANIFEST_ERRORS)) throw error;
    review.block('invalid_manifest', (error as Error).message);
  }
  const stale = report.blockers.some(blocker => blocker.code.startsWith('stale_'));
  report.status = !report.blockers.length ? 'passed' : stale ? 'stale' : 'blocked';
  return report;
}

/** Reviewed facts against every required actual native instance. */
export const verifyManifest = (root: string, board: unknown, path: string): PartReport => verify(root, board, path, true);

/** Reviewed applicability before CAD; planned native facts stay unverified. */
export function verifySelection(root: string, board: unknown, path: string, output?: string): PartReport {
  const report = verify(root, board, path, false);
  if (output !== undefined) atomicJson(output, sortKeys(report));
  return report;
}

export function statusBoard(rootPath: string, board: unknown): PartReport {
  const root = resolvePath(rootPath);
  if (!isString(board) || !BOARD_ID.test(board)) throw valueError('expected configured board ID');
  const relative = `hardware-design/registry/part-reviews/${board}.json`;
  const path = joinPath(root, relative);
  if (isFile(path)) return verifyManifest(root, board, path);
  const native = readBoard(root, board);
  const references = [...native.parts].filter(([, part]) => part.required).map(([ref]) => ref).sort();
  // No manifest was reviewed, so this report has no checked_ratings or checked_budgets.
  return {
    schema: SCHEMA, scope: 'reviewed_part_use', board, status: 'blocked', qualified: false, stock_current: false, release_approved: false,
    absent_inputs: [relative], inputs: native.native_inputs, native_inputs: native.native_inputs, tool_inputs: native.reader_inputs, bindings: native.parts,
    constraints: { schema: CONSTRAINTS, rules: [] },
    blockers: [...native.blockers, { code: 'missing_part_review', detail: 'no reviewed native part-use manifest', path: relative, references }],
  } as unknown as PartReport;
}
