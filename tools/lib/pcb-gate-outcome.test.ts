import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gateOutcome } from './pcb-gate-outcome.ts';

test('gate verdict requires a matching terminal event, exit and source evidence', t => {
  const folder = mkdtempSync(join(tmpdir(), 'pcb-gate-outcome-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  mkdirSync(join(folder, 'gate'));
  const report: Record<string, unknown> = { exit: 0, changedDuringRun: false, metrics: { erc_errors: 0 },
    provenance: { input_sha256: 'a'.repeat(64), tools: { kicad: '10' } }, checks: { erc: { status: 'passed', metrics: { erc_errors: 0 } } } };
  const save = () => writeFileSync(join(folder, 'gate/result.json'), JSON.stringify(report));
  save();
  assert.equal(gateOutcome(folder, 0, true, []).status, 'passed');
  assert.throws(() => gateOutcome(folder, 0, false, []), /terminal evidence disagree/);
  assert.throws(() => gateOutcome(folder, 1, true, []), /terminal evidence disagree/);
  report.changedDuringRun = true; save();
  assert.equal(gateOutcome(folder, 0, true, []).status, 'error');
  report.changedDuringRun = 'false'; save();
  assert.throws(() => gateOutcome(folder, 0, true, []), /invalid gate result/);
  report.changedDuringRun = false; report.checks = { erc: { status: 'failed', metrics: { erc_errors: 1 } } }; save();
  assert.throws(() => gateOutcome(folder, 0, true, []), /terminal evidence disagree/);
});

test('missing prerequisites do not become success, while attributable dependent blocks remain failures', t => {
  const folder = mkdtempSync(join(tmpdir(), 'pcb-gate-outcome-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  mkdirSync(join(folder, 'gate'));
  const report: Record<string, unknown> = { exit: 1, changedDuringRun: false, metrics: { erc_errors: 1, drc_errors: null },
    provenance: { input_sha256: 'b'.repeat(64), tools: { kicad: '10' } }, checks: {
      erc: { status: 'failed', metrics: { erc_errors: 1 } }, drc: { status: 'blocked', metrics: { drc_errors: null } },
    }, preflightErrors: [] };
  const save = () => writeFileSync(join(folder, 'gate/result.json'), JSON.stringify(report));
  save();
  assert.equal(gateOutcome(folder, 1, true, []).cause, 'native findings block dependent checks');
  report.preflightErrors = ['missing input']; save();
  assert.match(gateOutcome(folder, 1, true, []).cause, /required checker did not complete/);
  report.preflightErrors = []; report.metrics = { erc_errors: 1 }; report.provenance = { input_sha256: 'b'.repeat(64), tools: { kicad: null } }; save();
  assert.match(gateOutcome(folder, 1, true, []).cause, /required tool version unavailable/);
});
