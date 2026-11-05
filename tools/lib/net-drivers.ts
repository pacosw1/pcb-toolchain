// The edge time of a net from its actual driver (D-124 addendum, 2026-10-09).
//
// The driver of a net is found in the board's schematic netlist. The edge time of each driver pin comes from
// tools/driver-edges.json (per part: datasheet tr and tf with the test load, or the IBIS model), never from a default. A
// net whose driver or edge time is not known is "unknown driver".
//
// Rules (tools/driver-edges.json "about" has the full text):
//   - A pin of a part in the table has a role: "input" (not a driver), "push_pull" (edge = min(tr, tf)), "open_drain"
//     (open drain or open collector with a pull-up: edge = tf, the driver's fall; the RC rise is slower), "opto"
//     (phototransistor output: edge = min(tr, tf)) or "unknown" (with the reason, for example no IBIS model).
//   - A part that is not in the table, or a pin that no rule of its part matches, is unknown.
//   - Passive parts (R, C, L, FB, D, TP, F, Y, SW, BT, H, MH, NT, JP refs) are no driver. A 2-pin resistor or ferrite
//     passes the drivers of the net at its other end (not a rail), with the same edge (the series part only slows it).
//   - A connector pin (ref J, P, CN) is a load when the net has a driver on the board. With no driver on the board, the
//     spec must name the off-board interface ("offboard"); else the net is unknown.
//   - "receivers" in the spec: parts whose pin on that net is an input by firmware or by design (with a reason).
//   - The edge of the net is the shortest edge of all its drivers. One unknown driver makes the whole net unknown.
//   - A rail is a net from a power symbol (no "/" in front of the name) or a spec power net: no driver search.
//
// D-124c: IBIS drivers use static V-I mean-current estimates with the routed trace, sourced receiver loads and driver
// C_comp MIN, not the resistive-fixture Ramp. All estimates remain conditional and retain model/corner/load attribution.
//
// Tables, edge classes, receivers and offboard specs are values from jsonLoads.
import { basename, isAbsolute, join } from 'node:path';
import { classApplies, partOf, ruleOf, TableError, timingEvidence, type DriverTable } from './driver-table.ts';
import { fnmatchCase } from './fnmatch.ts';
import { load, rampEdges, viEdges, type Model, type RampEdges, type ViEdges } from './ibis.ts';
import { microstrip } from './microstrip.ts';
import type { Netlist, Node } from './netlist.ts';
import { fileRoot } from './project-root.mjs';
import { fixed, get, item, number, pyStr, truthy } from './py-compat.mjs';
import { formatG, pyFloat } from './py-numbers.ts';
import { caught } from './py-path.ts';
import { isDict, isPositive, iterate, type Dict } from './py-dict.ts';

const PASSIVE = new Set(['R', 'C', 'L', 'FB', 'D', 'TP', 'F', 'Y', 'SW', 'BT', 'H', 'MH', 'NT', 'JP']);
const SERIES = new Set(['R', 'FB']);
const CONNECTOR = new Set(['J', 'P', 'CN']);
const R_TOL = 0.95;
const C0_MM_PER_NS = 299.792458;
const ESTIMATE_ERRORS = ['ValueError', 'OSError', 'KeyError', 'TypeError', 'IndexError', 'OverflowError'];
const ESTIMATE_KINDS = new Set(['conditional_capacitance_current_estimate', 'ibis_vi_load_estimate']);

export interface Geometry {
  length_mm?: Record<string, number>;
  /** Per net: pF per mm and where that comes from. */
  pf_per_mm?: Record<string, [number, string]>;
  model_applicability?: unknown;
}

export interface EdgeOptions {
  receivers?: Dict;
  offboard?: Dict;
  classes?: Dict;
  power?: readonly string[];
  interface?: string | null;
  geom?: Geometry | null;
}

export type NetEdge =
  | { edge_ns: number; driver: string; timing_evidence: Record<string, unknown> }
  | { unknown: string };

type Series = [ref: string, ohms: number | null];
interface Bound { key: string; part: Dict; rule: Dict; home: string; series: Series[] }
type Known = { ref: string; pin: string; edge: number; text: string; details?: Record<string, unknown> };
type Driver = Known | { ref: string; pin: string; edge: null; bound: Bound };
type PinEdge = { role: 'input' | 'unknown'; text: string } | { role: 'bound'; key: string; part: Dict; rule: Dict } | { role: string; edge: number; text: string };

const text = (value: unknown): string => pyStr(value);
const nodes = (netlist: Netlist, net: string): Node[] => netlist.nets.get(net) ?? [];
const comp = (netlist: Netlist, ref: string): string => netlist.comps.get(ref) ?? '';
const hasNet = (table: Record<string, unknown> | undefined, net: string): boolean => table !== undefined && Object.hasOwn(table, net);

export function refPrefix(ref: string): string {
  return /^[A-Za-z_#]+/.exec(ref)?.[0].toUpperCase() ?? '';
}

export const isRail = (net: string, power: readonly string[] = []): boolean =>
  (!net.startsWith('/') && !net.startsWith('Net-') && !net.startsWith('unconnected')) || power.some(pattern => fnmatchCase(net, pattern));

function receiversOf(net: string, receivers: Dict | undefined): Set<unknown> {
  const refs = new Set<unknown>();
  for (const [pattern, row] of receivers ?? []) {
    if (fnmatchCase(net, pattern)) iterate(item(row, 'refs')).forEach(ref => refs.add(ref));
  }
  return refs;
}

/** D124b alternatives use the existing timing contract, never mint MIN proof. */
function screeningEvidence(part: Dict, rule: Dict): Record<string, unknown> {
  const evidence: Record<string, unknown> = {
    qualified_fastest_bound: false, source_MIN_verified: false, applicable_driver_bound: false, source: get(rule, 'source', ''),
    scope: 'sourced screening estimate; board applicability unresolved',
  };
  if (truthy(rule.get('ibis_model'))) {
    const ibis = item(part, 'ibis');
    return {
      ...evidence, kind: 'ibis_vi_load_estimate', primary_evidence: { path: item(ibis, 'file'), sha256: get(ibis, 'sha256') },
      component: get(ibis, 'component'), url: get(ibis, 'url'), downloaded: get(ibis, 'downloaded'),
      premises: ['static V-I average is not a transient current waveform', 'capacitance and swing lower bounds unproved',
        'distributed connected topology not a proven lumped load', 'package and measurement boundary applicability unproved'],
      reason: 'load-dependent V-I conditional screening estimate cannot certify fastest physical edge',
    };
  }
  return {
    ...evidence, kind: 'conditional_capacitance_current_estimate', inputs: new Map(item(rule, 'bound') as Dict),
    premises: ['instantaneous current upper bound unproved', 'capacitance and swing lower bounds unproved',
      'distributed connected topology not a proven lumped load', 'series tolerance/charging-path applicability unproved'],
    reason: 'C*dV/I conditional calculation cannot certify fastest physical edge',
  };
}

function pinTimingEvidence(mpn: string, pin: string, table: DriverTable, partClass: Dict | undefined): Record<string, unknown> {
  if (partClass && classApplies(partClass, mpn, pin)) return timingEvidence(partClass);
  const [key, part] = partOf(mpn, table);
  const rule = part ? ruleOf(part, pin) : undefined;
  if (!part || !rule) return timingEvidence(new Map());
  if (truthy(rule.get('ibis_model')) || (rule.has('bound') && !isPositive(rule.get('tf_ns')))) return screeningEvidence(part, rule);
  return timingEvidence(rule, key, part.get('mpn'));
}

/** The role and edge of one part pin. The edge is the time the return current flows in. */
export function pinEdge(mpn: string, pin: string, table: DriverTable, partClass?: Dict): PinEdge {
  if (partClass && classApplies(partClass, mpn, pin)) {
    return { role: 'push_pull', edge: number(item(partClass, 'tr_ns')), text: `part-bound class ${mpn}.${pin}: ${text(item(partClass, 'source'))}` };
  }
  const [key, part] = partOf(mpn, table);
  if (!part) return { role: 'unknown', text: `${mpn}: no entry in tools/driver-edges.json` };
  const rule = ruleOf(part, pin);
  if (!rule) return { role: 'unknown', text: `${key} pin ${pin}: no rule in tools/driver-edges.json` };
  const role = rule.get('role') as string;
  if (role === 'input') return { role, text: `${key} ${pin} input` };
  if (partClass) return { role: 'unknown', text: `${mpn}.${pin}: incompatible with part-bound class ${text(item(item(partClass, 'applicability'), 'mpn'))}` };
  const source = text(rule.get('source'));
  if (role === 'unknown') return { role, text: `${key} ${pin}: ${source}` };
  if (truthy(rule.get('ibis_model')) || (!isPositive(rule.get('tf_ns')) && rule.has('bound'))) return { role: 'bound', key: key as string, part, rule };
  const tf = number(rule.get('tf_ns'));
  if (role === 'open_drain') return { role, edge: tf, text: `${key} ${pin} open drain, tf ${formatG(tf)} ns: ${source}` };
  const tr = number(rule.get('tr_ns'));
  const edge = Math.min(tr, tf);
  return { role, edge, text: `${key} ${pin} ${role}, min(tr ${formatG(tr)}, tf ${formatG(tf)}) = ${formatG(edge)} ns: ${source}` };
}

/** '10k' -> 10000, '4.7k' -> 4700, '330' -> 330, '1M' -> 1e6, '4k7' -> 4700. Null if not a value. */
export function rValue(value: string | null | undefined): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([RkKmM]?)(\d*)\s*(?:ohm|Ω)?\s*$/.exec(value ?? '');
  if (!match) return null;
  const multiplier: Record<string, number> = { '': 1, R: 1, k: 1e3, K: 1e3, m: 1e6, M: 1e6 };
  return Number(match[1] + (match[3] ? `.${match[3]}` : '')) * (multiplier[match[2] as string] as number);
}

interface Found { drivers: Driver[]; unknowns: string[]; connectors: string[] }

/** The drivers beyond a 2-pin series part on `net`, when that part leads to exactly one other net that is no rail. */
function throughSeries(ref: string, prefix: string, net: string, netlist: Netlist, table: DriverTable, options: EdgeOptions, seen: Set<string>, partClass: Dict | undefined, series: Series[], found: Found): void {
  const others = [...netlist.nets].filter(([name, rows]) => name !== net && rows.some(([other]) => other === ref)).map(([name]) => name);
  const other = others[0];
  if (others.length !== 1 || other === undefined || seen.has(other) || isRail(other, options.power)) return;
  seen.add(other);
  const ohms = prefix === 'R' ? rValue(netlist.values?.get(ref)) : null;
  const beyond = netDrivers(other, netlist, table, options, seen, partClass, [...series, [ref, ohms]]);
  const via = ` (through ${ref} from ${other})`;
  found.drivers.push(...beyond.drivers.map(driver => (driver.edge === null ? driver : { ...driver, text: driver.text + via })));
  found.unknowns.push(...beyond.unknowns.map(reason => reason + via));
}

/** Follows 2-pin series resistors and ferrites to nets that are not rails. */
function netDrivers(net: string, netlist: Netlist, table: DriverTable, options: EdgeOptions, seen: Set<string>, partClass: Dict | undefined, series: Series[] = []): Found {
  const found: Found = { drivers: [], unknowns: [], connectors: [] };
  const receivers = receiversOf(net, options.receivers);
  for (const [ref, pin, name] of nodes(netlist, net)) {
    const prefix = refPrefix(ref);
    if (receivers.has(ref)) continue;
    if (CONNECTOR.has(prefix)) {
      found.connectors.push(`${ref}.${pin}`);
    } else if (PASSIVE.has(prefix)) {
      if (SERIES.has(prefix)) throughSeries(ref, prefix, net, netlist, table, options, seen, partClass, series, found);
    } else {
      const edge = pinEdge(comp(netlist, ref), name, table, partClass);
      if (edge.role === 'unknown') found.unknowns.push(`${ref}.${name} ${(edge as { text: string }).text}`);
      else if ('rule' in edge) found.drivers.push({ ref, pin: name, edge: null, bound: { key: edge.key, part: edge.part, rule: edge.rule, home: net, series } });
      else if ('edge' in edge) found.drivers.push({ ref, pin: name, edge: edge.edge, text: `${ref}.${name} ${edge.text}` });
    }
  }
  return found;
}

/** t >= C x dV / I, dV = 0.8 x VDD (the 10-90 % swing). pF x V / mA = 1e-9 s. */
export function edgeBoundNs(cPf: number, vddV: number, iMa: number): number {
  if (![cPf, vddV, iMa].every(isPositive)) throw new TableError('invalid C*dV/I inputs');
  return cPf * 0.8 * vddV / iMa;
}

/** The current through a series resistor is at most VDD / (0.95 x R) (R at its low tolerance). */
export function seriesLimitMa(iMa: number, vddV: number, rOhm: number): number {
  if (![iMa, vddV, rOhm].every(isPositive)) throw new TableError('invalid series-current inputs');
  return Math.min(iMa, vddV / (R_TOL * rOhm) * 1000);
}

/** C per length of a microstrip: C' = sqrt(Eeff) / (c0 x Z0). */
export function microstripPfPerMm(wMm: number, hMm: number, tMm: number, er: number): number {
  const { z, eeff } = microstrip(wMm, hMm, tMm, er);
  return 1000 * Math.sqrt(eeff) / (C0_MM_PER_NS * z);
}

/** The voltage in a rail name: VDD_3V3, +3V3 -> 3.3; FIELD_5V, 5V_LOGIC -> 5; +15V -> 15. Null if not one value. */
export function railVolts(net: string | null | undefined): number | null {
  const values = new Set([...(net ?? '').matchAll(/(?<![0-9.])(\d+)V(\d*)(?![0-9])/g)].map(([, whole, part]) => Number(whole + (part ? `.${part}` : ''))));
  return values.size === 1 ? [...values][0] as number : null;
}

const pinsByRef = new WeakMap<Netlist, Map<string, [pin: string, name: string, net: string][]>>();

function byRef(netlist: Netlist): Map<string, [string, string, string][]> {
  let index = pinsByRef.get(netlist);
  if (!index) {
    index = new Map();
    for (const [net, rows] of netlist.nets) {
      for (const [ref, pin, name] of rows) index.set(ref, [...(index.get(ref) ?? []), [pin, name, net]]);
    }
    pinsByRef.set(netlist, index);
  }
  return index;
}

/** The rail voltage on the supply pin (name) of a part, or null. */
export function supplyVolts(netlist: Netlist, ref: string, pin: string): number | null {
  const row = byRef(netlist).get(ref)?.find(([, name]) => name === pin);
  return row ? railVolts(row[2]) : null;
}

const ibisPath = (part: unknown): string => {
  const file = item(item(part, 'ibis'), 'file') as string;
  return isAbsolute(file) ? file : join(fileRoot, file);
};
const ibisSource = (part: unknown) => load(ibisPath(part), get(item(part, 'ibis'), 'sha256') as string | null);

export function ibisModel(part: unknown, name: string): Model {
  const model = ibisSource(part).models.get(name.toLowerCase());
  if (!model) throw new TableError(`IBIS model ${name} is not in ${text(item(item(part, 'ibis'), 'file'))}`);
  return model;
}

export const ibisEdges = (part: unknown, name: string): RampEdges => rampEdges(ibisModel(part, name));

interface Variant { suffix: string; volts: number; note: string }

/** The variant for the part's supply rail, else all of them (the caller takes the worst). */
function ibisVariants(part: unknown, ref: string | undefined, netlist: Netlist | undefined): Variant[] {
  const ibis = item(part, 'ibis');
  const pin = text(item(ibis, 'supply_pin'));
  const volts = netlist && ref ? supplyVolts(netlist, ref, pin) : null;
  const variants = [...item(ibis, 'variants') as Dict];
  if (volts !== null) {
    const match = variants.find(([key]) => Math.abs(pyFloat(key) - volts) < 0.05);
    if (match) return [{ suffix: match[1] as string, volts, note: `${pin} ${formatG(volts)} V` }];
  }
  return variants.map(([key, suffix]) => ({ suffix: suffix as string, volts: pyFloat(key), note: `${pin} rail not found: all variants` }));
}

/** The input capacitance of a part pin with a source, or null and the reason. */
export function pinCPf(mpn: string, pin: string, table: DriverTable, ref?: string, netlist?: Netlist): [number | null, string] {
  const [key, part] = partOf(mpn, table);
  if (!part) return [null, `${mpn}: no entry`];
  const rule = ruleOf(part, pin);
  if (rule && truthy(rule.get('ibis_model')) && part.has('ibis')) {
    const base = text(rule.get('ibis_model'));
    const values = ibisVariants(part, ref, netlist).flatMap(({ suffix }): [number, string][] => {
      const minimum = ibisModel(part, base + suffix).c_comp?.[1];
      return minimum === null || minimum === undefined ? [] : [[minimum * 1e12, suffix]];
    });
    if (!values.length) return [null, `${key} ${pin}: IBIS C_comp minimum unavailable`];
    const [c, suffix] = values.reduce((best, value) => (value[0] < best[0] || (value[0] === best[0] && value[1] < best[1]) ? value : best));
    return [c, `${key} ${pin} ${formatG(c, 3)} pF (IBIS ${base}${suffix} C_comp min)`];
  }
  const pinC = part.get('pin_c');
  if (truthy(pinC)) {
    const pf = number(item(pinC, 'pf'));
    return [pf, `${key} ${pin} ${formatG(pf)} pF (${text(item(pinC, 'source'))})`];
  }
  return [null, `${key} ${pin}: no input capacitance with a source`];
}

/** The lowest rail that a resistor from this net leads to (the pull-up of an open drain), or null. */
function pullupVolts(net: string, netlist: Netlist, power: readonly string[] = []): number | null {
  const volts: number[] = [];
  for (const [ref] of nodes(netlist, net)) {
    if (refPrefix(ref) !== 'R') continue;
    for (const [, , other] of byRef(netlist).get(ref) ?? []) {
      const rail = other !== net && isRail(other, power) ? railVolts(other) : null;
      if (rail) volts.push(rail);
    }
  }
  return volts.length ? Math.min(...volts) : null;
}

interface NetLoad { total: number; used: string[]; left: string[] }

/** The IC pins on a net with a sourced input capacitance (not passives, not connectors); `skip` is the driver. */
export function netLoadPf(net: string, netlist: Netlist, table: DriverTable, skip?: [string, string]): NetLoad {
  const load: NetLoad = { total: 0, used: [], left: [] };
  for (const [ref, , name] of nodes(netlist, net)) {
    const prefix = refPrefix(ref);
    if ((skip && ref === skip[0] && name === skip[1]) || PASSIVE.has(prefix) || CONNECTOR.has(prefix)) continue;
    const [c, reason] = pinCPf(comp(netlist, ref), name, table, ref, netlist);
    if (c === null) load.left.push(`${ref}.${name}`);
    else {
      load.total += c;
      load.used.push(`${ref}.${reason}`);
    }
  }
  return load;
}

function boundSupply(b: Dict, ref: string, home: string, netlist: Netlist, power: readonly string[] | undefined): { vdd: number | null; source: string | null } {
  if (truthy(b.get('supply_pin'))) {
    const vdd = supplyVolts(netlist, ref, text(b.get('supply_pin')));
    return { vdd, source: vdd ? `${text(b.get('supply_pin'))} rail ${formatG(vdd)} V` : null };
  }
  if (truthy(b.get('pullup'))) {
    const vdd = pullupVolts(home, netlist, power);
    return { vdd, source: vdd ? `pull-up rail ${formatG(vdd)} V` : null };
  }
  const vdd = number(item(b, 'vdd_v'));
  return { vdd, source: `${formatG(vdd)} V (${text(get(b, 'vdd_source', ''))})` };
}

function routed(geom: Geometry | null | undefined, net: string): { length: number; perMm: number; source: string } | null {
  if (!geom || !hasNet(geom.length_mm, net) || !hasNet(geom.pf_per_mm, net)) return null;
  const [perMm, source] = (geom.pf_per_mm as Record<string, [number, string]>)[net] as [number, string];
  return { length: (geom.length_mm as Record<string, number>)[net] as number, perMm, source };
}

/** A bound driver on a net (D-124b): t >= C x 0.8 VDD / I. The edge, or null and the reason. */
function pinBound(ref: string, name: string, bound: Bound, net: string, netlist: Netlist, table: DriverTable, options: EdgeOptions): [number | null, string] {
  const { key, rule, home, series } = bound;
  const trace = routed(options.geom, net);
  if (!trace) return [null, `${ref}.${name} ${key}: the bound C*dV/I needs the routed length of ${net} (no board geometry)`];
  const b = item(rule, 'bound') as Dict;
  const { vdd, source } = boundSupply(b, ref, home, netlist, options.power);
  if (!vdd) return [null, `${ref}.${name} ${key}: the bound needs the supply voltage; no rail found for it`];
  if (!isPositive(trace.length) || !isPositive(trace.perMm)) return [null, `${ref}.${name}: invalid/nonpositive geometry capacitance`];
  const cTrace = trace.length * trace.perMm;
  const loads = netLoadPf(net, netlist, table, [ref, name]);
  const cPin = series.length ? 0 : number(get(b, 'cpin_pf', 0n));
  const c = cTrace + loads.total + cPin;
  let current = number(item(b, 'i_ma'));
  let label = `${formatG(current)} mA (${text(item(b, 'i_source'))})`;
  for (const [resistor, ohms] of series) {
    if (ohms === null) continue;
    const limit = seriesLimitMa(current, vdd, ohms);
    if (limit < current) {
      current = limit;
      label = `${formatG(limit, 3)} mA = ${formatG(vdd)} V / (0.95 x ${formatG(ohms)} ohm ${resistor})`;
    }
  }
  if (c <= 0) return [null, `${ref}.${name} ${key}: the bound has no capacitance (no routed length)`];
  const edge = edgeBoundNs(c, vdd, current);
  if (!isPositive(edge)) return [null, `${ref}.${name}: invalid capacitance/current estimate`];
  const via = series.length ? ` (through ${series.map(([r]) => r).join(', ')} from ${home})` : '';
  const sum = `${fixed(cTrace, 2)} pF trace [${fixed(trace.length, 1)} mm x ${fixed(trace.perMm, 4)} pF/mm, ${trace.source}]`
    + ` + ${fixed(loads.total, 2)} pF loads [${loads.used.join('; ') || 'none with a source'}]`
    + (cPin ? ` + ${formatG(cPin)} pF pin [${text(item(b, 'cpin_source'))}]` : '');
  return [edge, `${ref}.${name} ${key} conditional estimate: C*dV/I = (${sum}) x 0.8 x ${formatG(vdd)} V [${source}] / ${label} = ${formatG(edge, 3)} ns`
    + (loads.left.length ? `; loads with no source left out (bound shorter): ${loads.left.join(', ')}` : '') + via];
}

interface SeriesLimit { limit: number | null; sources: { ref: string; ohm: number; tolerance_factor: number; current_a: number }[] }

function seriesCurrentLimit(series: Series[], volts: number): SeriesLimit {
  const result: SeriesLimit = { limit: null, sources: [] };
  for (const [ref, ohm] of series) {
    if (ohm === null) continue;
    if (!isPositive(ohm)) throw new TableError('invalid series resistance');
    const current = volts / (R_TOL * ohm);
    result.limit = result.limit === null ? current : Math.min(result.limit, current);
    result.sources.push({ ref, ohm, tolerance_factor: R_TOL, current_a: current });
  }
  return result;
}

/** Each schematic pin of the driver must reach this model through the [Pin] table and its selector. */
function checkSelected(part: unknown, pins: string[], modelName: string): void {
  const parsed = ibisSource(part);
  const component = get(item(part, 'ibis'), 'component') as string | null;
  if (!component) return;
  for (const pin of pins) {
    const row = parsed.pins.get(component)?.get(pin);
    if (!row) throw new TableError(`IBIS component pin missing: ${pin}`);
    const base = row[1].toLowerCase();
    if (!(parsed.selectors.get(base) ?? [base]).includes(modelName.toLowerCase())) throw new TableError(`IBIS component/pin/model selector mismatch: ${pin}`);
  }
}

interface Estimate extends Partial<ViEdges> {
  model: string;
  supply_nominal_v: number;
  supply_resolution: string;
  capacitance_pf: number;
  driver_c_comp_min_pf: number;
  driver_capacitance_omitted_for_series: boolean;
  series_current_limit_a: number | null;
  series_limit_sources: SeriesLimit['sources'];
  screening_edge_ns: number;
}

/** Load-dependent V-I screening estimate and its exact inputs (D-124c). Static V-I averages and omitted loads do not
 * prove a fastest-edge bound. Every possible supply/model must be interpretable; errors remain unknown. */
function ibisViBound(ref: string, name: string, bound: Bound, net: string, netlist: Netlist, table: DriverTable, options: EdgeOptions): Known {
  const { key, part, rule, home, series } = bound;
  const trace = routed(options.geom, net);
  if (!trace) throw new TableError(`${ref}.${name}: V-I estimate needs the routed length and capacitance of ${net}`);
  if (!isPositive(trace.length) || !isPositive(trace.perMm)) throw new TableError('invalid/nonpositive geometry capacitance');
  const cTrace = trace.length * trace.perMm;
  const loads = netLoadPf(net, netlist, table, [ref, name]);
  const openDrain = rule.get('role') === 'open_drain';
  const swing = openDrain ? pullupVolts(home, netlist, options.power) : null;
  if (openDrain && !isPositive(swing)) throw new TableError(`open drain has no pull-up rail on ${home}`);
  const ibis = item(part, 'ibis');
  const component = get(ibis, 'component') as string | null;
  if (component && !ibisSource(part).pins.has(component)) throw new TableError('IBIS component missing');
  const pins = [...netlist.nets.values()].flat().filter(([other, , signal]) => other === ref && signal === name).map(([, pin]) => pin);
  if (component && !pins.length) throw new TableError('selected schematic pin missing');
  const allowed = openDrain ? ['open_drain', 'open_sink'] : ['output', 'i/o', '3-state'];
  const estimates = ibisVariants(part, ref, netlist).map(({ suffix, volts, note }): Estimate => {
    const modelName = text(rule.get('ibis_model')) + suffix;
    const model = ibisModel(part, modelName);
    if (!allowed.includes((model.type ?? '').toLowerCase())) throw new TableError('IBIS model type incompatible with output role');
    checkSelected(part, pins, modelName);
    const minimum = model.c_comp?.[1];
    if (!series.length && !isPositive(minimum)) throw new TableError('driver IBIS C_comp minimum unavailable');
    const cPin = series.length ? 0 : (minimum as number) * 1e12;
    const total = cTrace + loads.total + cPin;
    if (!isPositive(total)) throw new TableError('invalid total capacitance');
    const { limit, sources } = seriesCurrentLimit(series, swing ?? volts);
    const edges = viEdges(model, total * 1e-12, { swing_v: swing, open_drain: openDrain, i_limit_a: limit });
    const edge = openDrain ? edges.tf_ns : Math.min(edges.tr_ns as number, edges.tf_ns);
    if (!isPositive(edge)) throw new TableError('invalid IBIS V-I edge estimate');
    return {
      model: modelName, supply_nominal_v: volts, supply_resolution: note, capacitance_pf: total, driver_c_comp_min_pf: cPin,
      driver_capacitance_omitted_for_series: series.length > 0, series_current_limit_a: limit, series_limit_sources: sources, screening_edge_ns: edge, ...edges,
    };
  });
  if (!estimates.length) throw new TableError('no IBIS model variants');
  const best = estimates.reduce((fastest, estimate) => (estimate.screening_edge_ns < fastest.screening_edge_ns ? estimate : fastest));
  const edge = best.screening_edge_ns;
  const details = {
    estimates, selected_model: best.model, selected_pin: name,
    inputs: {
      net, driver_home_net: home, length_mm: trace.length, pf_per_mm: trace.perMm, capacitance_per_length_source: trace.source, trace_capacitance_pf: cTrace,
      receiver_capacitance_pf: loads.total, receiver_sources: loads.used, omitted_loads: loads.left, open_drain: openDrain, pullup_swing_v: swing, series,
    },
  };
  const summary = `${ref}.${name} ${key} IBIS V-I conditional estimate: C*dV/I_avg, ${basename(text(item(ibis, 'file')))} `
    + `[Model] ${best.model} (${best.supply_resolution}): ${formatG(best.capacitance_pf)} pF `
    + `(${formatG(cTrace)} pF trace, ${formatG(loads.total)} pF sourced loads, ${formatG(best.driver_c_comp_min_pf)} pF C_comp min) `
    + `-> ${formatG(edge)} ns; source ${text(item(ibis, 'url'))} (downloaded ${text(item(ibis, 'downloaded'))})`
    + (loads.left.length ? `; loads without source omitted: ${loads.left.join(', ')}` : '')
    + (series.length ? `; through ${series.map(([r]) => r).join(', ')} from ${home}` : '');
  return { ref, pin: name, edge, text: summary, details };
}

/** Turns bound drivers into known edges; one that cannot be estimated joins the unknowns. */
function resolveDrivers(found: Found, net: string, netlist: Netlist, table: DriverTable, options: EdgeOptions): Known[] {
  const known: Known[] = [];
  for (const driver of found.drivers) {
    if (driver.edge !== null) {
      known.push(driver);
      continue;
    }
    const { ref, pin, bound } = driver;
    try {
      if (truthy(bound.rule.get('ibis_model'))) known.push(ibisViBound(ref, pin, bound, net, netlist, table, options));
      else {
        const [edge, reason] = pinBound(ref, pin, bound, net, netlist, table, options);
        if (edge === null) found.unknowns.push(reason);
        else known.push({ ref, pin, edge, text: reason });
      }
    } catch (error) {
      if (!caught(error, ...ESTIMATE_ERRORS)) throw error;
      found.unknowns.push(`${ref}.${pin}: invalid conditional estimate: ${(error as Error).message}`);
    }
  }
  return known;
}

function onBoardEdge(drivers: Known[], net: string, netlist: Netlist, table: DriverTable, partClass: Dict | undefined, geom: Geometry | null | undefined): NetEdge {
  const fastest = drivers.reduce((best, driver) => (driver.edge < best.edge ? driver : best));
  const contributors = drivers.map(driver => {
    const evidence = pinTimingEvidence(comp(netlist, driver.ref), driver.pin, table, partClass);
    Object.assign(evidence, driver.details);
    if (ESTIMATE_KINDS.has(evidence.kind as string)) {
      evidence.geometry_screening = {
        net, length_mm: geom?.length_mm?.[net] ?? null, pf_per_mm: geom?.pf_per_mm?.[net] ?? null, model_applicability: geom?.model_applicability ?? {},
      };
    }
    return { ref: driver.ref, pin: driver.pin, screening_edge_ns: driver.edge, evidence };
  });
  return {
    edge_ns: fastest.edge, driver: fastest.text,
    timing_evidence: {
      qualified_fastest_bound: contributors.every(({ evidence }) => evidence.qualified_fastest_bound), contributors,
      reason: 'all possible drivers require sourced fastest-edge bounds',
    },
  };
}

function offboardEdge(net: string, connectors: string[], options: EdgeOptions): NetEdge | null {
  for (const [pattern, row] of options.offboard ?? []) {
    if (!fnmatchCase(net, pattern)) continue;
    const className = text(item(row, 'class'));
    const edgeClass = options.classes?.get(className) as Dict | undefined;
    if (!edgeClass) return { unknown: `offboard class ${className} is not in tools/edge-rates.json` };
    if (!connectors.length) return { unknown: 'offboard class requires an actual schematic connector endpoint' };
    if (get(item(edgeClass, 'applicability'), 'kind') === 'part' && !classApplies(edgeClass, text(get(row, 'driver_mpn', '')), text(get(row, 'driver_pin', '')))) {
      return { unknown: 'offboard driver MPN/pin absent or incompatible with part-bound class' };
    }
    return {
      edge_ns: number(item(edgeClass, 'tr_ns')),
      driver: `off-board via ${connectors.join(', ')}: class ${className} (${text(item(edgeClass, 'source'))}); ${text(item(row, 'reason'))}`,
      timing_evidence: timingEvidence(edgeClass),
    };
  }
  return null;
}

/** The edge of a net, or the reason it is unknown. `classes` are the edge-rates.json classes. */
export function netEdge(net: string, netlist: Netlist, table: DriverTable, options: EdgeOptions = {}): NetEdge {
  if (!netlist.nets.has(net)) return { unknown: `net ${net} is not in the schematic netlist` };
  const name = options.interface;
  const edgeClass = name ? options.classes?.get(name) : undefined;
  const partClass = isDict(edgeClass) ? edgeClass : undefined;
  if (partClass && get(item(partClass, 'applicability'), 'kind') === 'protocol') {
    if (!nodes(netlist, net).length) return { unknown: 'interface net has no schematic endpoints' };
    return {
      edge_ns: number(item(partClass, 'tr_ns')),
      driver: `protocol ${name}: ${text(item(item(partClass, 'applicability'), 'reason'))}; ${text(item(partClass, 'source'))}`,
      timing_evidence: timingEvidence(partClass),
    };
  }
  const found = netDrivers(net, netlist, table, options, new Set([net]), partClass);
  const drivers = resolveDrivers(found, net, netlist, table, options);
  if (found.unknowns.length) return { unknown: found.unknowns.join('; ') };
  if (drivers.length) return onBoardEdge(drivers, net, netlist, table, partClass, options.geom);
  const offboard = offboardEdge(net, found.connectors, options);
  if (offboard) return offboard;
  if (found.connectors.length) return { unknown: `driven from off-board via ${found.connectors.join(', ')}; no interface class (spec "offboard")` };
  return { unknown: 'no driver pin on the net' };
}
