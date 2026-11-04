// Net driver search and D-124c load estimates on synthetic tables. The real table needs its datasheets: see
// net-drivers-project.test.ts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test, type TestContext } from 'node:test';
import { loadTable, minimumRecordHash, ReviewedMinimumProof, TableError, timingEvidence, verifyEvidence, type DriverTable } from './driver-table.ts';
import { edgeBoundNs, microstripPfPerMm, netEdge, pinCPf, railVolts, rValue, seriesLimitMa, type EdgeOptions, type Geometry, type NetEdge } from './net-drivers.ts';
import { exportNetlist, parseNetlist, pinName, type Netlist, type Node } from './netlist.ts';
import { jsonLoads } from './py-compat.mjs';
import type { Dict } from './py-dict.ts';

const XML = `<export version="E">
<components>
  <comp ref="U1"><value>STM32H743VIT6</value><fields><field name="MPN">STM32H743VIT6</field></fields></comp>
  <comp ref="U2"><value>LTV-217-B-G</value><fields><field name="MPN">LTV-217-B-G</field></fields></comp>
  <comp ref="U4"><value>XYZ123</value><fields><field name="MPN">XYZ123</field></fields></comp>
  <comp ref="U5"><value>ODX</value><fields><field name="MPN">ODX-1</field></fields></comp>
  <comp ref="U6"><value>FAST</value><fields><field name="MPN">FAST-1</field></fields></comp>
  <comp ref="R1"><value>10k</value></comp>
  <comp ref="R2"><value>10k</value></comp>
  <comp ref="J1"><value>conn</value></comp>
  <comp ref="U7"><value>ODX</value><fields><field name="MPN">ODX-2</field></fields></comp>
  <comp ref="R3"><value>4.7k</value></comp>
</components>
<nets>
  <net code="1" name="/ALMn">
    <node ref="U2" pin="4" pinfunction="COL_4" pintype="unspecified"/>
    <node ref="U1" pin="40" pinfunction="PE10_40" pintype="unspecified"/>
    <node ref="R1" pin="2" pinfunction="2_2" pintype="passive"/>
  </net>
  <net code="2" name="+3V3"><node ref="R1" pin="1" pinfunction="1_1" pintype="passive"/>
    <node ref="R3" pin="1" pinfunction="1_1" pintype="passive"/></net>
  <net code="8" name="/OD2"><node ref="U7" pin="3" pinfunction="FLT_3" pintype="unspecified"/>
    <node ref="R3" pin="2" pinfunction="2_2" pintype="passive"/></net>
  <net code="3" name="/FLTn">
    <node ref="U5" pin="3" pinfunction="FLT_3" pintype="unspecified"/>
    <node ref="R2" pin="2" pinfunction="2_2" pintype="passive"/>
  </net>
  <net code="5" name="/ODD"><node ref="U4" pin="1" pinfunction="OUT_1" pintype="unspecified"/></net>
  <net code="6" name="/RXD"><node ref="U6" pin="5" pinfunction="RXD_5" pintype="unspecified"/>
    <node ref="R2" pin="1" pinfunction="1_1" pintype="passive"/></net>
  <net code="7" name="/FIELD_IN"><node ref="J1" pin="1" pinfunction="1_1" pintype="passive"/></net>
</nets></export>`;

/** A value as jsonLoads gives it. */
const json = <T = Dict>(value: unknown): T => jsonLoads(JSON.stringify(value)) as T;
const near = (actual: unknown, expected: number) => assert.ok(Math.abs((actual as number) - expected) < 1e-7, `${String(actual)} is not ${expected}`);
const known = (edge: NetEdge) => {
  if ('unknown' in edge) assert.fail(edge.unknown);
  return edge;
};
const reason = (edge: NetEdge): string => ('unknown' in edge ? edge.unknown : assert.fail('expected an unknown edge'));
const netlist = (comps: Record<string, string>, nets: Record<string, Node[]>, values: Record<string, string> = {}): Netlist =>
  ({ comps: new Map(Object.entries(comps)), values: new Map(Object.entries(values)), nets: new Map(Object.entries(nets)) });

const TABLE = json<DriverTable>({
  LTV: { mpn: ['LTV-217*'], pins: [{ match: 'COL', role: 'opto', tr_ns: 2000, tf_ns: 3000, source: 'fixture' }] },
  MCU: { mpn: ['STM32H743*'], pins: [{ match: 'P[A-K]\\d+', role: 'push_pull', tr_ns: 1.5, tf_ns: 2, source: 'fixture' }] },
  ODX: { mpn: ['ODX*'], pins: [{ match: 'FLT', role: 'open_drain', tf_ns: 8, source: 'test table' }] },
  FAST: { mpn: ['FAST*'], pins: [{ match: 'RXD', role: 'push_pull', tr_ns: 2.5, tf_ns: 3, source: 'fixture' }] },
});
const RS485 = json({
  rs485: { tr_ns: 460, source: 'class fixture', applicability: { kind: 'part', mpn: ['THVD1410*'], pins: 'A|B' } },
  i2c: { tr_ns: 12, source: 'protocol fixture', applicability: { kind: 'protocol', reason: 'open drain bus' } },
});
const receiver = json({ '/ALMn': { refs: ['U1'], reason: 'pin map: PE10 GPIO in' } });

test('parsing strips the pin number from the pin name', () => {
  const parsed = parseNetlist(XML);
  assert.deepEqual(parsed.nets.get('/ALMn')?.[0], ['U2', '4', 'COL']);
  assert.equal(parsed.comps.get('U2'), 'LTV-217-B-G');
  assert.equal(parsed.comps.get('R1'), '10k');
  assert.equal(pinName('7', null), '7');
  assert.equal(pinName('7', 'X_7_7'), 'X_7');
});

test('the export finds the CLI by KICAD_CLI and a missing schematic never looks like success', (t: TestContext) => {
  const folder = mkdtempSync(join(tmpdir(), 'nd-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const cli = join(folder, 'custom-cli');
  writeFileSync(join(folder, 'x.xml'), XML);
  writeFileSync(cli, `#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\ncp '${join(folder, 'x.xml')}' "$2"\n`);
  chmodSync(cli, 0o755);
  const schematic = join(folder, 'fixture.kicad_sch');
  writeFileSync(schematic, 'fixture');
  const saved = process.env.KICAD_CLI;
  process.env.KICAD_CLI = cli;
  t.after(() => { if (saved === undefined) delete process.env.KICAD_CLI; else process.env.KICAD_CLI = saved; });
  assert.equal(exportNetlist(schematic).comps.get('U1'), 'STM32H743VIT6');
  assert.throws(() => exportNetlist(join(folder, 'missing.kicad_sch')), /no schematic/);
  writeFileSync(cli, '#!/bin/sh\necho boom >&2\nexit 3\n');
  assert.throws(() => exportNetlist(schematic), /netlist export failed .*boom/);
});

test('the edge comes from the part, and a receiver is no driver', () => {
  const parsed = parseNetlist(XML);
  const opto = known(netEdge('/ALMn', parsed, TABLE, { receivers: receiver }));
  assert.equal(opto.edge_ns, 2000);
  assert.match(opto.driver, /LTV/);
  assert.doesNotMatch(opto.driver, /\+3V3/);
  assert.equal(known(netEdge('/ALMn', parsed, TABLE)).edge_ns, 1.5);
});

test('an open drain net uses the fall time', () => {
  const edge = known(netEdge('/OD2', parseNetlist(XML), TABLE));
  assert.equal(edge.edge_ns, 8);
  assert.match(edge.driver, /open drain, tf 8 ns/);
});

test('an unknown driver is flagged, not given a default', () => {
  assert.match(reason(netEdge('/ODD', parseNetlist(XML), TABLE)), /XYZ123: no entry/);
  assert.match(reason(netEdge('/NOPE', parseNetlist(XML), TABLE)), /is not in the schematic netlist/);
});

test('a series resistor passes the driver edge, and a rail is not followed', () => {
  const parsed = parseNetlist(XML);
  const edge = known(netEdge('/FLTn', parsed, TABLE));
  assert.equal(edge.edge_ns, 2.5);
  assert.match(edge.driver, /through R2/);
});

test('an off-board net needs an interface class and a matching driver part', () => {
  const parsed = parseNetlist(XML);
  assert.match(reason(netEdge('/FIELD_IN', parsed, TABLE)), /off-board via J1\.1/);
  const offboard = (extra: object) => json({ '/FIELD_IN': { class: 'rs485', reason: 'RS-485 bus from the drive', ...extra } });
  assert.match(reason(netEdge('/FIELD_IN', parsed, TABLE, { offboard: offboard({}), classes: RS485 })), /MPN\/pin/);
  assert.match(reason(netEdge('/FIELD_IN', parsed, TABLE, { offboard: offboard({ driver_mpn: 'SP3485EN-L/TR', driver_pin: 'A' }), classes: RS485 })), /incompatible/);
  assert.equal(known(netEdge('/FIELD_IN', parsed, TABLE, { offboard: offboard({ driver_mpn: 'THVD1410DR', driver_pin: 'A' }), classes: RS485 })).edge_ns, 460);
  assert.match(reason(netEdge('/FIELD_IN', parsed, TABLE, { offboard: json({ '/FIELD_IN': { class: 'none', reason: 'x' } }), classes: RS485 })), /offboard class none/);
});

test('a class binds to its part: another driver cannot hide behind it', () => {
  const table = json<DriverTable>({
    THVD: { mpn: ['THVD1410*'], pins: [{ match: 'A', role: 'input' }, { match: 'R', role: 'push_pull', tr_ns: 2, tf_ns: 2, source: 's' }] },
    SP: { mpn: ['SP3485*'], pins: [{ match: 'A', role: 'push_pull', tr_ns: 9, tf_ns: 9, source: 's' }] },
  });
  const options: EdgeOptions = { classes: RS485, interface: 'rs485' };
  assert.match(reason(netEdge('/A', netlist({ U13: 'SP3485EN-L/TR' }, { '/A': [['U13', '6', 'A']] }), table, options)), /incompatible/);
  assert.equal(known(netEdge('/A', netlist({ U1: 'THVD1410DR' }, { '/A': [['U1', '6', 'A']] }), table, options)).edge_ns, 460);
  assert.match(reason(netEdge('/A', netlist({ U1: 'THVD1410DR' }, { '/A': [['U1', '6', 'R']] }), table, options)), /incompatible/);
  const both = netlist({ U1: 'THVD1410DR', U2: 'SP3485EN-L/TR' }, { '/A': [['U1', '6', 'A'], ['U2', '6', 'A']] });
  assert.match(reason(netEdge('/A', both, table, options)), /incompatible/);
  assert.match(reason(netEdge('/ODD', parseNetlist(XML), TABLE, options)), /XYZ123/);
});

test('a protocol class stands for the net without a GPIO fallback', () => {
  const edge = known(netEdge('/ODD', parseNetlist(XML), TABLE, { classes: RS485, interface: 'i2c' }));
  assert.equal(edge.edge_ns, 12);
  assert.match(edge.driver, /protocol i2c/);
  assert.match(reason(netEdge('/E', netlist({}, { '/E': [] }), TABLE, { classes: RS485, interface: 'i2c' })), /no schematic endpoints/);
});

test('a table rule needs its times, positive and finite', (t: TestContext) => {
  const folder = mkdtempSync(join(tmpdir(), 'table-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'table.json');
  const load = (pins: object[]) => {
    writeFileSync(path, JSON.stringify({ parts: { X: { mpn: ['X'], pins } } }));
    return loadTable(path);
  };
  assert.throws(() => load([{ match: 'A', role: 'open_drain', tr_ns: 300, source: 's' }]), TableError);
  for (const value of [true, false, 0, -1]) assert.throws(() => load([{ match: 'O', role: 'push_pull', tr_ns: value, tf_ns: 1, source: 'f' }]), TableError);
  writeFileSync(path, '{"parts": {"X": {"mpn": ["X"], "pins": [{"match": "O", "role": "push_pull", "tr_ns": Infinity, "tf_ns": 1, "source": "f"}]}}}');
  assert.throws(() => loadTable(path), TableError);
  assert.equal(load([{ match: 'O', role: 'push_pull', tr_ns: 1, tf_ns: 1, source: 'f' }]).size, 1);
});

test('changed or escaping evidence is refused', () => {
  const evidence = (path: string) => json({ evidence_files: [{ path, sha256: '0'.repeat(64) }] });
  assert.throws(() => verifyEvidence(evidence('hardware-design/registry/datasheets/none.pdf')), /missing or changed/);
  assert.throws(() => verifyEvidence(evidence('hardware-design/registry/datasheets/../escape')), /invalid driver evidence path/);
  assert.throws(() => verifyEvidence(evidence('tools/x.pdf')), /invalid driver evidence path/);
});

test('a minimum counts only with a proof of that exact record', () => {
  const rule = json({ match: 'OUT', role: 'push_pull', tr_ns: 1, tf_ns: 2, stat: 'min', load: 'stated', source: 'fixture' });
  const mpns = ['MIN-PART'];
  const proof = (applies: boolean) => new ReviewedMinimumProof(minimumRecordHash('fixture', mpns, rule), ['primary', 'sha'], 'driver pin', 'matched', applies);
  assert.equal(timingEvidence(rule, 'fixture', mpns).qualified_fastest_bound, false);
  rule.set('_minimum_proof', proof(true));
  assert.equal(timingEvidence(rule, 'fixture', mpns).qualified_fastest_bound, true);
  rule.set('_minimum_proof', proof(false));
  const line = timingEvidence(rule, 'fixture', mpns);
  assert.equal(line.source_MIN_verified, true);
  assert.equal(line.qualified_fastest_bound, false);
  rule.set('tr_ns', 4n);
  assert.equal(timingEvidence(rule, 'fixture', mpns).source_MIN_verified, false);
  rule.set('tr_ns', 1n);
  assert.equal(timingEvidence(rule, 'fixture', ['DIFFERENT*']).source_MIN_verified, false);
  rule.set('stat', 'typ');
  assert.equal(timingEvidence(rule, 'fixture', mpns).source_MIN_verified, false);
});

test('a typical driver cannot hide behind a faster proved minimum', () => {
  const table = json<DriverTable>({
    minimum: { mpn: ['MIN'], pins: [{ match: 'OUT', role: 'push_pull', tr_ns: 1, tf_ns: 1, stat: 'min', source: 'm' }] },
    typical: { mpn: ['TYP'], pins: [{ match: 'OUT', role: 'push_pull', tr_ns: 20, tf_ns: 20, stat: 'typ', source: 't' }] },
  });
  const rule = ((table.get('minimum') as Dict).get('pins') as Dict[])[0] as Dict;
  rule.set('_minimum_proof', new ReviewedMinimumProof(minimumRecordHash('minimum', json(['MIN']), rule), ['p', 's'], 'driver pin', 'matched', true));
  const nets = netlist({ U1: 'MIN', U2: 'TYP' }, { '/SIG': [['U1', '1', 'OUT'], ['U2', '1', 'OUT']] });
  const edge = known(netEdge('/SIG', nets, table));
  assert.equal(edge.edge_ns, 1);
  const contributors = edge.timing_evidence.contributors as { evidence: Record<string, unknown> }[];
  assert.deepEqual(contributors.map(row => row.evidence.qualified_fastest_bound), [true, false]);
  assert.equal(edge.timing_evidence.qualified_fastest_bound, false);
});

test('numbers read from names and values', () => {
  assert.equal(railVolts('VDD_3V3'), 3.3);
  assert.equal(railVolts('+15V'), 15);
  assert.equal(railVolts('FIELD_5V'), 5);
  assert.equal(railVolts('3V3_5V'), null);
  assert.equal(railVolts(null), null);
  const cases: [string, number | null][] = [['10k', 10000], ['4.7k', 4700], ['330', 330], ['1M', 1e6], ['4k7', 4700], ['0R', 0], ['1m', 1e6], ['x', null]];
  for (const [text, ohms] of cases) assert.equal(rValue(text), ohms);
});

test('the C*dV/I formula refuses nonfinite and negative input', () => {
  for (const [c, v, i] of [[Infinity, 3.3, 20], [1, -3.3, 20], [1, 3.3, 0]] as const) assert.throws(() => edgeBoundNs(c, v, i), TableError);
  assert.throws(() => seriesLimitMa(0, 1, 1), TableError);
  near(seriesLimitMa(1000, 3.3, 100), 3.3 / 95 * 1000);
});

test('microstrip capacitance per length has the size of a 50 ohm line', () => {
  const pf = microstripPfPerMm(0.3, 0.17, 0.035, 4.5);
  assert.ok(pf > 0.05 && pf < 0.2, String(pf));
});

// D-124c hand calculations and unknown-on-error integration coverage.
const LOAD_MODEL = `[Component] GATE
[Pin] signal_name model_name
4 Y OUT
5 VCC POWER
[Model Selector] OUT
OUT_33 gate
[Model] OUT_33
Model_type Output
C_comp 7.52pF 3.81pF 9.89pF
[Voltage Range] 3.3 3.0 3.6
[Pullup Reference] 3.3 3.0 3.6
[Pulldown]
-1 -50mA -40mA -60mA
0 0 0 0
3.6 36mA 18mA 72mA
[Pullup]
0 0 0 0
3.6 -18mA -9mA -36mA
[Ramp]
dV/dt_r 3.3/0.1n 3.3/0.1n 3.3/0.1n
dV/dt_f 3.3/0.1n 3.3/0.1n 3.3/0.1n
[End]
`;
const SCREEN_MODEL = `[IBIS Ver] 4.1
[Component] GATE
[Pin] signal_name model_name
1 A IN
4 Y OUT
5 VCC POWER
[Model Selector] OUT
OUT_33 output3V3
[Model] IN_33
Model_type Input
C_comp 3pF 2pF 4pF
[Model] OUT_33
Model_type Output
C_comp 3pF 2pF 4pF
[Voltage Range] 3.3 3 3.6
[Temperature Range] 25 125 -40
[Pulldown]
0 0 0 0
3.6 36mA 18mA 72mA
[Pullup]
0 0 0 0
3.6 -18mA -9mA -36mA
[Ramp]
dV/dt_r 3.3/0.1n 3.3/0.1n 3.3/0.1n
dV/dt_f 3.3/0.1n 3.3/0.1n 3.3/0.1n
[End]
`;

const folder = mkdtempSync(join(tmpdir(), 'ibis-load-'));
after(() => rmSync(folder, { recursive: true, force: true }));
const file = join(folder, 'fixture.ibs');
let part: Dict;
let table: DriverTable;
let nets: Netlist;
let geom: Geometry;

function write(text: string): void {
  writeFileSync(file, text);
  (part.get('ibis') as Dict).set('sha256', createHash('sha256').update(text).digest('hex'));
}

function setUp(text: string): void {
  part = json({
    mpn: ['GATE'], ibis: { file, sha256: '', component: 'GATE', supply_pin: 'VCC', variants: { 3.3: '_33' }, url: 'fixture', downloaded: '2026-10-10' },
    pins: [{ match: 'Y', role: 'push_pull', ibis_model: 'OUT', source: 'fixture V-I' }, { match: 'A|VCC', role: 'input' }],
  });
  table = new Map([['gate', part]]);
  write(text);
  nets = netlist({ U1: 'GATE' }, { '/Y': [['U1', '4', 'Y']], VDD_3V3: [['U1', '5', 'VCC']] });
  geom = { length_mm: { '/Y': 10 }, pf_per_mm: { '/Y': [0.1, 'test 0.1 pF/mm'] } };
}

const rule = () => (part.get('pins') as Dict[])[0] as Dict;
const edge = () => netEdge('/Y', nets, table, { geom });
const evidenceOf = (result: NetEdge) => (known(result).timing_evidence.contributors as { evidence: Record<string, unknown> }[])[0]?.evidence as Record<string, any>;
const estimateOf = (result: NetEdge) => evidenceOf(result).estimates[0] as Record<string, unknown>;
const useBound = (bound: object) => {
  rule().delete('ibis_model');
  rule().set('bound', json(bound));
};
const addSeries = () => {
  nets.comps.set('R1', '10k');
  nets.values?.set('R1', '10k');
  nets.nets.get('/Y')?.push(['R1', '1', '1']);
  nets.nets.set('/POST', [['R1', '2', '2']]);
};

beforeEach(() => setUp(LOAD_MODEL));

test('the load uses V-I, not the fixture ramp, and never certifies a bound', () => {
  const result = known(edge());
  near(result.edge_ns, 0.3848);
  assert.match(result.driver, /V-I conditional estimate/);
  assert.equal(result.timing_evidence.qualified_fastest_bound, false);
  const proof = evidenceOf(result);
  assert.equal(proof.kind, 'ibis_vi_load_estimate');
  assert.equal(proof.inputs.trace_capacitance_pf, 1);
  near(proof.estimates[0].driver_c_comp_min_pf, 3.81);
  assert.equal(proof.primary_evidence.sha256, (part.get('ibis') as Dict).get('sha256'));
  (geom.length_mm as Record<string, number>)['/Y'] = 20;
  near(known(edge()).edge_ns, 0.4648);
});

test('the edge is the larger of ramp and C*dV/I', () => {
  // D-124e. [Ramp] 3.3 V / 1 ns into R_fixture: fastest corner = min supply 3.0 V: 0.8 * 3.0 / 3.3e9 = 0.72727 ns > fall 0.3848 ns.
  write(LOAD_MODEL.replaceAll('3.3/0.1n', '3.3/1n'));
  const slow = estimateOf(edge());
  near(known(edge()).edge_ns, 0.8 * 3 / 3.3);
  assert.equal(slow.bound_f, 'ramp');
  near(slow.tf_vi_ns, 0.3848);
  near(slow.tr_ns, 0.7696);
  assert.equal(slow.bound_r, 'C*dV/I');
  write(LOAD_MODEL);
  const fast = estimateOf(edge());
  assert.equal(fast.bound_f, 'C*dV/I');
  near(fast.tf_ramp_ns, 0.08 * 3 / 3.3);
});

test('no ramp or no V-I table is unknown, never a fallback', () => {
  write(LOAD_MODEL.replace('[Ramp]', '[Ramp Removed]'));
  assert.match(reason(edge()), /ramp/);
  write(LOAD_MODEL.replace('[Pulldown]', '[GND Clamp]'));
  rule().set('tr_ns', 1n);
  rule().set('tf_ns', 1n);
  assert.match(reason(edge()), /no pulldown/);
});

test('receiver capacitance and missing loads are attributed', () => {
  nets.comps.set('U2', 'RECEIVER');
  nets.comps.set('U3', 'MISSING');
  nets.nets.get('/Y')?.push(['U2', '1', 'IN'], ['U3', '1', 'IN']);
  table.set('receiver', json({ mpn: ['RECEIVER'], pin_c: { pf: 2, source: 'receiver fixture' }, pins: [{ match: 'IN', role: 'input' }] }));
  table.set('missing', json({ mpn: ['MISSING'], pins: [{ match: 'IN', role: 'input' }] }));
  const result = edge();
  near(known(result).edge_ns, 0.5448);
  const { inputs } = evidenceOf(result);
  assert.equal(inputs.receiver_capacitance_pf, 2);
  assert.deepEqual(inputs.omitted_loads, ['U3.IN']);
});

test('missing geometry is unknown', () => {
  assert.match(reason(netEdge('/Y', nets, table)), /routed length/);
  assert.match(reason(netEdge('/Y', nets, table, { geom: { length_mm: { '/Y': 10 } } })), /routed length/);
});

test('with no supply rail, a bad possible model stays visible', () => {
  nets.nets.delete('VDD_3V3');
  ((part.get('ibis') as Dict).get('variants') as Dict).set('5', '_MISSING');
  assert.match(reason(edge()), /not in/);
});

test('with no supply rail, all variants stay uncertain', () => {
  nets.nets.delete('VDD_3V3');
  assert.match(String(estimateOf(edge()).supply_resolution), /rail not found/);
});

test('a series part drops the driver capacitance and limits the current', () => {
  addSeries();
  const result = netEdge('/POST', nets, table, { geom: { length_mm: { '/POST': 10 }, pf_per_mm: { '/POST': [0.1, 'fixture'] } } });
  assert.ok(known(result).edge_ns > 5);
  const estimate = estimateOf(result);
  assert.equal(estimate.driver_capacitance_omitted_for_series, true);
  assert.equal(estimate.driver_c_comp_min_pf, 0);
  near(estimate.series_current_limit_a, 3.3 / (0.95 * 10000));
  assert.equal(known(result).timing_evidence.qualified_fastest_bound, false);
});

test('a wrong pin, role or source is unknown', () => {
  setUp(SCREEN_MODEL);
  const screened = edge();
  near(known(screened).edge_ns, 0.24);
  assert.equal(estimateOf(screened).capacitance_pf, 3);
  assert.equal(estimateOf(screened).driver_c_comp_min_pf, 2);
  assert.equal(estimateOf(screened).corner_f, 'max');
  nets.nets.set('/Y', [['U1', '1', 'Y']]);
  assert.match(reason(edge()), /selector mismatch/);
  setUp(SCREEN_MODEL);
  rule().set('role', 'open_drain');
  nets.comps.set('R1', '10k');
  nets.nets.get('/Y')?.push(['R1', '1', '1']);
  nets.nets.get('VDD_3V3')?.push(['R1', '2', '2']);
  assert.match(reason(edge()), /incompatible/);
  rule().set('role', 'push_pull');
  writeFileSync(file, `${SCREEN_MODEL}\n| changed`);
  assert.match(reason(edge()), /hash mismatch/);
});

test('an unknown driver is not masked by a model', () => {
  nets.comps.set('U2', 'UNKNOWN');
  nets.nets.get('/Y')?.push(['U2', '1', 'OUT']);
  assert.match(reason(netEdge('/Y', nets, table)), /no entry/);
});

test('a minimum capacitance that is NA is not substituted', () => {
  write(LOAD_MODEL.replace('C_comp 7.52pF 3.81pF 9.89pF', 'C_comp 3pF NA 4pF'));
  assert.equal(pinCPf('GATE', 'Y', table)[0], null);
  assert.match(reason(edge()), /C_comp minimum unavailable/);
});

test('the bound formula stays conditional', () => {
  useBound({ i_ma: 20, i_source: 'approx drive', vdd_v: 3.3, cpin_pf: 2, cpin_source: 'typ capacitance' });
  const result = known(netEdge('/Y', nets, table, { geom: { length_mm: { '/Y': 10 }, pf_per_mm: { '/Y': [0.1, 'estimated microstrip'] } } }));
  near(result.edge_ns, 3 * 2.64 / 20);
  const evidence = evidenceOf(result);
  assert.equal(evidence.kind, 'conditional_capacitance_current_estimate');
  assert.equal(evidence.qualified_fastest_bound, false);
  assert.equal(evidence.geometry_screening.length_mm, 10);
  assert.deepEqual(evidence.geometry_screening.pf_per_mm, [0.1, 'estimated microstrip']);
  assert.match(result.driver, /conditional estimate: C\*dV\/I/);
  assert.ok('unknown' in netEdge('/Y', nets, table));
});

test('invalid geometry is unknown, not a screening pass', () => {
  useBound({ i_ma: 20, i_source: 'approx', vdd_v: 3.3 });
  for (const value of [Infinity, NaN, -1]) {
    assert.ok('unknown' in netEdge('/Y', nets, table, { geom: { length_mm: { '/Y': value }, pf_per_mm: { '/Y': [0.1, 'screen'] } } }));
  }
});

test('a series resistor limits a bound too, unqualified', () => {
  useBound({ i_ma: 20, i_source: 'approx', vdd_v: 3.3 });
  addSeries();
  const result = known(netEdge('/POST', nets, table, { geom: { length_mm: { '/POST': 10 }, pf_per_mm: { '/POST': [0.1, 'screen'] } } }));
  near(result.edge_ns, 7.6);
  assert.equal(result.timing_evidence.qualified_fastest_bound, false);
});

test('a sibling output is not checked as the selected pin', () => {
  rule().set('match', 'Y|Z');
  nets.nets.set('/Z', [['U1', '1', 'Z']]);
  near(known(edge()).edge_ns, 0.3848);
});
