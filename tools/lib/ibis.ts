// Source-bound IBIS ramp and static V-I screening (D-124c).
//
// IBIS 7.2 [Ramp] defines a 20-80 % loaded swing, package excluded, C_comp included. Original vendor bytes stay
// unchanged; corner omissions and load/PVT remain explicit. Absent corners never inherit typical values.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { osError, splitlines, strip } from './py-compat.mjs';
import { resolvePath } from './py-path.ts';

export const CORNERS = ['typ', 'min', 'max'] as const;
export type Corner = (typeof CORNERS)[number];
type Edge = 'r' | 'f';

const SUFFIX: Record<string, number> = { T: 1e12, G: 1e9, M: 1e6, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 };
const UNITS = new Set(['', 'V', 'A', 'F', 'H', 's', 'ohm', 'ohms', 'Ohm', 'Ohms']);
const NUMBER = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)([TGMkmunpf]?)([A-Za-z]*)$/;
const OUTPUT_TYPES = new Set(['output', 'i/o', '3-state', 'open_drain', 'open_sink', 'open_source']);
const METHOD = 'max(ramp 10-90 time, static V-I arithmetic-mean C*dV/I), D-124e';

export class IbisError extends Error {}

/** typ, min, max; null is an NA corner. */
export type Triple = (number | null)[];
export type ViRow = [volts: number, currents: Triple];
export type RampCorner = [dv: number, dt: number] | null;

export interface Model {
  name: string;
  type: string | null;
  c_comp: Triple | null;
  ramp: Partial<Record<Edge, RampCorner[]>>;
  vi: { pulldown?: ViRow[]; pullup?: ViRow[] };
  pullup_ref: Triple | null;
  r_load: number;
  r_load_default: boolean;
  voltage_range: Triple | null;
  temperature_range: Triple | null;
}

export interface Parsed {
  /** By lower-case model name. */
  models: Map<string, Model>;
  /** By component, then pin: [signal name, model name]. */
  pins: Map<string, Map<string, [string, string]>>;
  /** By lower-case selector name: lower-case model names. */
  selectors: Map<string, string[]>;
}

export interface Loaded extends Parsed {
  source_sha256: string;
  source_path: string;
  decoding: string;
}

/** A number, or null for NA. */
export function number(input: string): number | null {
  const text = strip(input);
  if (text.toUpperCase() === 'NA') return null;
  const match = NUMBER.exec(text);
  if (!match) throw new IbisError(`invalid IBIS number: ${text}`);
  const [, digits, suffix, unit] = match as unknown as [string, string, string, string];
  if (!UNITS.has(unit)) throw new IbisError(`unsupported IBIS unit: ${text}`);
  const value = Number(digits) * (SUFFIX[suffix] ?? 1);
  if (!Number.isFinite(value)) throw new IbisError(`nonfinite IBIS number: ${text}`);
  return value;
}

function triple(words: string[]): Triple {
  if (words.length !== 3) throw new IbisError('expected typ/min/max triple');
  return words.map(number);
}

const rampCorner = (word: string): RampCorner => {
  if (word.toUpperCase() === 'NA') return null;
  const parts = word.split('/');
  if (parts.length !== 2) throw new IbisError('ramp requires explicit dV/dt fraction');
  const [dv, dt] = parts.map(number);
  if (dv === null || dt === null || dv === undefined || dt === undefined || dv <= 0 || dt <= 0) {
    throw new IbisError('nonpositive ramp dV/dt');
  }
  return [dv, dt];
};

function newModel(name: string): Model {
  return {
    name, type: null, c_comp: null, ramp: {}, vi: {}, pullup_ref: null, r_load: 50.0, r_load_default: true,
    voltage_range: null, temperature_range: null,
  };
}

/** The reader of one .ibs file: a [keyword] line changes section, other lines belong to the section they stand in. */
class Reader {
  readonly models = new Map<string, Model>();
  readonly pins = new Map<string, Map<string, [string, string]>>();
  readonly selectors = new Map<string, string[]>();
  private model: Model | null = null;
  private component: Map<string, [string, string]> | null = null;
  private selector: string[] = [];
  private section = '';

  keyword(name: string, argument: string): void {
    this.section = strip(name).toLowerCase();
    const model = this.model;
    switch (this.section) {
      case 'component': return this.startComponent(argument);
      case 'model': return this.startModel(argument);
      case 'model selector': return this.startSelector(argument);
      case 'end': this.model = null; return;
      case 'voltage range': if (model) this.range(model, 'voltage_range', argument); return;
      case 'temperature range': if (model) this.range(model, 'temperature_range', argument); return;
      case 'pullup reference': if (model) this.range(model, 'pullup_ref', argument); return;
      case 'pulldown':
      case 'pullup':
        if (!model) return;
        if (model.vi[this.section]) throw new IbisError('duplicate V-I table');
        model.vi[this.section] = [];
    }
  }

  private startComponent(name: string): void {
    this.model = null;
    if (this.pins.has(name)) throw new IbisError(`duplicate component: ${name}`);
    this.component = new Map();
    this.pins.set(name, this.component);
  }

  private startModel(name: string): void {
    const key = name.toLowerCase();
    if (this.models.has(key)) throw new IbisError(`duplicate model: ${name}`);
    this.model = newModel(name);
    this.models.set(key, this.model);
  }

  private startSelector(name: string): void {
    const key = name.toLowerCase();
    if (this.selectors.has(key)) throw new IbisError(`duplicate selector: ${name}`);
    this.selector = [];
    this.selectors.set(key, this.selector);
  }

  private range(model: Model, key: 'voltage_range' | 'temperature_range' | 'pullup_ref', argument: string): void {
    if (model[key] !== null) throw new IbisError(`duplicate ${this.section}`);
    model[key] = triple(argument.split(/\s+/).filter(Boolean));
  }

  row(line: string): void {
    const words = line.split(/\s+/);
    const { model, section } = this;
    if (section === 'pin' && this.component) this.pin(this.component, words);
    else if (section === 'model selector') this.selector.push((words[0] as string).toLowerCase());
    else if (section === 'model' && model) this.modelLine(model, words);
    else if ((section === 'pulldown' || section === 'pullup') && model) viRow(model.vi[section] as ViRow[], words);
    else if (section === 'ramp' && model) rampLine(model, words, line);
  }

  private pin(component: Map<string, [string, string]>, words: string[]): void {
    const [pin, signal, model] = words;
    if (pin === undefined || signal === undefined || model === undefined) throw new IbisError('malformed pin');
    if (component.has(pin)) throw new IbisError('duplicate component pin');
    component.set(pin, [signal, model]);
  }

  private modelLine(model: Model, words: string[]): void {
    const key = (words[0] as string).toLowerCase();
    if (key === 'model_type') {
      if (words[1] === undefined) throw new IbisError('malformed Model_type');
      model.type = words[1];
    } else if (key === 'c_comp') {
      model.c_comp = triple(words.slice(1));
      if (model.c_comp.some(v => v !== null && v < 0)) throw new IbisError('negative C_comp');
    }
  }
}

function viRow(rows: ViRow[], words: string[]): void {
  if (words.length !== 4) throw new IbisError('malformed V-I row');
  const volts = number(words[0] as string);
  const currents = triple(words.slice(1));
  if (volts === null || currents[0] === null) throw new IbisError('missing V-I voltage or typical current');
  const last = rows.at(-1);
  if (last && volts <= last[0]) throw new IbisError('V-I voltages must strictly increase');
  rows.push([volts, currents]);
}

function rampLine(model: Model, words: string[], line: string): void {
  const key = (words[0] as string).toLowerCase();
  if (key === 'dv/dt_r' || key === 'dv/dt_f') {
    if (words.length !== 4) throw new IbisError('malformed ramp triple');
    const corners = words.slice(1).map(rampCorner);
    if (corners[0] === null) throw new IbisError('typical ramp missing');
    const edge = key.endsWith('r') ? 'r' : 'f';
    if (model.ramp[edge]) throw new IbisError('duplicate ramp edge');
    model.ramp[edge] = corners;
    return;
  }
  const load = /^r_load\s*=\s*(\S+)$/i.exec(line);
  if (!load) return;
  const ohms = number(load[1] as string);
  if (ohms === null || ohms <= 0) throw new IbisError('nonpositive R_load');
  model.r_load = ohms;
  model.r_load_default = false;
}

export function parse(lines: Iterable<string>): Parsed {
  const reader = new Reader();
  for (const raw of lines) {
    const line = strip(raw.split('|', 1)[0] as string);
    if (!line) continue;
    const head = /^\[([^\]]+)\]\s*(.*)/.exec(line);
    if (head) reader.keyword(head[1] as string, strip(head[2] as string));
    else reader.row(line);
  }
  return { models: reader.models, pins: reader.pins, selectors: reader.selectors };
}

const cache = new Map<string, Loaded>();

/** The parsed file, once per content. A wrong `expectedSha256` is an error, never a stale result. */
export function load(file: string, expectedSha256?: string | null): Loaded {
  const path = resolvePath(file);
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch (error) {
    throw osError(error, path);
  }
  const sha = createHash('sha256').update(data).digest('hex');
  if (expectedSha256 !== undefined && expectedSha256 !== null && sha !== expectedSha256) {
    throw new IbisError(`IBIS source hash mismatch: ${path}`);
  }
  const key = `${path}\0${sha}`;
  let result = cache.get(key);
  if (!result) {
    result = {
      ...parse(splitlines(new TextDecoder('utf-8', { ignoreBOM: true }).decode(data))),
      source_sha256: sha, source_path: path, decoding: 'UTF-8 replacement for parsing; original bytes retained',
    };
    cache.set(key, result);
  }
  return result;
}

/** The entry of the shortest time; between equal times, the first corner name in sort order. */
function fastest<T extends { time: number; corner: Corner }>(entries: T[]): T {
  return entries.reduce((best, entry) =>
    entry.time < best.time || (entry.time === best.time && entry.corner < best.corner) ? entry : best);
}

function checkCorners(corners: readonly Corner[]): void {
  if (!corners.length || corners.some(c => !CORNERS.includes(c))) throw new IbisError('invalid corner selection');
}

export interface RampEdges {
  r_load_ohm: number;
  r_load_default: boolean;
  voltage_range: Triple | null;
  temperature_range: Triple | null;
  model_type: string | null;
  missing_corners: Partial<Record<Edge, Corner[]>>;
  tr_ns: number;
  corner_r: Corner;
  dv_r_v: number;
  tf_ns: number;
  corner_f: Corner;
  dv_f_v: number;
}

export function rampEdges(model: Model, corners: readonly Corner[] = CORNERS): RampEdges {
  checkCorners(corners);
  const missing: Partial<Record<Edge, Corner[]>> = {};
  const edge = (name: Edge) => {
    const values = model.ramp[name];
    if (!values?.length) throw new IbisError(`no ramp ${name}`);
    const available = corners.flatMap(corner => {
      const value = values[CORNERS.indexOf(corner)];
      return value ? [{ time: value[1], corner, dv: value[0] }] : [];
    });
    if (!available.length) throw new IbisError('all requested corners unavailable');
    missing[name] = CORNERS.filter((_, index) => !values[index]);
    return fastest(available);
  };
  const rise = edge('r');
  const fall = edge('f');
  return {
    r_load_ohm: model.r_load, r_load_default: model.r_load_default, voltage_range: model.voltage_range,
    temperature_range: model.temperature_range, model_type: model.type, missing_corners: missing,
    tr_ns: rise.time * 1e9, corner_r: rise.corner, dv_r_v: rise.dv,
    tf_ns: fall.time * 1e9, corner_f: fall.corner, dv_f_v: fall.dv,
  };
}

/** Current of `rows` at `volts`, linear between rows. */
function currentAt(rows: ViRow[], index: number, corner: Corner, volts: number): number {
  for (let i = 0; i + 1 < rows.length; i++) {
    const [a, low] = rows[i] as ViRow;
    const [b, high] = rows[i + 1] as ViRow;
    if (a <= volts && volts <= b) {
      const ya = low[index];
      const yb = high[index];
      if (ya === null || ya === undefined || yb === null || yb === undefined) throw new IbisError(`missing V-I corner ${corner}`);
      if (!Number.isFinite(ya) || !Number.isFinite(yb)) throw new IbisError('nonfinite V-I current');
      return ya + (yb - ya) * (volts - a) / (b - a);
    }
  }
  throw new IbisError('V-I interval not covered');
}

/** Mean magnitude on a covered interval; no extrapolation or invented NA corner. */
export function viAvgCurrent(rows: ViRow[], corner: Corner, low: number, high: number): number {
  const index = CORNERS.indexOf(corner);
  if (index < 0) throw new IbisError('invalid corner');
  if (!Number.isFinite(low) || !Number.isFinite(high) || !(0 <= low && low < high)) throw new IbisError('invalid V-I interval');
  const first = rows[0];
  const last = rows.at(-1);
  if (rows.length < 2 || !first || !last || first[0] > low || last[0] < high) throw new IbisError('V-I interval not covered');
  if (rows.some(([v], i) => !Number.isFinite(v) || (i > 0 && (rows[i - 1] as ViRow)[0] >= v))) throw new IbisError('invalid V-I voltages');
  const xs = [low, ...rows.map(([v]) => v).filter(v => low < v && v < high), high];
  const ys = xs.map(x => currentAt(rows, index, corner, x));
  if (ys.includes(0) || (Math.min(...ys) < 0 && Math.max(...ys) > 0)) throw new IbisError('zero or changing V-I current sign');
  let area = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    area += (Math.abs(ys[i] as number) + Math.abs(ys[i + 1] as number)) * 0.5 * ((xs[i + 1] as number) - (xs[i] as number));
  }
  const result = area / (high - low);
  if (!Number.isFinite(result) || result <= 0) throw new IbisError('invalid mean V-I current');
  return result;
}

type EdgeFields<E extends Edge> = { [K in `t${E}_ns` | `t${E}_vi_ns` | `t${E}_ramp_ns` | `i_${E}` | `v_${E}`]: number }
  & { [K in `corner_${E}` | `corner_ramp_${E}`]: Corner }
  & { [K in `bound_${E}`]: 'ramp' | 'C*dV/I' };

export type ViEdges = {
  qualified_fastest_bound: false;
  method: string;
  missing_corners: Partial<Record<Edge, Corner[]>>;
  voltage_range: Triple | null;
  temperature_range: Triple | null;
  c_f: number;
} & EdgeFields<'f'> & Partial<EdgeFields<'r'>>;

export interface ViOptions {
  swing_v?: number | null;
  open_drain?: boolean;
  corners?: readonly Corner[];
  i_limit_a?: number | null;
}

interface EdgeResult { missing: Corner[]; vi: { time: number; corner: Corner; current: number; volts: number }; ramp: { time: number; corner: Corner } }

/** The fastest ramp and V-I bound of one edge. One corner with no reference voltage or NA current counts as missing. */
function edgeBound(model: Model, edge: Edge, rows: ViRow[], c_f: number, options: Required<ViOptions>): EdgeResult {
  const ramps = model.ramp[edge];
  if (!ramps?.length) throw new IbisError(`no ramp ${edge}`);
  const { swing_v: swing, open_drain: openDrain, corners, i_limit_a: limit } = options;
  const reference = model.pullup_ref ?? model.voltage_range;
  const vi: EdgeResult['vi'][] = [];
  const ramp: EdgeResult['ramp'][] = [];
  const missing: Corner[] = [];
  for (const corner of corners) {
    const index = CORNERS.indexOf(corner);
    const volts = openDrain ? swing : reference ? reference[index] ?? null : swing;
    if (volts !== null && (!Number.isFinite(volts) || volts <= 0)) throw new IbisError('invalid reference voltage');
    const slope = ramps[index];
    if (volts !== null && slope) {
      const time = 0.8 * volts / (slope[0] / slope[1]) * 1e9;
      if (!Number.isFinite(time) || time <= 0) throw new IbisError('invalid ramp time');
      ramp.push({ time, corner });
    }
    if (volts === null || rows.some(([, currents]) => currents[index] === null)) {
      missing.push(corner);
      continue;
    }
    const average = viAvgCurrent(rows, corner, 0.1 * volts, 0.9 * volts);
    const current = limit === null ? average : Math.min(average, limit);
    const time = c_f * 0.8 * volts / current * 1e9;
    if (!Number.isFinite(time) || time <= 0) throw new IbisError('invalid V-I estimate');
    vi.push({ time, corner, current, volts });
  }
  if (!vi.length) throw new IbisError('all V-I corners unavailable');
  if (!ramp.length) throw new IbisError('all ramp corners unavailable');
  return { missing, vi: fastest(vi), ramp: fastest(ramp) };
}

/**
 * Edge time of an IBIS output: the larger of two lower bounds (D-124e), each from its fastest corner.
 *
 * (1) Ramp-derived 10-90 % time. [Ramp] dV/dt_r and dV/dt_f are the slew of the output into the ramp fixture R_fixture
 * (R_load here, 50 ohm recommended) over the 20-80 % part of the swing: IBIS 7.0 / Cookbook v4 3.2.1 p. 18 define dV as
 * the voltage change from 20 % to 80 % of the final value and dt as the time it takes, "measured into R_fixture", the
 * fixture of the V-t data. This is the speed of the driver's own switching (the pre-driver slew), so the ramp measures
 * the driver, not a board load. A capacitive board load adds to the fixture time (the same current has to charge the
 * extra C), so the real edge is not shorter than the ramp time; hence a lower bound. The 10-90 % time of the corner's
 * swing V is 0.8 V / (dV/dt) (linear slew, the 20-80 % slope continued to 10-90 %; for an open drain V is the pull-up
 * rail on the net, same slope).
 * (2) C x 0.8 V / I_avg (D-124c): C the load (routed trace + sourced pins + C_comp), I_avg the mean magnitude of the
 * static [Pulldown] / [Pullup] V-I current over 10-90 % of the swing (Cookbook 3.1.1, p. 13-14); the output cannot
 * charge C faster than its V-I current allows, but this ignores the driver's own turn-on, so for slew-controlled
 * outputs (TCA9535: ramp 9.7-12.3 ns into 50 ohm, C dV/I 0.13 ns) it is far too short alone.
 * edge = max(fastest-corner ramp time, fastest-corner C dV/I): both are lower bounds of the real edge, so the larger
 * one is the better bound. A model with no [Ramp] for the edge, or no usable ramp corner, is an error (strict: the net
 * is unknown, never a pass). Static V-I is not a timing guarantee.
 * Sources: IBIS Open Forum, IBIS Modeling Cookbook v4, https://ibis.org/cookbook/cookbook-v4.pdf, 3.2.1 [Ramp] and
 * R_fixture; IBIS Specification 7.0 (https://ibis.org/ver7.0/ver7_0.pdf), keyword [Ramp] [P].
 *
 * D-124c uses ground-relative pulldown and supply-relative pullup coordinates. Arithmetic mean current omits
 * turn-on/dynamic/package effects.
 */
export function viEdges(model: Model, c_f: number, options: ViOptions = {}): ViEdges {
  const settings = { swing_v: null, open_drain: false, corners: CORNERS, i_limit_a: null, ...options };
  const { swing_v: swing, open_drain: openDrain, i_limit_a: limit } = settings;
  if (!Number.isFinite(c_f) || c_f <= 0) throw new IbisError('invalid load capacitance');
  checkCorners(settings.corners);
  if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) throw new IbisError('invalid series current limit');
  if (swing !== null && (!Number.isFinite(swing) || swing <= 0)) throw new IbisError('invalid swing');
  if (!OUTPUT_TYPES.has((model.type ?? '').toLowerCase())) throw new IbisError('model is not an output');
  if (openDrain && swing === null) throw new IbisError('open drain needs pull-up voltage');
  const result: Record<string, unknown> = {
    qualified_fastest_bound: false, method: METHOD, missing_corners: {}, voltage_range: model.voltage_range,
    temperature_range: model.temperature_range, c_f,
  };
  for (const [edge, table] of [['f', 'pulldown'], ['r', 'pullup']] as const) {
    if (edge === 'r' && openDrain) continue;
    const rows = model.vi[table];
    if (!rows?.length) throw new IbisError(`no ${table} V-I table`);
    const { missing, vi, ramp } = edgeBound(model, edge, rows, c_f, settings);
    Object.assign(result, {
      [`t${edge}_ns`]: Math.max(vi.time, ramp.time), [`t${edge}_vi_ns`]: vi.time, [`t${edge}_ramp_ns`]: ramp.time,
      [`bound_${edge}`]: ramp.time > vi.time ? 'ramp' : 'C*dV/I', [`corner_${edge}`]: vi.corner,
      [`corner_ramp_${edge}`]: ramp.corner, [`i_${edge}`]: vi.current, [`v_${edge}`]: vi.volts,
    });
    (result.missing_corners as Record<string, Corner[]>)[edge] = missing;
  }
  return result as ViEdges;
}
