import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Board } from './board-types.ts';
import { candidateFields } from './pcb-candidate-admission.ts';
import { planNets, routePlanNetErrors } from './route-plan-nets.ts';

const nets = { nets: new Set(['/A', '/B', '/C', 'GND']), routable: new Set(['/A', '/B', 'GND']) };
const plan = (...stages: object[]) => ({ schema: 'iot-lab.route.v1', backend: 'iotroute', layers: ['F.Cu'], stages });

test('a catch-all stage covers every routable net', () => {
  assert.deepEqual(routePlanNetErrors(plan({ name: 'all' }), nets), []);
  assert.deepEqual(routePlanNetErrors(plan({ name: 'power', only_nets: ['GND'] }, { name: 'rest', skip_nets: ['GND'] }), nets), []);
  assert.deepEqual(routePlanNetErrors(plan({ name: 'all', only_nets: [] }), nets), [], 'an empty only_nets is a catch-all, as in the router');
});

test('only_nets stages must together name every routable net', () => {
  assert.deepEqual(routePlanNetErrors(plan({ name: 'a', only_nets: ['/A', 'GND'] }, { name: 'b', only_nets: ['/B'] }), nets), []);
  const errors = routePlanNetErrors(plan({ name: 'a', only_nets: ['/A'] }), nets);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /no stage routes/);
  assert.match(errors[0]!, /\/B/);
  assert.match(errors[0]!, /GND/);
  assert.doesNotMatch(errors[0]!, /\/C/, 'a net with one pad is not routable');
});

test('a stage net name that is not on the board is an error, in every field that names nets exactly', () => {
  for (const field of ['only_nets', 'plane_nets', 'unlock_nets']) {
    const errors = routePlanNetErrors(plan({ name: 'all' }, { name: 'x', [field]: ['/MISSING'] }), nets);
    assert.equal(errors.length, 1, field);
    assert.match(errors[0]!, new RegExp(`stages\\[1\\].${field}: /MISSING is not a net of this board`));
  }
});

test('skip_nets are patterns and are not checked as names', () => {
  assert.deepEqual(routePlanNetErrors(plan({ name: 'all', skip_nets: ['/NOPE_*'] }), nets), []);
});

test('stage order is not checked', () => {
  assert.deepEqual(routePlanNetErrors(plan({ name: 'rest', skip_nets: ['/A'] }, { name: 'a', only_nets: ['/A'] }), nets), []);
});

test('a plan without a list of stages fails closed', () => {
  assert.equal(routePlanNetErrors({ schema: 'iot-lab.route.v1' }, nets).length, 1);
  assert.match(routePlanNetErrors(plan(null as never), nets)[0]!, /stages\[0\] must be an object/);
});

test('route admission stops a route-json plan that leaves a net unrouted or names a net the board lacks', t => {
  const root = mkdtempSync(join(tmpdir(), 'route-plan-nets-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const spec = join(root, 'route.json'), read = () => nets;
  const admit = (value: object, router = 'route-json') => { writeFileSync(spec, JSON.stringify(value)); return candidateFields(root, 'route', 'X', { router, spec }, undefined, read); };
  assert.ok(admit(plan({ name: 'all' })).spec);
  assert.throws(() => admit(plan({ name: 'a', only_nets: ['/A'] })), /no stage routes 2 nets of this board: \/B, GND/);
  assert.throws(() => admit(plan({ name: 'all' }, { name: 'x', only_nets: ['/MISSING'] })), /stages\[1\].only_nets: \/MISSING is not a net of this board/);
  assert.throws(() => admit({ schema: 'iot-lab.route.v1' }), /no list of stages/);
});

test('planNets takes the nets of the board and counts the pads of each', () => {
  const pad = (net: string) => ({ net });
  const board = { nets: { '/A': 'Default', '/B': 'Default', '': 'Default', NC: 'Default' },
    footprints: [{ pads: [pad('/A'), pad('/B'), pad(''), pad('NC')] }, { pads: [pad('/A'), pad('/B'), pad('')] }] } as unknown as Board;
  const { nets: all, routable } = planNets(board);
  assert.deepEqual([...all].sort(), ['/A', '/B', 'NC']);
  assert.deepEqual([...routable].sort(), ['/A', '/B']);
});
