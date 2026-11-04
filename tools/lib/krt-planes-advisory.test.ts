import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { jsonLoads } from './py-compat.mjs';
import { formatCrossing, voidCrossings } from '../krt_planes_advisory.ts';

const TOOL = fileURLToPath(new URL('../krt_planes_advisory.ts', import.meta.url));
const sample = () => jsonLoads(readFileSync(new URL('../fixtures/krt_impedance_sample.json', import.meta.url)));
const crossingOf = (x: string) => voidCrossings(jsonLoads(`{"nets": [{"net_name": "N", "crossing_detail": [
  {"kind": "void", "layer": "F.Cu", "ref_layer": "In1.Cu", "x": ${x}, "y": 116.3685, "length_mm": 1.0285}]}]}`))[0]!;

test('keeps only void crossings at or above the threshold', () => {
  const crossings = voidCrossings(sample(), 1);
  assert.deepEqual(crossings.map(c => [c.net, c.lengthMm]), [['SLOT_5V', 1.0285]]);
});

test('a split crossing never counts, even when long', () => {
  assert.ok(!voidCrossings(sample(), 1).some(c => c.net === 'CHG_5V'));
});

test('the threshold can be lowered', () => {
  assert.equal(voidCrossings(sample(), 0.5).length, 2);
});

test('a report with no nets has no crossings', () => {
  assert.deepEqual(voidCrossings(jsonLoads('{"nets": []}')), []);
  assert.deepEqual(voidCrossings(jsonLoads('{}')), []);
});

test('a crossing line has the net, length and place', () => {
  assert.equal(formatCrossing(crossingOf('143.54')), 'N: 1.028 mm void at (143.54, 116.3685) F.Cu / In1.Cu');
});

test('a whole coordinate prints as the report wrote it', () => {
  assert.match(formatCrossing(crossingOf('137.0')), /\(137\.0, /);
  assert.match(formatCrossing(crossingOf('137')), /\(137, /);
});

test('a missing clone is a tool error', () => {
  const empty = mkdtempSync(join(tmpdir(), 'krt-test-'));
  try {
    const run = spawnSync(process.execPath, ['--no-warnings', TOOL, 'x.kicad_pcb'],
      { encoding: 'utf8', env: { ...process.env, KRT_DIR: join(empty, 'none') } });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /^ERROR: KiCadRoutingTools clone not found at /);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('no board is a usage error', () => {
  const run = spawnSync(process.execPath, ['--no-warnings', TOOL], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^usage: /);
});
