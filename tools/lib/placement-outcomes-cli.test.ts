import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceInputs } from '../placement_outcomes.ts';
import { sha256File } from './json-file.ts';

const cli = fileURLToPath(new URL('../placement_outcomes.ts', import.meta.url));
test('observer binds the exact implementation used by placement and thermal evidence', () => {
  const inputs = sourceInputs();
  for (const suffix of ['placement-outcomes.ts', 'outcome-thermal.ts', 'pcb-identity.ts', 'py-compat.mjs']) {
    const path = Object.keys(inputs).find(name => name.endsWith('/' + suffix));
    assert.ok(path, suffix);
    assert.equal(inputs[path], sha256File(path));
  }
});

test('invalid study is blocked and an output summary binds its saved bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'outcome-cli-'));
  try {
    const manifest = join(root, 'study.json'), output = join(root, 'report.json');
    writeFileSync(manifest, JSON.stringify({ schema: 'wrong' }));
    const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, 'evaluate', 'x', '--manifest', manifest, '--root', root, '--output', output, '--json'], { encoding: 'utf8' });
    assert.equal(run.status, 1, run.stderr);
    const summary = JSON.parse(run.stdout), report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(summary.status, 'blocked');
    assert.equal(summary.qualified, false);
    assert.equal(summary.report.sha256, sha256File(output));
    assert.equal(report.blockers[0].code, 'study_evidence_invalid');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
