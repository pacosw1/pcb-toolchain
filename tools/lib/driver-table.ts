// tools/driver-edges.json: edge time per driver pin, per part, with its source, and what that source proves.
//
// Rules stay the values jsonLoads gives. A reviewed minimum is bound to a hash of its exact record, tr_ns: 3 and 3.0 are
// different text, and the hash is taken again at each use, so a record changed after loading proves nothing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fingerprint } from './fingerprint.ts';
import { fnmatchCase } from './fnmatch.ts';
import { sha256 } from './kicad-population.mjs';
import { get, item, jsonLoad, PyError, pyStr, strip } from './py-compat.mjs';
import { pyFloat } from './py-numbers.ts';
import { isFile } from './py-path.ts';
import { fileRoot } from './project-root.mjs';
import { isDict, isPositive, iterate, pyEquals, type Dict } from './py-dict.ts';

export const TABLE_FILE = join(fileRoot, 'tools/driver-edges.json');
export const ROLES = ['input', 'push_pull', 'open_drain', 'opto', 'unknown'];
const ROLE_TEXT = `(${ROLES.map(role => `'${role}'`).join(', ')})`;
const EVIDENCE_FOLDERS = ['hardware-design/registry/datasheets/', 'hardware-design/registry/ibis/'];
const IBIS_METADATA = ['component', 'supply_pin', 'url', 'downloaded'];

export type DriverTable = Map<string, Dict>;

export class TableError extends PyError {
  constructor(message: string) {
    super('ValueError', message);
  }
}

const present = (value: unknown): boolean => strip(pyStr(value)) !== '';
const fullMatch = (pattern: string, text: string): boolean => new RegExp(`^(?:${pattern})$`).test(text);

/** Conditional minimum reviewed in accepted D124a source: LAN8742A DS00001989A Table 5-8, Note 1. Binding includes
 * part/MPN/pin/values/stat/load/source, not a mutable `stat=min` label. New reviewed bounds need explicit source
 * registration. */
const REVIEWED_MINIMUMS = new Map([
  ['7899c7bb904687e8144540d486d688a41f34ba7a271b0615dd565fa8c44fccde',
    ['hardware-design/registry/datasheets/LAN8742A-CZ-TR_C621424.pdf', '35d5d7e4f278efc2c72be68521796ace36f36f0fe46822d065747dd5872fc8ef'] as const],
]);

export function minimumRecordHash(key: unknown, mpns: unknown, rule: Dict): string {
  const clean = new Map([...rule].filter(([name]) => name !== '_minimum_proof'));
  return fingerprint(new Map<string, unknown>([['part', key], ['mpn', mpns], ['rule', clean]]));
}

/** Minted by the table loader only after the exact primary evidence is verified. */
export class ReviewedMinimumProof {
  readonly recordSha: string;
  readonly source: readonly [string, string];
  readonly boundary: string;
  readonly conditions: string;
  readonly appliesToDriver: boolean;

  constructor(recordSha: string, source: readonly [string, string], boundary: string, conditions: string, appliesToDriver: boolean) {
    this.recordSha = recordSha;
    this.source = source;
    this.boundary = boundary;
    this.conditions = conditions;
    this.appliesToDriver = appliesToDriver;
  }

  matches(key: unknown, mpns: unknown, rule: Dict): boolean {
    return minimumRecordHash(key, mpns, rule) === this.recordSha;
  }
}

/** Checks the exact local evidence declared by the stable driver/class table. */
export function verifyEvidence(raw: unknown, root: string = fileRoot): void {
  for (const evidence of iterate(get(raw, 'evidence_files', []))) {
    const path = pyStr(get(evidence, 'path', ''));
    if (!EVIDENCE_FOLDERS.some(folder => path.startsWith(folder)) || path.split('/').includes('..')) throw new TableError('invalid driver evidence path');
    const file = join(root, path);
    if (!isFile(file) || sha256(readFileSync(file)) !== get(evidence, 'sha256')) throw new TableError(`missing or changed driver evidence: ${path}`);
  }
}

function checkBound(bound: Dict, role: unknown, where: string): void {
  if (!isPositive(bound.get('i_ma')) || !present(get(bound, 'i_source', ''))) throw new TableError(`${where}: a bound needs i_ma > 0 and i_source`);
  const supply = bound.get('supply_pin') || isPositive(bound.get('vdd_v')) || (role === 'open_drain' && bound.get('pullup'));
  if (!supply) throw new TableError(`${where}: a bound needs supply_pin, vdd_v or (open drain) "pullup": true`);
  if (bound.has('cpin_pf') && (!isPositive(bound.get('cpin_pf')) || !present(get(bound, 'cpin_source', '')))) {
    throw new TableError(`${where}: cpin_pf needs a value > 0 and cpin_source`);
  }
}

function checkIbis(ibis: Dict, key: string, evidence: unknown[]): void {
  const source = new Map([['path', ibis.get('file') ?? null], ['sha256', ibis.get('sha256') ?? null]]);
  if (!evidence.some(row => pyEquals(row, source))) throw new TableError(`${key}: IBIS source closure missing`);
  if (!IBIS_METADATA.every(name => typeof ibis.get(name) === 'string' && strip(ibis.get(name) as string))) {
    throw new TableError(`${key}: incomplete IBIS source/model metadata`);
  }
  const variants = ibis.get('variants');
  if (!isDict(variants) || !variants.size) throw new TableError(`${key}: missing IBIS voltage variants`);
  for (const [volts, suffix] of variants) {
    let voltage: number;
    try {
      voltage = pyFloat(volts);
    } catch {
      throw new TableError(`${key}: invalid IBIS voltage variant`);
    }
    if (!isPositive(voltage) || typeof suffix !== 'string' || !suffix) throw new TableError(`${key}: invalid IBIS voltage/model suffix`);
  }
}

function checkRule(rule: Dict, part: Dict, where: string): void {
  const role = rule.get('role');
  if (!ROLES.includes(role as string) || typeof rule.get('match') !== 'string') throw new TableError(`${where}: needs "match" (regex) and a role of ${ROLE_TEXT}`);
  if (rule.get('ibis_model') && !isDict(part.get('ibis'))) throw new TableError(`${where}: IBIS model needs source binding`);
  if (rule.has('bound')) checkBound(rule.get('bound') as Dict, role, where);
  const alternative = rule.get('ibis_model') || rule.has('bound');
  if ((role === 'push_pull' || role === 'opto') && !alternative && !(isPositive(rule.get('tr_ns')) && isPositive(rule.get('tf_ns')))) {
    throw new TableError(`${where}: ${pyStr(role)} needs tr_ns and tf_ns > 0`);
  }
  if (role === 'open_drain' && !alternative && !isPositive(rule.get('tf_ns'))) throw new TableError(`${where}: open_drain needs tf_ns > 0 (the driver fall time)`);
  if (role !== 'input' && !present(get(rule, 'source', ''))) throw new TableError(`${where}: a ${pyStr(role)} rule needs a source (or the reason it is unknown)`);
}

function bindMinimum(rule: Dict, key: string, part: Dict, evidence: unknown[], where: string): void {
  const recordSha = minimumRecordHash(key, part.get('mpn'), rule);
  const source = REVIEWED_MINIMUMS.get(recordSha);
  if (!source) return;
  const declared = new Map([['path', source[0]], ['sha256', source[1]]]);
  if (!evidence.some(row => pyEquals(row, declared))) throw new TableError(`${where}: reviewed minimum primary evidence declaration missing/changed`);
  rule.set('_minimum_proof', new ReviewedMinimumProof(recordSha, source, 'line side of transformer',
    'Measured at line side of transformer, line replaced by 100 ohm (+/-1%) resistor.', false));
}

function checkPart(key: string, part: Dict, path: string, evidence: unknown[]): void {
  const mpn = part.get('mpn');
  const pins = part.get('pins');
  if (!Array.isArray(mpn) || !mpn.length || !Array.isArray(pins)) throw new TableError(`${path}: part ${key} needs "mpn" (patterns) and "pins" (rules)`);
  if (part.has('pin_c')) {
    const pinC = part.get('pin_c');
    if (!isPositive(get(pinC, 'pf')) || !present(get(pinC, 'source', ''))) throw new TableError(`${key}: invalid sourced pin capacitance`);
  }
  if (part.has('ibis')) checkIbis(part.get('ibis') as Dict, key, evidence);
  pins.forEach((rule: Dict, index: number) => {
    const where = `${path}: part ${key} pin rule ${index}`;
    checkRule(rule, part, where);
    bindMinimum(rule, key, part, evidence, where);
  });
}

/** The parts of the table. Each rule needs a role; a driver role needs its times and a source. */
export function loadTable(path: string = TABLE_FILE, root: string = fileRoot): DriverTable {
  const raw = jsonLoad(path);
  verifyEvidence(raw, root);
  const parts = get(raw, 'parts');
  if (!isDict(parts) || !parts.size) throw new TableError(`${path}: "parts" must be an object`);
  const evidence = iterate(get(raw, 'evidence_files', []));
  for (const [key, part] of parts) checkPart(key, part as Dict, path, evidence);
  return parts as DriverTable;
}

export function partOf(mpn: string, table: DriverTable): [string, Dict] | [null, null] {
  for (const [key, part] of table) {
    if (iterate(item(part, 'mpn')).some(pattern => fnmatchCase(mpn, pattern as string))) return [key, part];
  }
  return [null, null];
}

/** The first rule of `part` whose pattern matches the whole pin name. */
export const ruleOf = (part: Dict, pin: string): Dict | undefined =>
  iterate(item(part, 'pins')).find(rule => fullMatch(item(rule, 'match') as string, pin)) as Dict | undefined;

export const classApplies = (partClass: unknown, mpn: string, pin: string): boolean => {
  const applicability = item(partClass, 'applicability');
  return iterate(item(applicability, 'mpn')).some(pattern => fnmatchCase(mpn, pattern as string)) && fullMatch(item(applicability, 'pins') as string, pin);
};

/** Screening statistics are not fastest-edge lower bounds. A reviewed MIN record bounds the stated datasheet load and
 * conditions only; board-level model or measurement qualification remains independent. */
export function timingEvidence(record: Dict, partKey?: unknown, partMpns?: unknown): Record<string, unknown> {
  const stat = get(record, 'stat', 'unspecified');
  const proof = record.get('_minimum_proof');
  const verified = stat === 'min' && !record.get('assumption') && proof instanceof ReviewedMinimumProof && proof.matches(partKey ?? null, partMpns ?? null, record);
  const qualified = verified && proof.appliesToDriver;
  return {
    stat, qualified_fastest_bound: qualified, source_MIN_verified: verified, applicable_driver_bound: qualified,
    source: get(record, 'source', ''), load: get(record, 'load', 'not recorded'), scope: 'stated source conditions only; board-level qualification separate',
    measurement_boundary: verified ? proof.boundary : null, source_conditions: verified ? proof.conditions : null,
    reviewed_record_sha256: verified ? proof.recordSha : null,
    primary_evidence: verified ? { path: proof.source[0], sha256: proof.source[1] } : null,
    reason: qualified ? 'hash-bound reviewed minimum with matched driver measurement boundary/conditions'
      : verified ? 'line-side transformer minimum does not establish pre-transformer TXP/TXN chip-pad bound'
        : 'screening value; no reviewed fastest-edge lower bound',
  };
}
