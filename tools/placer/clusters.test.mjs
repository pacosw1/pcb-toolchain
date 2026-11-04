import assert from 'node:assert/strict';
import test from 'node:test';
import {farads, parseSexpr, propose, readBoard, render} from './clusters.mjs';
import {capDistances, compare, timeSplit, wire} from './bench_clusters.mjs';

// One footprint as KiCad 10 writes it. pads: [[number, net], ...].
function fp(ref, value, pads, description = '', at = '10 10') {
  const items = pads.map(([n, net]) => `(pad "${n}" smd rect (at 0 0) (size 1 1) (layers "F.Cu")${net ? ` (net "${net}")` : ''})`);
  return `(footprint "lib:x" (layer "F.Cu") (at ${at})
    (property "Reference" "${ref}" (at 0 0 0)) (property "Value" "${value}" (at 0 0 0))
    (property "Description" "${description}" (at 0 0 0)) ${items.join(' ')})`;
}
const board = items => readBoard(`(kicad_pcb (version 20250000) ${items.join('\n')})`);
const ties = res => Object.fromEntries(res.clusters.flatMap(c => c.ties).map(t => [t.ref, t]));

const IC = (ref, nets, description = '') => fp(ref, 'IC', nets.map((n, i) => [String(i + 1), n]), description);
const CAP = (ref, net, value = '100nF', description = '') => fp(ref, value, [['1', net], ['2', 'GND']], description);

test('the reader takes references, values and pad nets, and both net forms', () => {
  const [p] = readBoard('(kicad_pcb (footprint "l" (property "Reference" "C1") (property "Value" "1\\"u") (pad "1" smd rect (net 3 "A")) (pad "2" smd rect (net "B")) (pad "3" smd rect)))');
  assert.equal(p.ref, 'C1');
  assert.equal(p.value, '1"u');
  assert.deepEqual(p.pads, [{num: '1', net: 'A'}, {num: '2', net: 'B'}, {num: '3', net: ''}]);
  assert.deepEqual(parseSexpr('(a (b "c d") e)'), ['a', ['b', 'c d'], 'e']);
});

test('farads reads the value forms of the boards', () => {
  assert.ok(Math.abs(farads('100nF') - 100e-9) < 1e-15);
  assert.ok(Math.abs(farads('2u2') - 2.2e-6) < 1e-15);
  assert.ok(Math.abs(farads('10uF 50V') - 10e-6) < 1e-15);
  assert.equal(farads('STM32'), 0);
});

test('a cap goes to the pin its Description names, if that pin is on its net', () => {
  const res = propose(board([
    IC('U1', ['+3V3', 'A', 'B', 'GND']), IC('U2', ['+3V3', 'A', 'B', 'GND']),
    CAP('C1', '+3V3', '100nF', 'VDD decoupling, next to U2 pin 1'),
    CAP('C2', '+3V3', '100nF', 'copied from a block: next to U2 pin 3'),
  ]));
  const t = ties(res);
  assert.equal(t.C1.to, 'U2');
  assert.equal(t.C1.rule, 'decap');
  assert.match(t.C1.why, /Description names U2/);
  assert.equal(t.C2.to, 'U1');  // pin 3 is not on +3V3: the Description is stale, so the rail is spread by count
});

test('the caps of a shared rail spread over its pins', () => {
  const res = propose(board([
    IC('U1', ['V', 'V', 'B', 'GND']), IC('U2', ['V', 'A', 'B', 'GND']),
    CAP('C1', 'V'), CAP('C2', 'V'), CAP('C3', 'V'),
  ]));
  const to = Object.values(ties(res)).map(t => `${t.to}.${t.to_pad}`).sort();
  assert.deepEqual(to, ['U1.1', 'U1.2', 'U2.1']);
});

test('a crystal ties to its IC, and its load caps to the crystal', () => {
  const res = propose(board([
    IC('U1', ['XI', 'XO', 'B', 'GND']), fp('Y1', '8MHz', [['1', 'XI'], ['2', 'XO']]),
    CAP('C1', 'XI', '18pF'), CAP('C2', 'XO', '18pF'), fp('R1', '1M', [['1', 'XI'], ['2', 'XO']]),
  ]));
  const t = ties(res);
  assert.deepEqual([t.Y1.to, t.Y1.rule], ['U1', 'crystal']);
  assert.deepEqual([t.C1.to, t.C2.to, t.R1.to], ['Y1', 'Y1', 'Y1']);
  assert.equal(res.clusters.length, 1);
  assert.equal(res.clusters[0].anchor, 'U1');
  assert.ok(res.clusters[0].parts.indexOf('Y1') < res.clusters[0].parts.indexOf('C1'), 'a parent comes first');
});

test('a regulator gets its switch node, feedback and caps, also behind the inductor', () => {
  const res = propose(board([
    fp('U1', 'AP63203', [['1', 'VIN'], ['2', 'SW'], ['3', 'FB'], ['4', 'GND'], ['5', 'BST']], 'Buck regulator'),
    fp('L1', '4.7uH', [['1', 'SW'], ['2', '+3V3']]),
    fp('C1', '100nF', [['1', 'BST'], ['2', 'SW']]),
    fp('R1', '100k', [['1', '+3V3'], ['2', 'FB']]), fp('R2', '22k', [['1', 'FB'], ['2', 'GND']]),
    CAP('C2', 'VIN', '10uF'), CAP('C3', '+3V3', '22uF'),
  ]));
  const t = ties(res);
  for (const r of ['L1', 'C1', 'R1', 'R2', 'C2', 'C3']) assert.equal(t[r].rule, 'regulator', r);
  assert.equal(t.L1.to, 'U1');
  assert.equal(t.C3.to, 'L1');
  assert.equal(res.clusters[0].regulator, true);
});

test('an MCU is not a regulator because its Description says so', () => {
  const pins = Array.from({length: 20}, (_, i) => `N${i}`);
  const res = propose(board([IC('U1', ['+3V3', ...pins, 'GND'], 'MCU with an internal regulator'), CAP('C1', '+3V3')]));
  assert.equal(ties(res).C1.rule, 'decap');
});

test('a series resistor and an ESD part sit at the connector, a series resistor without one at the IC pin', () => {
  const res = propose(board([
    fp('J1', 'CONN', [['1', 'IN'], ['2', 'GND']]), IC('U1', ['SIG', 'OUT', 'B', 'GND']),
    fp('R1', '100R', [['1', 'IN'], ['2', 'SIG']]), fp('D1', 'PESD5V', [['1', 'IN'], ['2', 'GND']]),
    fp('R2', '33R', [['1', 'OUT'], ['2', 'FAR']]), fp('K1', 'relay', [['1', 'FAR'], ['2', 'FAR2'], ['3', 'FAR3']]),
  ]));
  const t = ties(res);
  assert.deepEqual([t.R1.to, t.R1.rule], ['J1', 'series']);
  assert.deepEqual([t.D1.to, t.D1.rule], ['J1', 'esd']);
  assert.deepEqual([t.R2.to, t.R2.rule], ['U1', 'series']);
});

test('a cap on a signal net is a filter, not a decap', () => {
  const res = propose(board([IC('U1', ['NRST', 'A', 'B', 'GND']), CAP('C1', 'NRST')]));
  assert.equal(ties(res).C1.rule, 'filter');
});

test('a part with a mechanical, user or test role is never tied', () => {
  const res = propose(board([
    IC('U1', ['+3V3', 'BTN', 'LEDK', 'TEST', 'GND']), fp('SW1', 'button', [['1', 'BTN'], ['2', 'GND']]),
    fp('D1', 'green', [['1', 'LEDK'], ['2', 'LA']], 'Status LED'), fp('R1', '1k', [['1', 'LA'], ['2', '+3V3']]),
    fp('TP1', 'tp', [['1', 'TEST']]), fp('J1', 'CONN', [['1', 'TEST2'], ['2', 'GND']]), fp('J2', 'CONN', [['1', 'TEST2']]),
  ]));
  const t = ties(res);
  for (const r of ['SW1', 'D1', 'TP1', 'J1', 'J2']) assert.equal(t[r], undefined, r);
  assert.equal(t.R1, undefined, 'nothing chains behind an indicator');
});

test('every ground form counts as ground', () => {
  for (const g of ['GND', 'FIELD_GND', 'FGND2', '/CAN_GND', 'FIELD_0V', 'VSS']) {
    const res = propose(board([IC('U1', ['+5V', 'A', 'B', g]), fp('C1', '1uF', [['1', '+5V'], ['2', g]])]));
    assert.equal(ties(res).C1?.rule, 'decap', g);
  }
});

test('a part with no rule stays loose and the text says so', () => {
  const res = propose(board([fp('R1', '1k', [['1', 'A'], ['2', 'B']]), fp('H1', 'hole', [['1', '']])]));
  assert.deepEqual(res.clusters, []);
  assert.deepEqual(res.loose, ['R1']);
  assert.match(render(res), /no rule: R1/);
});

test('every tie says why, and the text shows it', () => {
  const res = propose(board([IC('U1', ['+3V3', 'A', 'B', 'GND']), CAP('C1', '+3V3')]));
  assert.ok(res.clusters.every(c => c.why && c.ties.every(t => t.why && t.rule)));
  const text = render(res);
  assert.match(text, /U1 IC: 1 decap/);
  assert.match(text, /C1\.1 -> U1\.1 {2}decap: /);
  assert.match(text, /SUMMARY clusters 1, clustered parts 2 of 2/);
});

test('the answer does not depend on where the parts are', () => {
  const items = at => [fp('U1', 'IC', [['1', '+3V3'], ['2', 'A'], ['3', 'B'], ['4', 'GND']], '', at),
    fp('C1', '1uF', [['1', '+3V3'], ['2', 'GND']], '', at === '1 1' ? '90 90' : '2 2')];
  assert.deepEqual(propose(board(items('1 1'))), propose(board(items('50 50'))));
});

test('the bench counts only the real nets as wire and measures a cap from its power pad', () => {
  const pr = {
    units: [{cu_pads: [['U1', 'smd', '1'], ['U1', 'smd', '2'], ['U1', 'smd', '3'], ['U1', 'smd', '4']],
      cu: [[0, 0, 0, 0, 1], [1, 0, 1, 0, 3], [2, 0, 2, 0, 3], [3, 0, 3, 0, 2]]},
    {cu_pads: [['C1', 'smd', '1'], ['C1', 'smd', '2']], cu: [[0, 0, 0, 0, 1], [1, 0, 1, 0, 2]]}],
    cu_nets: {1: ['+3V3', 'D'], 2: ['GND', 'D'], 3: ['A', 'D']},
    nets: [{weight: 1, pins: [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0]]},
      {weight: 4, cohesion: true, pins: [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0]]}],
  };
  const pose = [[0, 0, 0], [3, 4, 1]];
  assert.deepEqual(wire(pr, pose), {hpwl: 7, ties: 28});
  assert.equal(capDistances(pr, pose).C1, 5);
});

test('the bench pairs caps by seed and ignores a change below the noise', () => {
  const time = {setup: 1, search: 2, barrier: 3, legalize: 4};
  const row = (d, cost = 10) => ({cost, hpwl: 1, cong: 1, spacing: 0, illegal: 0, timeout: false, wall: 1, moves: 1, time, caps: {C1: d}});
  const r = compare('B', [row(5), row(5), row(5)], [row(1), row(9), row(5.1)]);
  assert.deepEqual([r.better, r.worse, r.same], [1, 1, 1]);
});

test('the bench splits the wall time from the search profile', () => {
  const p = {setup_seconds: 1, pool_create_seconds: 2, finish_map_seconds: 9,
    epochs: [{map_seconds: 5, worker_search_seconds: [3, 4]}, {map_seconds: 6, worker_search_seconds: [5, 2]}]};
  assert.deepEqual(timeSplit(p), {setup: 3, search: 9, barrier: 2, legalize: 9});
});
