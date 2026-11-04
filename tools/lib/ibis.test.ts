// IBIS parser and screening regressions. The fixture is synthetic; real vendor files are checked in
// net-drivers-project.test.ts where the project data exists.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { IbisError, load, type Model, number, parse, rampEdges, viAvgCurrent, viEdges, type ViRow } from './ibis.ts';

const FIX = `[IBIS Ver] 4.1
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
C_comp 3pF NA 4pF
[Voltage Range] 3.3 3 3.6
[Temperature Range] 25 125 -40
[Ramp]
dV/dt_r 1/10n 1/1n 1/5n
dV/dt_f 1/10n NA 1/5n
[End]
`;

const VI_MODEL = `[Model] OUT
Model_type Output
C_comp 3pF 2pF 4pF
[Voltage Range] 3.3 3.0 3.6
[Pulldown]
0 0 0 0
3.6 36mA 18mA 72mA
[Pullup]
0 0 0 0
3.6 -18mA -9mA -36mA
[Ramp]
dV/dt_r 3.3/0.1n 3.0/0.1n 3.6/0.1n
dV/dt_f 3.3/0.1n 3.0/0.1n 3.6/0.1n
[End]
`;

const lines = (text: string) => text.split('\n');
const fixture = (text = FIX) => parse(lines(text)).models.get('out_33') as Model;
const viModel = () => parse(lines(VI_MODEL)).models.get('out') as Model;
const near = (actual: number | undefined, expected: number) =>
  assert.ok(Math.abs((actual as number) - expected) < 1e-7, `${actual} is not ${expected}`);
const rejected = (action: () => unknown) => assert.throws(action, IbisError);

test('a number accepts space around it and NA', () => {
  assert.equal(number('  3.3n  '), 3.3e-9);
  assert.equal(number('  NA  '), null);
});

test('corners, load and PVT stay explicit', () => {
  const model = fixture();
  const edges = rampEdges(model);
  assert.equal(edges.tr_ns, 1);
  assert.equal(edges.corner_r, 'min');
  assert.deepEqual(edges.missing_corners.f, ['min']);
  assert.equal(edges.r_load_ohm, 50);
  assert.equal(edges.r_load_default, true);
  assert.deepEqual(edges.voltage_range, [3.3, 3, 3.6]);
  assert.deepEqual(edges.temperature_range, [25, 125, -40]);
  assert.equal((model.c_comp as (number | null)[])[1], null);
});

test('an explicit R_load replaces the default', () => {
  assert.equal(rampEdges(fixture(FIX.replace('[End]', 'R_load = 300ohms\n[End]'))).r_load_ohm, 300);
});

test('a requested corner that is missing fails', () => {
  const model = fixture(FIX.replace('1/1n 1/5n', 'NA NA').replace('NA 1/5n', 'NA NA'));
  rejected(() => rampEdges(model, ['min', 'max']));
});

test('invalid numbers and ramps are refused', () => {
  for (const token of ['1e999', 'nan', 'inf', '1banana']) rejected(() => number(token));
  for (const replacement of ['1/0', '1/-1n', '0/1n', 'NA']) rejected(() => parse(lines(FIX.replace('1/10n', replacement))));
});

test('a duplicate model is refused', () => {
  rejected(() => parse(lines(`${FIX}\n[Model] OUT_33`)));
});

test('load follows the content and binds the hash', (t: TestContext) => {
  const folder = mkdtempSync(join(tmpdir(), 'ibis-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'x.ibs');
  writeFileSync(path, FIX);
  const sha = createHash('sha256').update(FIX).digest('hex');
  const first = load(path, sha);
  writeFileSync(path, FIX.replace('1/1n', '1/2n'));
  assert.notEqual(load(path).source_sha256, first.source_sha256);
  rejected(() => load(path, sha));
});

test('static mean current and a hand-calculated load', () => {
  const model = viModel();
  const edges = viEdges(model, 4.81e-12);
  near(viAvgCurrent(model.vi.pulldown as ViRow[], 'typ', 0.33, 2.97), 0.0165);
  near(edges.tf_ns, 0.3848);
  near(edges.tr_ns, 0.7696);
  assert.equal(edges.corner_f, 'max');
  assert.equal(edges.qualified_fastest_bound, false);
  const openDrain = viEdges(model, 4.81e-12, { swing_v: 3.3, open_drain: true });
  assert.ok(!('tr_ns' in openDrain));
  near(openDrain.tf_ns, 0.3848);
});

test('the ramp time is a lower bound of the edge', () => {
  // D-124e. Ramp 3.3 V / 1 ns typ, 3.0 V / 1.5 ns min, 3.6 V / 0.5 ns max: 10-90 % of the corner's swing
  // (Voltage Range 3.3 / 3.0 / 3.6) = 0.8 V / (dV/dt) = 0.8, 1.2, 0.4 ns; the faster corner (max) is 0.4 ns.
  const model = viModel();
  model.ramp.f = [[3.3, 1e-9], [3.0, 1.5e-9], [3.6, 0.5e-9]];
  let edges = viEdges(model, 4.81e-12); // C*dV/I (fall): typ .7696, max .3848 ns
  near(edges.tf_ramp_ns, 0.4);
  near(edges.tf_vi_ns, 0.3848);
  near(edges.tf_ns, 0.4);
  assert.equal(edges.bound_f, 'ramp');
  edges = viEdges(model, 40e-12); // C*dV/I (fall) max 3.2 ns > 0.4 ns
  near(edges.tf_ns, edges.tf_vi_ns);
  assert.equal(edges.bound_f, 'C*dV/I');
});

test('a missing ramp is an error', () => {
  const model = viModel();
  model.ramp = {};
  rejected(() => viEdges(model, 4.81e-12));
});

test('missing corners are not typical', () => {
  const model = viModel();
  ((model.vi.pulldown as ViRow[])[0] as ViRow)[1][2] = null;
  const edges = viEdges(model, 4.81e-12);
  assert.equal(edges.corner_f, 'typ');
  assert.deepEqual(edges.missing_corners.f, ['max']);
  rejected(() => viEdges(model, 4.81e-12, { corners: ['max'] }));
});

test('an invalid load, limit, interval or current is refused', () => {
  for (const c of [0, -1, NaN, Infinity]) rejected(() => viEdges(viModel(), c));
  for (const limit of [0, -1, Infinity]) rejected(() => viEdges(viModel(), 1e-12, { i_limit_a: limit }));
  const flat = (v: number): (number | null)[] => [v, v, v];
  const tables: ViRow[][] = [
    [[0, flat(0)], [1, flat(0.01)]], [[0, flat(0.01)], [3.6, flat(-0.01)]], [[0, flat(0)], [3.6, flat(0)]],
  ];
  for (const rows of tables) rejected(() => viAvgCurrent(rows, 'typ', 0.33, 2.97));
});

test('malformed, duplicate and nonfinite V-I rows are refused', () => {
  const base = '[Model] OUT\nModel_type Output\n[Pulldown]\n';
  for (const rows of ['0 0 0\n', 'NA 0 0 0\n', '0 NA 0 0\n', '0 0 0 0\n0 1 1 1\n', '0 0 0 0\n1 1e999 0 0\n', '0 0 0 0\n[Pulldown]\n']) {
    rejected(() => parse(lines(base + rows)));
  }
});

test('a series limit bounds the current; an input model is no driver', () => {
  const edges = viEdges(viModel(), 1e-12, { i_limit_a: 0.001 });
  near(edges.tf_ns, 2.4);
  assert.equal(edges.corner_f, 'min');
  const input = viModel();
  input.type = 'Input';
  rejected(() => viEdges(input, 1e-12));
  rejected(() => viEdges(viModel(), 1e-12, { open_drain: true }));
});
