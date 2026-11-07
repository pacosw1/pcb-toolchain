// Verify declared schematic functions against reviewed facts and native CAD.
//
// This does not run ERC/DRC, simulate a circuit, select parts or prove firmware operating state. Unstated requirements
// and unsupported quantities remain unknown.
//
// Quantities are exact decimals, and contracts stay jsonLoads values: facts_sha256 is a hash over them, and a report holds
// Decimal text such as 0.040. One assertion that fails blocks itself; a contract that cannot be read blocks the report.
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Decimal } from './decimal.ts';
import { dependencyFiles as designDependencies, loadContract, type SourceServices } from './design-contract-load.ts';
import { parseIso } from './iso-time.ts';
import { children, type Tree } from './kicad-population.mjs';
import { runStage } from './lean-stage.ts';
import { deadlineAfter } from './lean-workflow.ts';
import { kicadCli, parseNetlist, type Netlist, type Node } from './netlist.ts';
import { owned, properties, type PartFacts } from './part-native.ts';
import { dependencyFiles as partDependencies, factsDigest, verifyManifest } from './part-review.ts';
import { verifyPopulationSource } from './part-stock.ts';
import { boardConfig, sha } from './pcb-workflow.ts';
import { pdfPages } from './pdf-evidence.ts';
import { Float, floatRepr, get, item, jsonDumps, jsonLoads, osError, PyError, pyStr, sorted, splitlines, strip } from './py-compat.mjs';
import { deepCopy, fullMatch, isDict, iterate, pyEquals, type Dict } from './py-dict.ts';
import { caught, isFile, joinPath, jsonOf, relativeTo, resolvePath, textOf, which, withSuffix } from './py-path.ts';
import { iter, parseXml } from './xml-read.mjs';

export const SCHEMA = 'iot-lab.schematic-contract.v1';
export const RESULT = 'iot-lab.schematic-contract-result.v1';

const SHA256 = /^[a-f0-9]{64}$/;
const PREFIX: Record<string, Decimal> = Object.fromEntries(
  ([['', '1'], ['p', '1e-12'], ['n', '1e-9'], ['u', '1e-6'], ['m', '1e-3'], ['k', '1e3'], ['M', '1e6'], ['G', '1e9']] as const).map(([name, value]) => [name, Decimal.of(value)]));
const BASES = ['Ohm', 'F', 'H', 'V', 'A', 'W', 'Hz', 's', 'degC'];
const RESISTOR_MARKER: Record<string, string> = { R: '', r: '', K: 'k', k: 'k', M: 'M', m: 'm' };
const CONTRACT_FIELDS = ['schema', 'board', 'project', 'review', 'design_contract', 'part_review', 'population_source', 'assertions'];
const REVIEW_FIELDS = ['verdict', 'reviewer', 'reviewed_at_utc', 'facts_sha256', 'evidence'];
const COMMON = ['id', 'kind', 'requirement', 'source'];
const NOT_MODE_FIELDS = ['MPN', 'LCSC', 'Reference', 'Value', 'Footprint'];
const ASSERTION_ERRORS = ['OSError', 'ValueError', 'KeyError', 'TypeError'];
const REPORT_ERRORS = [...ASSERTION_ERRORS, 'RuntimeError', 'xml.etree.ElementTree.ParseError', 'subprocess.TimeoutExpired', 'subprocess.CalledProcessError'];
const EXPORT_SECONDS = 30;
const THIS_FILE = fileURLToPath(import.meta.url);
const DESIGN_FILE = fileURLToPath(new URL('./design-contract-load.ts', import.meta.url));
const NETLIST_FILE = fileURLToPath(new URL('./netlist.ts', import.meta.url));

/** What design-contract-load needs of this cluster. */
export const SOURCES: SourceServices = {
  pdfPages: path => pdfPages(path),
  partDependencyFiles: (root, manifest, { includeNative }) => partDependencies(root, manifest, includeNative),
};

const valueError = (message: string) => new PyError('ValueError', message);
const runtimeError = (message: string) => new PyError('RuntimeError', message);
function need(ok: unknown, detail: string): void {
  if (!ok) throw valueError(detail);
}
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isUniqueTexts = (value: unknown): value is string[] => Array.isArray(value) && new Set(value).size === value.length;
/** design-contract-load speaks plain Errors for what Python raised as ValueError. */
const isPlainError = (error: unknown) => error instanceof Error && error.constructor === Error;

export function read(path: string): Dict {
  const result = jsonOf(path);
  if (!isDict(result)) throw valueError(`expected JSON object: ${path}`);
  return result;
}

export function keys(value: unknown, allowed: readonly string[], required: readonly string[] = []): void {
  const ok = isDict(value) && [...value.keys()].every(key => allowed.includes(key)) && required.every(key => value.has(key));
  if (!ok) throw valueError(`unsupported or missing fields; expected ${required.join(', ')}`);
}

/** An exact quantity. Booleans are no quantities. */
export function number(value: unknown): Decimal {
  if (value instanceof Decimal) return value;
  const text = typeof value === 'string' ? value : typeof value === 'bigint' ? String(value)
    : value instanceof Float ? floatRepr(value.value) : typeof value === 'number' ? pyStr(value) : null;
  if (text === null) throw valueError('finite numeric value required; booleans are not quantities');
  let result: Decimal | null;
  try {
    result = Decimal.parse(text);
  } catch {
    throw valueError('invalid exact numeric value');
  }
  if (result === null) throw valueError('nonfinite quantity');
  return result;
}

/** The base of a unit and the scale to it. */
export function unit(value: unknown): [string, Decimal] {
  if (typeof value !== 'string') throw valueError('explicit supported physical unit required');
  const clean = value.replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll('Ω', 'Ohm');
  for (const base of BASES) {
    if (clean === base) return [base, PREFIX[''] as Decimal];
    const prefix = PREFIX[clean.slice(0, -base.length)];
    if (clean.endsWith(base) && prefix && base !== 'degC') return [base, prefix];
  }
  throw valueError(`unsupported physical unit: ${clean}`);
}

/** Parses nominal CAD values; tolerances always come from a sourced interval. */
export function canonicalValue(value: unknown, expectedUnit: string): [Decimal, string] {
  const [base] = unit(expectedUnit);
  if (typeof value !== 'string' || !strip(value)) throw valueError('native component value is absent');
  const text = strip(value).replaceAll(' ', '').replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll('Ω', 'Ohm');
  // IEC resistor shorthand is unambiguous only for a resistance assertion.
  const shorthand = base === 'Ohm' ? /^([0-9]+)([RrKkMm])([0-9]*)$/.exec(text) : null;
  if (shorthand) {
    const [, whole, marker, rest] = shorthand as unknown as [string, string, string, string];
    return [number(whole + (rest ? `.${rest}` : '')).mul(PREFIX[RESISTOR_MARKER[marker] as string] as Decimal), base];
  }
  const match = /^([+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)(.*)$/.exec(text);
  if (!match) throw valueError(`unsupported native value notation: ${pyStr(value)}`);
  const amount = number(match[1]);
  const suffix = match[2] as string;
  // A suffix-only prefix or bare number uses the dimension explicitly declared by the reviewed assertion, never an
  // inferred reference type.
  if (Object.hasOwn(PREFIX, suffix)) return [amount.mul(PREFIX[suffix] as Decimal), base];
  const [actualBase, scale] = unit(suffix);
  if (actualBase !== base) throw valueError('native value has a different physical dimension');
  return [amount.mul(scale), base];
}

export interface Exported extends Required<Netlist> {
  fields: Map<string, Map<string, string>>;
  /** By `pinKey`. */
  pins: Map<string, { net: string; name: string }>;
}

export const pinKey = (ref: string, pin: string): string => `${ref}\0${pin}`;

const allPresentAndUnique = (names: (string | undefined)[]): boolean => names.every(Boolean) && new Set(names).size === names.length;

export function parseExport(raw: string): Exported {
  const parsed = parseNetlist(raw);
  const document = parseXml(raw);
  const comps = [...iter(document, 'comp')];
  if (!allPresentAndUnique(comps.map(node => node.attributes.get('ref')))) throw valueError('native export has duplicate/missing component references');
  if (!allPresentAndUnique([...iter(document, 'net')].map(node => node.attributes.get('name')))) throw valueError('native export has duplicate/missing net names');
  const fields = new Map<string, Map<string, string>>();
  for (const node of comps) {
    const rows = [...iter(node, 'field')];
    if (!allPresentAndUnique(rows.map(row => row.attributes.get('name')))) throw valueError('native export has duplicate/missing component fields');
    fields.set(node.attributes.get('ref') as string, new Map(rows.map(row => [row.attributes.get('name') as string, strip(row.text)])));
  }
  const pins: Exported['pins'] = new Map();
  for (const [net, rows] of parsed.nets) {
    for (const [ref, pin, name] of rows as Node[]) {
      const key = pinKey(ref, pin);
      if (!ref || !pin || pins.has(key)) throw valueError('native export pin appears more than once');
      pins.set(key, { net, name });
    }
  }
  return { ...parsed, fields, pins };
}

export interface NativeExport { parsed: Exported; evidence: Record<string, string>; tools: Record<string, string> }
export type Exporter = (schematic: string, artifacts: string) => Promise<NativeExport>;

export async function exportNative(schematic: string, artifacts: string): Promise<NativeExport> {
  const found = which(kicadCli());
  if (!found) throw runtimeError('native KiCad netlist exporter is unavailable');
  const launcher = resolvePath(found);
  const tools = { [launcher]: sha(launcher), [NETLIST_FILE]: sha(NETLIST_FILE) };
  const output = joinPath(artifacts, 'native-netlist.xml');
  const logPath = joinPath(artifacts, 'export.log');
  const log = openSync(logPath, 'w');
  let code: number;
  try {
    ({ returncode: code } = await runStage([launcher, 'sch', 'export', 'netlist', '--format', 'kicadxml', '-o', output, schematic], {
      stage: 'schematic-functional-netlist', eventFile: joinPath(artifacts, 'events.jsonl'), deadline: deadlineAfter(EXPORT_SECONDS), stdout: log, stderr: log,
    }));
  } finally {
    closeSync(log);
  }
  if (code || !isFile(output)) throw runtimeError(`native schematic export failed; evidence=${logPath}`);
  const parsed = parseExport(textOf(output));
  if (Object.entries(tools).some(([name, digest]) => sha(name) !== digest)) throw valueError('native exporter changed during schematic inspection');
  return { parsed, evidence: { [output]: sha(output) }, tools };
}

function descriptorPaths(root: string, item_: unknown, found: Set<string>): void {
  if (Array.isArray(item_)) item_.forEach(child => descriptorPaths(root, child, found));
  if (!isDict(item_)) return;
  const path = item_.get('path');
  if (typeof path === 'string' && (item_.get('sha256') ?? null) !== null) found.add(relativeTo(owned(root, path), root));
  for (const child of item_.values()) descriptorPaths(root, child, found);
}

export function dependencyFiles(rootPath: string, contractPath: string): string[] {
  const root = resolvePath(rootPath);
  const path = resolvePath(contractPath);
  const value = read(path);
  const found = new Set([relativeTo(path, root)]);
  descriptorPaths(root, value, found);
  const bound = (name: string) => owned(root, item(item(value, name), 'path'));
  for (const file of designDependencies(root, bound('design_contract'), null, SOURCES)) found.add(file);
  for (const file of partDependencies(root, bound('part_review'))) found.add(file);
  return sorted(found) as string[];
}

type Range = [low: Decimal, high: Decimal, base: string];
interface Outcome { id: unknown; kind: unknown; requirement: unknown; status: string; cause?: string; actual?: any; [field: string]: unknown }

export interface SchematicReport {
  schema: string;
  scope: string;
  board: string;
  status: string;
  qualified: boolean;
  release_approved: boolean;
  stock_current: boolean;
  assertions: Outcome[];
  requirement_results: Record<string, { status: string; assertions: unknown[] }>;
  blockers: { code: string; detail: string; assertion?: unknown }[];
  inputs: Record<string, unknown>;
  absent_inputs: string[];
  native_inputs: Record<string, string>;
  tool_inputs: Record<string, string>;
  [field: string]: unknown;
}

/** Facts one assertion is checked against. */
interface Facts {
  native: Map<string, PartFacts>;
  exported: Exported;
  pcb: Map<string, Map<string, unknown>>;
  names: string[];
  fits: Map<string, string[]>;
  reviewedParts: Dict;
  observed: Map<unknown, Outcome>;
}

class Check {
  readonly root: string;
  readonly report: SchematicReport;
  private readonly pages = new Map<unknown, number>();

  constructor(root: string, report: SchematicReport) {
    this.root = root;
    this.report = report;
  }

  source(descriptor: unknown): string {
    keys(descriptor, ['path', 'sha256', 'page', 'section'], ['path', 'sha256']);
    const path = item(descriptor, 'path');
    const digest = item(descriptor, 'sha256');
    const target = owned(this.root, path);
    if (!fullMatch(SHA256, digest) || sha(target) !== digest) throw valueError(`stale source: ${pyStr(path)}`);
    this.report.inputs[target] = digest;
    if (extname(target).toLowerCase() === '.pdf') {
      if (!this.pages.has(digest)) this.pages.set(digest, pdfPages(target));
      const page = get(descriptor, 'page');
      if (typeof page !== 'bigint' || page < 1n || page > (this.pages.get(digest) as number)) throw valueError('source requires an actual one-based PDF page');
    } else {
      const section = get(descriptor, 'section');
      if (typeof section !== 'string' || !strip(section)) throw valueError('source requires a record/section locator');
    }
    return target;
  }

  boundFile(descriptor: unknown): string {
    keys(descriptor, ['path', 'sha256'], ['path', 'sha256']);
    const path = item(descriptor, 'path');
    const digest = item(descriptor, 'sha256');
    const target = owned(this.root, path);
    if (typeof digest !== 'string' || !SHA256.test(digest) || sha(target) !== digest) throw valueError(`stale reviewed contract: ${pyStr(path)}`);
    this.report.inputs[target] = digest;
    return target;
  }

  interval(value: unknown): Range {
    const fields = ['min', 'max', 'unit', 'source'];
    keys(value, fields, fields);
    this.source(item(value, 'source'));
    const [base, scale] = unit(item(value, 'unit'));
    const quantity = (name: string): Decimal => {
      const raw = item(value, name);
      if (typeof raw !== 'bigint' && !(raw instanceof Float)) throw valueError('quantity intervals require finite JSON numbers');
      return number(raw).mul(scale);
    };
    const low = quantity('min');
    const high = quantity('max');
    if (low.compare(high) > 0) throw valueError('quantity interval is reversed');
    return [low, high, base];
  }
}

function conditions(rows: unknown, observed: Facts['observed'], variant: unknown): void {
  if (!Array.isArray(rows)) throw valueError('explicit operating conditions list required');
  const used = new Set<unknown>();
  for (const row of rows) {
    keys(row, ['mode', 'value'], ['mode', 'value']);
    const mode = item(row, 'mode');
    if (used.has(mode)) throw valueError('duplicate operating condition');
    used.add(mode);
    const actual = observed.get(mode);
    const applies = actual && actual.kind === 'mode' && actual.status === 'passed' && actual.actual === item(row, 'value')
      && (variant === null || actual.variant === variant);
    if (!applies) throw valueError('operating-mode applicability is missing, failed or different');
  }
}

function reviewedDemand(check: Check, facts: Facts, selector: unknown, ref: string, net: unknown): [unknown, Record<string, unknown>] {
  keys(selector, ['budget', 'rating']);
  const chosen = [...(selector as Dict).values()];
  need(chosen.length === 1 && chosen.every(isText), 'load requires one exact reviewed demand selector');
  const parts = facts.reviewedParts;
  if ((selector as Dict).has('budget')) {
    const budget = (selector as Dict).get('budget');
    const budgets = iterate(get(parts, 'budgets', [])).filter(row => item(row, 'id') === budget);
    need(budgets.length === 1 && item(budgets[0], 'net') === net, 'reviewed budget ID/net does not match this actual load');
    const loads = iterate(item(budgets[0], 'loads')).filter(row => item(row, 'reference') === ref);
    need(loads.length === 1, 'reviewed budget does not contain this exact native load');
    return [item(loads[0], 'required'), { reference: ref, budget, net, conditions: [] }];
  }
  const rows = iterate(item(parts, 'parts')).filter(row => item(row, 'reference') === ref);
  need(rows.length === 1, 'reviewed rating requires this exact native part');
  const part = rows[0] as Dict;
  const descriptor = part.get('profile');
  const profile = descriptor ? read(check.boundFile(descriptor)) : part;
  const ratings = iterate(item(profile, 'ratings')).filter(row => item(row, 'id') === (selector as Dict).get('rating'));
  need(ratings.length === 1, 'reviewed part/profile rating ID is absent or ambiguous');
  const rating = ratings[0];
  const id = item(rating, 'id') as string;
  const quantityOf = (row: unknown) => item(row, 'quantity') as string;
  const use = descriptor ? item(part, 'use') : null;
  const demand = use ? item(item(use, 'required'), id) : item(rating, 'required');
  const context = iterate(item(rating, 'conditions')).map(row => ({
    quantity: item(row, 'quantity'), required: use ? item(item(item(use, 'conditions'), id), quantityOf(row)) : item(row, 'required'),
  }));
  return [demand, { reference: ref, rating: id, quantity: item(rating, 'quantity'), conditions: context }];
}

function scopedDemands(check: Check, facts: Facts, ref: string, net: unknown): [unknown, Range][] {
  const found: [unknown, Range][] = [];
  for (const row of iterate(get(facts.reviewedParts, 'budgets', []))) {
    if (item(row, 'net') !== net) continue;
    for (const load of iterate(item(row, 'loads'))) {
      const required = item(load, 'required');
      if (item(load, 'reference') === ref && number(item(required, 'max')).compare(Decimal.of('0')) > 0) found.push([item(row, 'id'), check.interval(required)]);
    }
  }
  return found;
}

function checkValue(check: Check, facts: Facts, row: Dict, outcome: Outcome): void {
  const fields = [...COMMON, 'reference', 'mpn', 'expected', 'conditions'];
  keys(row, fields, fields);
  const ref = item(row, 'reference') as string;
  need(facts.native.has(ref) && facts.native.get(ref)?.mpn === item(row, 'mpn'), 'value assertion MPN differs from actual native part');
  const [low, high, base] = check.interval(item(row, 'expected'));
  const [schematic, dimension] = canonicalValue(item(facts.exported.values, ref), base);
  const [board] = canonicalValue(item(facts.pcb, ref) && (item(facts.pcb, ref) as Map<string, unknown>).get('Value'), base);
  need(schematic.equals(board), `schematic/PCB nominal value differs: ${ref}`);
  need(low.compare(schematic) <= 0 && schematic.compare(high) <= 0, `native value outside sourced interval: ${ref}`);
  Object.assign(outcome, {
    actual: { value: String(schematic), unit: dimension }, expected: { min: String(low), max: String(high), unit: base },
  });
}

function checkPinNet(_check: Check, facts: Facts, row: Dict, outcome: Outcome): void {
  const fields = [...COMMON, 'reference', 'pin', 'net'];
  keys(row, [...fields, 'pin_name'], fields);
  const ref = item(row, 'reference') as string;
  const pin = item(row, 'pin');
  const part = facts.native.get(ref);
  need(part && typeof pin === 'string' && part.pin_map.has(pin), 'unknown native symbol pin');
  const actual = facts.exported.pins.get(pinKey(ref, pin as string))?.net ?? null;
  const board = (part as PartFacts).pad_net_map.get(pin as string) || null;
  need(actual === board && board === item(row, 'net'), 'schematic/PCB pin connectivity differs from required net');
  if (row.has('pin_name')) need((part as PartFacts).pin_map.get(pin as string)?.name === row.get('pin_name'), 'native pin function/name differs');
  Object.assign(outcome, { actual: { reference: ref, pin, net: actual } });
}

function checkPopulation(_check: Check, facts: Facts, row: Dict, outcome: Outcome): void {
  const fields = [...COMMON, 'reference', 'dnp', 'in_bom', 'fits'];
  keys(row, fields, fields);
  const ref = item(row, 'reference') as string;
  const part = facts.native.get(ref);
  need(part && typeof item(row, 'dnp') === 'boolean' && typeof item(row, 'in_bom') === 'boolean', 'native population selector/boolean invalid');
  const fits = item(row, 'fits');
  need(isUniqueTexts(fits) && fits.every(name => facts.names.includes(name)), 'unknown/duplicate required variant');
  const actual = { dnp: (part as PartFacts).dnp, in_bom: (part as PartFacts).in_bom, fits: sorted(facts.fits.get(ref) as string[]) };
  need(pyEquals(actual, { dnp: row.get('dnp'), in_bom: row.get('in_bom'), fits: sorted(fits as string[]) }), 'native DNP/BOM/variant population differs');
  Object.assign(outcome, { actual });
}

function checkMode(_check: Check, facts: Facts, row: Dict, outcome: Outcome): void {
  const fields = [...COMMON, 'reference', 'field', 'allowed', 'variant'];
  keys(row, fields, fields);
  const ref = item(row, 'reference') as string;
  const variant = item(row, 'variant') as string;
  need(facts.native.has(ref) && facts.names.includes(variant) && facts.fits.get(ref)?.includes(variant), 'mode part is not fitted in its declared variant');
  const field = item(row, 'field');
  need(typeof field === 'string' && !NOT_MODE_FIELDS.includes(field), 'mode requires an explicit operating-state field');
  const allowed = item(row, 'allowed');
  need(isUniqueTexts(allowed) && allowed.length && allowed.every(isText), 'mode states require explicit unique strings');
  const actual = (item(facts.exported.fields, ref) as Map<string, string>).get(field as string);
  need((allowed as unknown[]).includes(actual), 'declared native operating mode is absent or disallowed');
  Object.assign(outcome, { actual, variant, mode_scope: 'schematic declaration; firmware/runtime state unproved' });
}

function checkLoad(check: Check, facts: Facts, row: Dict, load: unknown, base: string, connected: Set<string>, seen: Set<string>): { low: Decimal; high: Decimal; binding: Record<string, unknown> } {
  keys(load, ['reference', 'demand', 'conditions', 'reviewed_demand'], ['reference', 'conditions', 'reviewed_demand']);
  const ref = item(load, 'reference') as string;
  const net = item(row, 'net');
  need(connected.has(ref) && !seen.has(ref), 'budget load is absent, unfitted, unconnected or duplicated');
  const [original, binding] = reviewedDemand(check, facts, item(load, 'reviewed_demand'), ref, net);
  const required = check.interval(original);
  const [low, high, dimension] = (load as Dict).has('demand') ? check.interval(item(load, 'demand')) : required;
  need(dimension === base && low.compare(Decimal.of('0')) >= 0, 'budget load physical units/range differ');
  need(low.equals(required[0]) && high.equals(required[1]) && dimension === required[2], 'schematic load demand differs from exact reviewed part-use demand');
  const scoped = scopedDemands(check, facts, ref, net);
  need(scoped.every(([, [lowest, highest, units]]) => dimension === units && low.compare(lowest) <= 0 && highest.compare(high) <= 0), 'load would understate another scoped reviewed net demand');
  binding.scoped_budgets = scoped.map(([identifier]) => identifier);
  conditions(item(load, 'conditions'), facts.observed, item(row, 'variant'));
  seen.add(ref);
  return { low, high, binding };
}

function checkBudget(check: Check, facts: Facts, row: Dict, outcome: Outcome): void {
  const fields = [...COMMON, 'net', 'variant', 'limit', 'loads', 'exclusions', 'conditions'];
  keys(row, fields, fields);
  const variant = item(row, 'variant') as string;
  const net = item(row, 'net');
  need(facts.names.includes(variant) && isText(net), 'budget requires exact native net and variant');
  const [lo, hi, base] = check.interval(item(row, 'limit'));
  need((base === 'A' || base === 'W') && lo.compare(Decimal.of('0')) >= 0, 'budget needs nonnegative current or power interval');
  const connected = new Set([...facts.native].filter(([ref, part]) => part.in_bom && facts.fits.get(ref)?.includes(variant) && [...part.pad_net_map.values()].includes(net as string)).map(([ref]) => ref));
  const loads = new Set<string>();
  const excluded = new Set<string>();
  let totalLow = Decimal.of('0');
  let totalHigh = Decimal.of('0');
  const bindings: Record<string, unknown>[] = [];
  for (const load of iterate(item(row, 'loads'))) {
    const { low, high, binding } = checkLoad(check, facts, row, load, base, connected, loads);
    bindings.push(binding);
    totalLow = totalLow.add(low);
    totalHigh = totalHigh.add(high);
  }
  for (const exclusion of iterate(item(row, 'exclusions'))) {
    const names = ['reference', 'reason', 'source'];
    keys(exclusion, names, names);
    check.source(item(exclusion, 'source'));
    const ref = item(exclusion, 'reference') as string;
    const reason = item(exclusion, 'reason');
    need(connected.has(ref) && !excluded.has(ref) && typeof reason === 'string' && strip(reason), 'budget classification requires exact native identity and sourced rationale');
    need(!scopedDemands(check, facts, ref, net).length, 'positive reviewed load cannot be classified as a non-load');
    excluded.add(ref);
  }
  const covered = new Set([...loads, ...excluded]);
  const complete = connected.size > 0 && ![...loads].some(ref => excluded.has(ref)) && covered.size === connected.size && [...covered].every(ref => connected.has(ref));
  need(complete, 'budget lacks complete fitted native net load/classification coverage');
  conditions(item(row, 'conditions'), facts.observed, variant);
  need(lo.compare(totalLow) <= 0 && totalHigh.compare(hi) <= 0, 'summed worst-case demands exceed sourced operating budget');
  Object.assign(outcome, {
    actual: { min: String(totalLow), max: String(totalHigh), unit: base }, covered_references: sorted(connected), variant, reviewed_demand_bindings: bindings,
  });
}

const CHECKS: Record<string, (check: Check, facts: Facts, row: Dict, outcome: Outcome) => void> = {
  value: checkValue, pin_net: checkPinNet, population: checkPopulation, mode: checkMode, budget: checkBudget,
};

function checkAcceptance(check: Check, acceptance: unknown, kind: unknown, outcome: Outcome): void {
  if (item(acceptance, 'kind') !== 'interval') return;
  need(kind === 'value' || kind === 'budget', 'numeric requirement needs an actual value or budget measurement');
  const bounds = new Map(['min', 'max', 'unit', 'source'].map(name => [name, item(acceptance, name)]));
  const [low, high, base] = check.interval(bounds);
  const { actual } = outcome;
  need(actual.unit === base, 'design requirement and measured physical units differ');
  const actualLow = number(actual.min ?? actual.value);
  const actualHigh = number(actual.max ?? actual.value);
  need(low.compare(actualLow) <= 0 && actualLow.compare(actualHigh) <= 0 && actualHigh.compare(high) <= 0, 'actual result does not meet the named design requirement acceptance');
}

function checkAssertion(check: Check, facts: Facts, row: Dict, requirements: Map<unknown, Dict>): void {
  const kind = row.get('kind') ?? null;
  const outcome: Outcome = { id: row.get('id'), kind, requirement: row.get('requirement'), status: 'blocked' };
  try {
    check.source(row.get('source') ?? null);
    const verify = CHECKS[kind as string];
    if (!verify) throw valueError(`unsupported functional assertion kind: ${pyStr(kind)}`);
    verify(check, facts, row, outcome);
    if (kind === 'value') conditions(item(row, 'conditions'), facts.observed, null);
    checkAcceptance(check, item(requirements.get(row.get('requirement')), 'acceptance'), kind, outcome);
    outcome.status = 'passed';
  } catch (error) {
    if (!caught(error, ...ASSERTION_ERRORS)) throw error;
    const detail = (error as Error).message;
    outcome.cause = detail;
    check.report.blockers.push({ code: 'functional_assertion', assertion: row.get('id'), detail });
  }
  facts.observed.set(row.get('id'), outcome);
  check.report.assertions.push(outcome);
}

function checkReview(check: Check, value: Dict, board: string): void {
  need(item(value, 'schema') === SCHEMA && item(value, 'board') === board, 'functional contract schema/board mismatch');
  const review = item(value, 'review');
  keys(review, REVIEW_FIELDS, REVIEW_FIELDS);
  const reviewer = item(review, 'reviewer');
  need(item(review, 'verdict') === 'passed' && typeof reviewer === 'string' && strip(reviewer), 'functional review is pending');
  need(parseIso(item(review, 'reviewed_at_utc') as string).zoned, 'review timestamp needs a timezone');
  need(item(review, 'facts_sha256') === factsDigest(value), 'review does not bind these functional assertions');
  check.source(item(review, 'evidence'));
}

/** The variant names and the fit of each native part, from the bound policy or its recorded absence. */
function population(check: Check, value: Dict, board: string, native: Map<string, PartFacts>): { names: string[]; fits: Map<string, string[]> } {
  const fields = ['path', 'exists', 'sha256'];
  const source = deepCopy(item(value, 'population_source'));
  keys(source, fields, fields);
  const name = item(source, 'path');
  need(name === `hardware-design/boards/${board}/variants.json`, 'variant policy must name this exact board owner');
  const descriptor = { path: joinPath(check.root, name), exists: item(source, 'exists'), sha256: item(source, 'sha256') };
  verifyPopulationSource({ board, population_source: descriptor });
  const { report } = check;
  report.population_source = descriptor;
  if (!descriptor.exists) {
    report.absent_inputs.push(descriptor.path);
    return { names: ['DEFAULT'], fits: new Map([...native].map(([ref, part]) => [ref, part.required ? ['DEFAULT'] : []])) };
  }
  const variants = read(descriptor.path);
  const names = item(variants, 'variants');
  const fits = item(variants, 'fit');
  need(isUniqueTexts(names) && names.length && names.every(isText), 'invalid variant names');
  const covered = isDict(fits) && fits.size === native.size && [...fits.keys()].every(ref => native.has(ref));
  need(covered, 'variant fit does not cover exact native parts');
  for (const [ref, rows] of fits as Dict) need(isUniqueTexts(rows) && rows.every(row => (names as string[]).includes(row)), `invalid fit list for ${ref}`);
  report.inputs[descriptor.path] = descriptor.sha256;
  return { names: names as string[], fits: fits as Map<string, string[]> };
}

/** The named requirements of the assertions. load_contract already validated the complete requirement set. */
function namedRequirements(design: Record<string, unknown>, assertions: Dict[]): Map<unknown, Dict> {
  const declared = new Map((design.requirements as Record<string, unknown>[]).map(row => [row.id, row]));
  const named = new Map<unknown, Dict>();
  for (const row of assertions) {
    const requirement = row.get('requirement');
    need(isText(requirement), 'assertion requires an exact design requirement ID');
    const found = declared.get(requirement);
    need(found, `unknown design requirement: ${requirement as string}`);
    // Through JSON: the design loader gives plain values, this module jsonLoads ones.
    const value = jsonLoads(jsonDumps(found)) as Dict;
    need(value.get('verification_stage') === 'schematic', 'requirement belongs to another verification stage');
    named.set(requirement, value);
  }
  return named;
}

function artifactFolder(root: string, output: string | undefined): string {
  if (output === undefined) {
    const base = joinPath(root, '.gate/schematic');
    mkdirSync(base, { recursive: true });
    return mkdtempSync(joinPath(base, 'check-'));
  }
  const artifacts = `${withSuffix(resolvePath(output), '')}-native`;
  if (existsSync(artifacts)) throw osError(Object.assign(new Error('exists'), { code: 'EEXIST', path: artifacts }));
  mkdirSync(artifacts, { recursive: true });
  return artifacts;
}

/** The PCB as placer/dru.py reads it: quoted atoms keep their escapes, and a line starting with # is a comment. */
function pcbForms(text: string): Tree {
  const lines = splitlines(text).filter(line => !strip(line).startsWith('#')).join('\n');
  const stack: Tree[] = [[]];
  for (const [token] of lines.matchAll(/"(?:[^"\\]|\\.)*"|\(|\)|[^\s()]+/g)) {
    if (token === '(') stack.push([]);
    else if (token === ')') {
      const closed = stack.pop() as Tree;
      (stack.at(-1) as Tree).push(closed);
    } else (stack.at(-1) as Tree).push(token.startsWith('"') ? token.slice(1, -1) : token);
  }
  return stack[0] as Tree;
}

export function checkNativeIdentity(native: Map<string, PartFacts>, exported: Exported): void {
  for (const [ref, part] of native) {
    const fields = exported.fields.get(ref);
    const noPart = part.identity_free && exported.comps.has(ref) && !fields?.get('MPN') && !fields?.get('LCSC');
    need(noPart || exported.comps.get(ref) === part.mpn, `native export part identity differs: ${ref}`);
    for (const pin of part.pin_map.keys()) {
      const net = part.pad_net_map.get(pin);
      if (net && !net.startsWith('unconnected-')) need(exported.pins.get(pinKey(ref, pin))?.net === net, `actual schematic/PCB connected pin differs: ${ref}.${pin}`);
    }
  }
}

function assertionsOf(value: Dict): Dict[] {
  const assertions = item(value, 'assertions');
  need(Array.isArray(assertions) && assertions.length, 'explicit functional assertions required');
  const rows = assertions as unknown[];
  const ids = rows.filter(isDict).map(row => row.get('id') ?? null);
  need(ids.length === rows.length && ids.every(isText) && ids.length === new Set(ids).size, 'assertion IDs must be unique nonempty strings');
  return rows as Dict[];
}

const rank = (row: Dict) => (row.get('kind') === 'mode' ? 0 : row.get('kind') === 'budget' ? 2 : 1);

async function runChecks(check: Check, board: string, path: string, output: string | undefined, exporter: Exporter): Promise<void> {
  const { root, report } = check;
  relativeTo(path, root);
  const value = read(path);
  report.inputs[path] = sha(path);
  keys(value, CONTRACT_FIELDS, CONTRACT_FIELDS);
  checkReview(check, value, board);
  const designPath = check.boundFile(item(value, 'design_contract'));
  const partPath = check.boundFile(item(value, 'part_review'));
  const design = loadContract(root, designPath, SOURCES) as Record<string, any>;
  need(design.identity.board === board, 'design requirements do not name this actual native board');
  const partReview = verifyManifest(root, board, partPath);
  report.native_inputs = partReview.native_inputs;
  for (const inputs of [partReview.inputs, partReview.native_inputs]) {
    for (const [name, digest] of Object.entries(inputs)) report.inputs[joinPath(root, name)] = digest;
  }
  Object.assign(report.tool_inputs, partReview.tool_inputs);
  need(partReview.status === 'passed', `native part evidence is incomplete: ${jsonDumps(partReview.blockers)}`);
  const native = partReview.bindings;
  const reviewedParts = read(partPath);
  const { project } = boardConfig(root, board);
  need(item(value, 'project') === relativeTo(project, root), 'functional contract targets another native project');
  const projectFile = withSuffix(project, '.kicad_pro');
  if (isFile(projectFile)) report.inputs[projectFile] = sha(projectFile);
  const { names, fits } = population(check, value, board, native);
  const assertions = assertionsOf(value);
  const requirements = namedRequirements(design, assertions);
  for (const name of designDependencies(root, designPath, null, SOURCES)) {
    const target = owned(root, name);
    report.inputs[target] = sha(target);
  }
  report.tool_inputs[DESIGN_FILE] = sha(DESIGN_FILE);
  const artifacts = artifactFolder(root, output);
  const { parsed: exported, evidence, tools } = await exporter(withSuffix(project, '.kicad_sch'), artifacts);
  Object.assign(report.inputs, evidence);
  Object.assign(report.tool_inputs, tools);
  report.evidence_directory = artifacts;
  const pcbTree = pcbForms(textOf(withSuffix(project, '.kicad_pcb')))[0] as Tree;
  const pcb = new Map(children(pcbTree, 'footprint').map(form => [properties(form).get('Reference') as string, properties(form)]));
  checkNativeIdentity(native, exported);
  const facts: Facts = { native, exported, pcb, names, fits, reviewedParts, observed: new Map() };
  for (const row of [...assertions].sort((a, b) => rank(a) - rank(b))) checkAssertion(check, facts, row, requirements);
  for (const requirement of requirements.keys()) {
    const rows = report.assertions.filter(row => row.requirement === requirement);
    report.requirement_results[requirement as string] = {
      status: rows.length && rows.every(row => row.status === 'passed') ? 'passed' : 'blocked', assertions: rows.map(row => row.id),
    };
  }
  verifyPopulationSource({ board, population_source: report.population_source as never });
  for (const [name, digest] of Object.entries({ ...report.inputs, ...report.tool_inputs })) need(sha(name) === digest, `functional input changed during verification: ${name}`);
  Object.assign(report, {
    status: report.blockers.length ? 'blocked' : 'passed',
    coverage: {
      declared_assertions: assertions.length, passed_assertions: report.assertions.filter(row => row.status === 'passed').length, referenced_requirements: requirements.size,
      unknown_requirements: 'not declared here; evaluate the design contract for stage coverage',
    },
  });
}

export async function checkContract(rootPath: string, board: string, contractPath: string, output?: string, exporter: Exporter = exportNative): Promise<SchematicReport> {
  const root = resolvePath(rootPath);
  const path = resolvePath(contractPath);
  const report: SchematicReport = {
    schema: RESULT, scope: 'declared_schematic_functions', board, status: 'blocked', qualified: false, release_approved: false, stock_current: false,
    assertions: [], requirement_results: {}, blockers: [], inputs: {}, absent_inputs: [], native_inputs: {}, tool_inputs: { [THIS_FILE]: sha(THIS_FILE) },
    native_export_cache: { status: 'fresh_export_required', hit: false, reusable: false, reason: 'complete external library/project-variable closure is not certified for receipt reuse' },
    limits: ['Declared assertions only; simulation, firmware behavior, ERC/DRC and bench qualification remain separate.'],
  };
  try {
    await runChecks(new Check(root, report), board, path, output, exporter);
  } catch (error) {
    if (!caught(error, ...REPORT_ERRORS) && !isPlainError(error)) throw error;
    report.blockers.push({ code: 'invalid_functional_contract', detail: (error as Error).message });
  }
  return report;
}
