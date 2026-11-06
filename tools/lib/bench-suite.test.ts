import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { expandTrials, SUITE, validateSuite, verifyInputs } from './bench-suite.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const suite = (patch: Record<string, unknown> = {}) => ({
  schema: SUITE, suite_id: 's1',
  arms: [{ id: 'base', argv: ['tools/pcb', 'route', '{board}', '--seed', '{seed}', '--timeout', '{timeout_s}'] }, { id: 'new', argv: ['tools/pcb', 'route', '{board}', '--seed', '{seed}'] }],
  boards: [
    { family: 'A', board: 'ENV', split: 'development', input: { path: 'env.kicad_pcb', sha256: sha('env') } },
    { family: 'B', board: 'REL', split: 'holdout', input: { path: 'rel.kicad_pcb', sha256: sha('rel') } },
  ],
  seeds: [1, 2, 3], budget: { timeout_s: 60, cpus: 2, memory_gb: 4 }, ...patch,
});

test('a valid suite expands to boards x seeds x arms with shared seeds and substituted argv', () => {
  const trials = expandTrials(validateSuite(suite()));
  assert.equal(trials.length, 12);
  assert.deepEqual(trials.slice(0, 2).map(t => [t.arm, t.seed, t.replicate]), [['base', 1, 1], ['new', 1, 1]]);
  assert.deepEqual(trials[0]!.argv, ['tools/pcb', 'route', 'ENV', '--seed', '1', '--timeout', '60']);
  assert.equal(new Set(trials.map(t => t.id)).size, 12);
});

test('bad suites are refused by name', () => {
  assert.throws(() => validateSuite(suite({ seeds: [1] })), /at least two/);
  assert.throws(() => validateSuite(suite({ seeds: [1, 1] })), /distinct/);
  assert.throws(() => validateSuite(suite({ arms: [suite().arms[0]] })), /two arms/);
  assert.throws(() => validateSuite(suite({ arms: [{ id: 'x', argv: ['a'] }, { id: 'x', argv: ['a'] }] })), /differ/);
  assert.throws(() => validateSuite(suite({ arms: [{ id: 'a', argv: ['{nope}'] }, { id: 'b', argv: ['x'] }] })), /unknown placeholder/);
  assert.throws(() => validateSuite(suite({ boards: [suite().boards[0]] })), /holdout/);
  const same = suite().boards.map(b => ({ ...b, family: 'A' }));
  assert.throws(() => validateSuite(suite({ boards: same })), /both splits/);
  assert.throws(() => validateSuite(suite({ budget: { timeout_s: 0, cpus: 1, memory_gb: 1 } })), /budget/);
  assert.throws(() => validateSuite({ schema: 'x' }), /schema/);
});

test('input hashes are verified against the files', () => {
  const root = mkdtempSync(join(tmpdir(), 'bench-suite-'));
  try {
    const value = validateSuite(suite());
    writeFileSync(join(root, 'env.kicad_pcb'), 'env');
    writeFileSync(join(root, 'rel.kicad_pcb'), 'rel');
    verifyInputs(value, root);
    writeFileSync(join(root, 'rel.kicad_pcb'), 'changed');
    assert.throws(() => verifyInputs(value, root), /differs from its pinned/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('steps keep runtime placeholders for the executor and are validated', () => {
  const steps = [['placer', '--seed', '{seed}', '--out', '{work}/p.json'], ['tools/pcb', 'route', '{board}', '--from-run', '{prev_run}']];
  const planned = expandTrials(validateSuite(suite({ arms: [{ id: 'base', argv: ['x', '{board}'] }, { id: 'new', steps }] })));
  const chained = planned.find(t => t.arm === 'new')!;
  assert.deepEqual(chained.steps[0], ['placer', '--seed', '1', '--out', '{work}/p.json']);
  assert.deepEqual(chained.argv, ['tools/pcb', 'route', 'ENV', '--from-run', '{prev_run}']);
  assert.deepEqual(planned[0]!.steps, [['x', 'ENV']]);
  const arms = (arm: Record<string, unknown>) => suite({ arms: [{ id: 'base', argv: ['x'] }, { id: 'new', ...arm }] });
  assert.throws(() => validateSuite(arms({ argv: ['x'], steps: [['y']] })), /either argv or steps/);
  assert.throws(() => validateSuite(arms({ steps: [['y', '{prev_run}']] })), /needs an earlier step/);
  assert.throws(() => validateSuite(arms({ argv: ['y', '{prev_run}'] })), /unknown placeholder/);
  assert.throws(() => validateSuite(arms({ steps: [] })), /nonempty/);
});
