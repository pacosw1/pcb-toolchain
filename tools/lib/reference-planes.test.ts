import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ProjectFile } from './board-obstacles.ts';
import { segmentShape } from './copper-gap.ts';
import { CommandFailure } from './pcbtool-cli.ts';
import { groundSpec, layersError, mixedKinds, netDomain, pourRule, readPlanes, referenceObstacles } from './reference-planes.ts';

const project: ProjectFile = {
  net_settings: {
    classes: [{ name: 'Default', track_width: 0.2, clearance: 0.2, via_diameter: 0.6, via_drill: 0.3 }, { name: 'POWER', track_width: 0.8, clearance: 0.2, via_diameter: 0.6, via_drill: 0.3 }],
    netclass_patterns: [{ netclass: 'POWER', pattern: 'VIN' }],
  },
  board: { design_settings: { rules: { min_copper_edge_clearance: 0.5 } } },
};
const SPEC = {
  about: 'x', adjacent: { 'F.Cu': 'In1.Cu', 'B.Cu': 'In2.Cu' }, plane_layers: ['In1.Cu', 'In2.Cu'], grounds: ['GND'],
  mixed_layers: { 'In2.Cu': { allow: 'slow', fast_file: 'fast.json', power: ['VBUS'], reason: 'r' } },
};

function folder(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'planes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const write = (file: string, value: unknown): string => { writeFileSync(file, JSON.stringify(value)); return file; };

test('only a mixed layer of a slow net joins F.Cu and B.Cu', () => {
  const mixed = { 'In2.Cu': 'slow' } as const;
  assert.equal(layersError('/EN', ['F.Cu', 'In2.Cu', 'B.Cu'], mixed), null);
  assert.equal(layersError('/EN', ['F.Cu'], mixed), null);
  assert.match(layersError('/EN', ['F.Cu', 'In1.Cu'], mixed)!, /In1\.Cu/);
  for (const kind of ['fast', 'power'] as const) {
    const refused = layersError('/X', ['F.Cu', 'In2.Cu'], { 'In2.Cu': kind })!;
    assert.ok(refused.includes(kind) && refused.includes('slow nets only'));
  }
});

test('the kinds come from the planes spec and the POWER class', (t: TestContext) => {
  const dir = folder(t);
  const planes = join(dir, 'reference-planes.json');
  assert.deepEqual(mixedKinds('/EN', planes, project), {});   // no spec: no mixed layer
  write(planes, SPEC);
  assert.throws(() => mixedKinds('/EN', planes, project), error => error instanceof CommandFailure && /no fast net file/.test(error.message));   // fail closed
  write(join(dir, 'fast.json'), { fast: ['/USB_*'] });
  const kinds = Object.fromEntries(['/EN', '/USB_DP', 'VBUS', 'VIN', 'GND'].map(net => [net, mixedKinds(net, planes, project)['In2.Cu']]));
  assert.deepEqual(kinds, { '/EN': 'slow', '/USB_DP': 'fast', VBUS: 'power', VIN: 'power', GND: 'power' });
});

test('a bad spec stops the tool and names the file', (t: TestContext) => {
  const dir = folder(t);
  write(join(dir, 'fast.json'), { fast: ['/USB_*'] });
  const refused = (spec: unknown, message: RegExp): void => {
    const file = write(join(dir, 'p.json'), spec);
    assert.throws(() => readPlanes(file), error => error instanceof CommandFailure && error.message.startsWith(file) && message.test(error.message));
  };
  const mixed = SPEC.mixed_layers['In2.Cu'];
  refused([], /must be a JSON object/);
  refused({ ...SPEC, stray: 1 }, /unknown spec keys: \['stray'\]/);
  refused({ ...SPEC, grounds: [] }, /missing spec keys: \['grounds'\]/);
  refused({ ...SPEC, step_mm: 0 }, /step_mm must be a number > 0/);
  refused({ ...SPEC, plane_layers: ['In1.Cu'] }, /mixed_layers In2\.Cu: must be a plane layer/);
  refused({ ...SPEC, mixed_layers: { 'In2.Cu': { ...mixed, allow: 'all' } } }, /needs "allow": "slow"/);
  refused({ ...SPEC, mixed_layers: { 'In2.Cu': { ...mixed, power: 'VBUS' } } }, /"power" must be a list/);
  refused({ ...SPEC, mixed_layers: { 'In2.Cu': { ...mixed, reason: ' ' } } }, /a written reason is required/);
  refused({ ...SPEC, domains: { VCC: ['*'] } }, /domains VCC: key must be a ground/);
  refused({ ...SPEC, fast_file: 'no-such.json' }, /fast_file: no fast net file/);
  write(join(dir, 'fast.json'), { fast: [] });
  refused(SPEC, /"fast" must be a list of net patterns/);
});

test('a spec with no mixed layer reads with no fast file', (t: TestContext) => {
  const { mixed_layers: _unused, ...plain } = SPEC;
  assert.deepEqual(readPlanes(write(join(folder(t), 'p.json'), plain)).mixed_layers, {});
});

test('a net on the mixed layer keeps from fast tracks above it, a fast net from tracks under it', () => {
  const fast = [{ net: '/SCK', shape: segmentShape([0, 0], [10, 0], 0.1) }];
  const onMixed = [{ net: '/EN', shape: segmentShape([0, 5], [10, 5], 0.1) }, { net: '/SCK', shape: segmentShape([0, 9], [1, 9], 0.1) }];
  assert.deepEqual(referenceObstacles('/EN', 'slow', ['F.Cu', 'In2.Cu', 'B.Cu'], 'In2.Cu', 'B.Cu', fast, onMixed, 0.3),
    { 'In2.Cu': [{ shape: fast[0]!.shape, clearance: 0.3, label: 'fast ref B.Cu /SCK' }] });
  assert.deepEqual(referenceObstacles('/SCK', 'fast', ['F.Cu', 'B.Cu'], 'In2.Cu', 'B.Cu', fast, onMixed, 0.3),
    { 'B.Cu': [{ shape: onMixed[0]!.shape, clearance: 0.3, label: 'In2.Cu track /EN' }] });
  assert.deepEqual(referenceObstacles('/EN', 'slow', ['F.Cu', 'B.Cu'], 'In2.Cu', 'B.Cu', fast, onMixed, 0.3), {});
});

test('a pattern comes first, then the votes of the pads', () => {
  assert.equal(netDomain('/AI1', ['GND', 'GND'], ['GND', 'ISO_0V'], { ISO_0V: ['/AI*'] }), 'ISO_0V');
  assert.equal(netDomain('/X', ['GND', 'ISO_0V', 'ISO_0V', null], ['GND', 'ISO_0V'], {}), 'ISO_0V');
});

test('a ground is its own domain; one ground is the fallback and a tie of two is none', () => {
  assert.equal(netDomain('ISO_0V', ['GND'], ['GND', 'ISO_0V'], {}), 'ISO_0V');
  assert.equal(netDomain('/X', [null], ['GND'], {}), 'GND');
  assert.equal(netDomain('/X', ['GND', 'ISO_0V'], ['GND', 'ISO_0V'], {}), null);
});

test('only the pour of the own domain costs', () => {
  assert.equal(pourRule('ISO_0V', 'ISO_0V'), 'cost');
  assert.equal(pourRule('GND', 'ISO_0V'), 'block');
  assert.equal(pourRule('VCC', 'GND'), 'block');
  assert.equal(pourRule('GND', null), 'block');
});

test('the grounds come from the file, or are GND alone', (t: TestContext) => {
  const dir = folder(t);
  assert.deepEqual(groundSpec(join(dir, 'none.json')), { grounds: ['GND'], domains: {} });
  const file = write(join(dir, 'p.json'), { grounds: ['GND', 'ISO_0V'], domains: { ISO_0V: ['/AI*'] } });
  assert.deepEqual(groundSpec(file), { grounds: ['GND', 'ISO_0V'], domains: { ISO_0V: ['/AI*'] } });
});
