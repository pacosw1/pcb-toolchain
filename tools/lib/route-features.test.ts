import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { netsToStitch, stitchResult } from '../stitch_all.ts';
import { boardDir, featureOn, haloFile, learnedHalo, loadFeatures, sourceFingerprint } from './route-features.ts';

function project(t: TestContext): { root: string; pcb: string; folder: string } {
  const root = mkdtempSync(join(tmpdir(), 'features-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, 'hardware-design', 'boards', 'B');
  mkdirSync(join(folder, 'cad', 'B'), { recursive: true });
  mkdirSync(join(root, 'tools'));
  writeFileSync(join(root, 'tools', 'route-features.json'), JSON.stringify({ features: { via_halo: { on: false, size_mm: 1.8 }, fail_fast: { on: true }, triage_opens: {}, rule_compiler: {}, via_off_small_pads: {}, pin_escape_check: {}, routing_rules: {} } }));
  writeFileSync(join(folder, 'gate.json'), JSON.stringify({ route_features: { via_halo: { on: true, learn_noroom: true } } }));
  const pcb = join(folder, 'cad', 'B', 'B.kicad_pcb');
  writeFileSync(pcb, 'board');
  writeFileSync(join(folder, 'cad', 'B', 'B.kicad_pro'), '{}');
  return { root, pcb, folder };
}

test('the board comes from ROUTE_BOARD, the file name, or a gate.json above the file', (t: TestContext) => {
  const { root, pcb, folder } = project(t);
  assert.equal(boardDir(pcb, root, {}), folder);
  assert.equal(boardDir('/elsewhere/B.kicad_pcb', root, {}), folder);
  assert.equal(boardDir('/elsewhere/X.kicad_pcb', root, {}), null);
  assert.equal(boardDir('/elsewhere/X.kicad_pcb', root, { ROUTE_BOARD: 'B' }), folder);
  assert.equal(boardDir(pcb, root, { ROUTE_BOARD: 'NONE' }), null);
});

test('gate.json merges per feature and the environment comes last', (t: TestContext) => {
  const { root, pcb } = project(t);
  const { features } = loadFeatures(pcb, root, {});
  assert.deepEqual(features.via_halo, { on: true, size_mm: 1.8, learn_noroom: true });
  assert.equal(featureOn(loadFeatures(pcb, root, { ROUTE_FEATURES: 'via_halo=0' }).features, 'via_halo'), false);
  const some = loadFeatures(pcb, root, { ROUTE_FEATURES: 'all=0,via_halo=1' }).features;
  assert.deepEqual([featureOn(some, 'via_halo'), featureOn(some, 'fail_fast')], [true, false]);
});

test('learned halo nets count only for the CAD they were learned on', (t: TestContext) => {
  const { pcb, folder } = project(t);
  const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
  assert.deepEqual(sourceFingerprint(pcb), { '.kicad_pcb': sha('board'), '.kicad_pro': sha('{}') });
  assert.deepEqual(learnedHalo(pcb, folder), []);
  mkdirSync(join(folder, '.gate'));
  writeFileSync(haloFile(folder), JSON.stringify({ nets: ['/A'], source_fingerprint: sourceFingerprint(pcb) }));
  assert.deepEqual(learnedHalo(pcb, folder), ['/A']);
  writeFileSync(pcb, 'changed');
  assert.deepEqual(learnedHalo(pcb, folder), []);
  writeFileSync(haloFile(folder), JSON.stringify({ nets: ['/A'] }));
  assert.deepEqual(learnedHalo(pcb, folder), []);
});

test('a stitch line gives the vias added and the vias with no room', () => {
  assert.deepEqual(stitchResult('/A: added 3 GND vias 0.6/0.3 (1.000, 2.000)\n'), { added: 3, noRoom: 0 });
  const line = '/A: no room for a GND via within 1 mm of (1.000, 2.000), (3.000, 4.000); best effort: the others are placed\n/A: added 0 GND vias 0.6/0.3\n';
  assert.deepEqual(stitchResult(line), { added: 0, noRoom: 2 });
  assert.deepEqual(stitchResult('error\n'), { added: 0, noRoom: 0 });
});

test('grounds, skipped nets and the empty net are not stitched', () => {
  assert.deepEqual(netsToStitch(['/B', 'GND', '/A', '', '+3V3', '/A'], ['GND'], '+3V3'), ['/A', '/B']);
});
