// What a native report and a final PCB say about a routed candidate. Not electrical merit.
import { basename } from 'node:path';
import { sha256File } from './json-file.ts';
import { asDict, type Evidence } from './outcome-evidence.ts';
import { compare, jsonCanonical } from './py-compat.mjs';
import { fsum, hypot } from './py-math.ts';
import { isFile, joinPath, textOf } from './py-path.ts';
import { type Dict } from './py-values.ts';
import { forms, tokens, type SExpr, type SList } from './sexpr.ts';

const LENGTH = 'routed_track_length_mm', VIAS = 'routed_via_count';
const SEVERITIES = ['error', 'warning', 'exclusion'];
const COPPER_LAYER = /^(?:F|B|In[1-9]\d*)\.Cu$/;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export interface NativeCounts { errors: number; warnings: number; opens: number; parity: number }

export function nativeObservation(evidence: Evidence, folder: string, gate: Dict, candidate: string | null): NativeCounts | null {
  const path = joinPath(folder, 'gate/drc.json');
  if (!isFile(path)) return null;
  const raw = evidence.read(path);
  const violations = raw.violations as Dict[];
  if (candidate === null || raw.source !== basename(candidate) || raw.coordinate_units !== 'mm'
      || !((raw.included_severities ?? []) as string[]).includes('error')
      || ['violations', 'unconnected_items', 'schematic_parity'].some(key => !Array.isArray(raw[key]))
      || violations.some(row => !SEVERITIES.includes(row.severity as string))
      || !['passed', 'failed'].includes(asDict(asDict(gate.checks).drc).status as string)) {
    throw new Error('native report is incomplete, unknown or bound to another candidate');
  }
  const digest = sha256File(candidate);
  const bound = ((asDict(gate.provenance).inputs ?? []) as Dict[]).filter(row => basename((row.path as string) ?? '') === basename(candidate) && row.sha256 === digest);
  if (bound.length !== 1) throw new Error('native gate does not bind exact routed candidate bytes');
  const result: NativeCounts = {
    errors: violations.filter(row => row.severity === 'error').length, warnings: violations.filter(row => row.severity === 'warning').length,
    opens: (raw.unconnected_items as unknown[]).length, parity: (raw.schematic_parity as unknown[]).length,
  };
  const metrics = asDict(gate.metrics);
  if (metrics.drc_errors !== result.errors || metrics.drc_unconnected !== result.opens || metrics.drc_parity !== result.parity) {
    throw new Error('native counts disagree with completed gate metrics');
  }
  return result;
}

/**
 * The exact authored copper multiset; zone fill geometry is a cache. KiCad may reorder standalone items on save, so only
 * top-level forms sort. Every authored value, UUID, nested order and duplicate item stays.
 */
export function retainedCopper(root: SList): SList[] {
  const copper = root.slice(1).filter((form): form is SList => Array.isArray(form) && ['segment', 'arc', 'via', 'zone'].includes(form[0] as string))
    .map(form => form[0] !== 'zone' ? form : form.filter(item => !(Array.isArray(item) && ['filled_polygon', 'fill_segments'].includes(item[0] as string))));
  return copper.map(form => [jsonCanonical(form), form] as const).sort(([a], [b]) => compare(a, b)).map(([, form]) => form);
}

function fieldOf(form: SList, key: string, count: number): string[] {
  const values = form.slice(1).filter((item): item is SList => Array.isArray(item) && item[0] === key).map(item => item.slice(1));
  const only = values[0];
  if (values.length !== 1 || only?.length !== count || only.some(value => typeof value !== 'string')) {
    throw new Error(`missing or malformed ${String(form[0])}.${key}`);
  }
  return only as string[];
}

function coordinate(text: string): number {
  if (!NUMBER.test(text)) throw new Error('invalid native numeric coordinate or dimension');
  const value = Number(text);
  if (!Number.isFinite(value)) throw new Error('nonfinite native coordinate or dimension');
  return value;
}

function positive(form: SList, key: string): number {
  const value = coordinate(fieldOf(form, key, 1)[0] as string);
  if (value <= 0) throw new Error(`nonpositive ${String(form[0])}.${key}`);
  return value;
}

const pointOf = (form: SList, key: string): [number, number] => fieldOf(form, key, 2).map(coordinate) as [number, number];

function trackLength(rows: SList[]): number {
  const lengths: number[] = [];
  for (const form of rows) {
    if (form[0] === 'arc') throw new Error('copper arc centreline measurement is unsupported');
    if (form[0] !== 'segment') continue;
    const [x0, y0] = pointOf(form, 'start'), [x1, y1] = pointOf(form, 'end');
    positive(form, 'width');
    if (!COPPER_LAYER.test(fieldOf(form, 'layer', 1)[0] as string)) throw new Error('unsupported segment copper layer');
    const length = hypot(x1 - x0, y1 - y0);
    if (!Number.isFinite(length)) throw new Error('nonfinite segment length');
    lengths.push(length);
  }
  const total = fsum(lengths);
  if (!Number.isFinite(total)) throw new Error('nonfinite total track length');
  return total;
}

function viaCount(rows: SList[]): number {
  let count = 0;
  for (const form of rows) {
    if (form[0] !== 'via') continue;
    pointOf(form, 'at');
    const diameter = positive(form, 'size'), drill = positive(form, 'drill');
    if (drill > diameter) throw new Error('via drill exceeds diameter');
    const [from, to] = fieldOf(form, 'layers', 2) as [string, string];
    if (from === to || !COPPER_LAYER.test(from) || !COPPER_LAYER.test(to)) throw new Error('unsupported via copper layers');
    count++;
  }
  return count;
}

function pcbForms(text: string): SList[] {
  let depth = 0;
  const list = tokens(text);
  for (const token of list) {
    depth += Number(token === '(') - Number(token === ')');
    if (depth < 0) throw new Error('unbalanced native PCB');
  }
  if (depth) throw new Error('unbalanced native PCB');
  const roots = forms(text);
  const root = roots[0];
  if (roots.length !== 1 || !Array.isArray(root) || !root.length || root[0] !== 'kicad_pcb') throw new Error('expected one native PCB');
  const rows = root.slice(1);
  if (rows.some((form: SExpr) => !Array.isArray(form) || typeof form[0] !== 'string')) throw new Error('malformed native PCB form');
  return rows as SList[];
}

const attempt = <T>(measure: () => T, name: string, unknowns: Dict): T | null => {
  try {
    return measure();
  } catch (error) {
    unknowns[name] = (error as Error).message;
    return null;
  }
};

/**
 * The accepted final native PCB in millimetres: the whole candidate's track centreline length and via count, not newly
 * routed copper, pad or zone copper, vertical via length or electrical merit. Unsupported track geometry invalidates
 * length independently of via count.
 */
export function routedQuality(evidence: Evidence, candidate: string): Dict {
  const path = evidence.file(candidate);
  const expected = evidence.inputs.get(path) as string;
  const unknowns: Dict = {};
  const result: Dict = {
    [LENGTH]: null, [VIAS]: null, candidate: { path, sha256: expected },
    scope: 'entire final native candidate; retained copper included; pad/zone and vertical via length excluded',
    units: { [LENGTH]: 'mm', [VIAS]: 'count' }, unknowns,
  };
  let rows: SList[] | null = null;
  try {
    rows = pcbForms(textOf(path));
  } catch (error) {
    unknowns[LENGTH] = (error as Error).message;
    unknowns[VIAS] = (error as Error).message;
  }
  if (rows) {
    const parsed = rows;
    result[LENGTH] = attempt(() => trackLength(parsed), LENGTH, unknowns);
    result[VIAS] = attempt(() => viaCount(parsed), VIAS, unknowns);
  }
  evidence.file(path, expected);   // Mutated sealed input is an evidence failure, never merely an unknown metric.
  return result;
}
