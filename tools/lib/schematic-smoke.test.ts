// The report of the native proof. The proof itself needs kicad-cli: it runs in iot-lab's native job.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { exportObservation, writeJunit, type SmokeResult } from './schematic-smoke.ts';
import { parseExport } from './schematic-contract.ts';
import { iter, parseXml } from './xml-read.mjs';

const result = (cases: SmokeResult['cases']): SmokeResult => ({
  schema: 'x', export_only: true, status: 'failed', qualified: false, scope: 'native export only', cases, cause: 'missing <native> "exporter"', elapsed_s: 0.1,
});

test('export observation reports native data without claiming a complete contract verdict', async (t: TestContext) => {
  const folder = mkdtempSync(join(tmpdir(), 'schematic-observe-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const xml = '<export><components><comp ref="J1"><value>1uF</value><fields><field name="Operating_Mode">low</field></fields></comp><comp ref="J3"><value>1uF</value></comp></components><nets><net name="/A"><node ref="J1" pin="1" pinfunction="P"/></net><net name="/B"><node ref="J3" pin="1" pinfunction="P"/></net></nets></export>';
  const report = await exportObservation('input.kicad_sch', folder, async () => ({ parsed: parseExport(xml), evidence: {}, tools: {} }));
  assert.equal(report.status, 'observed');
  assert.equal(report.qualified, false);
  assert.equal(report.actual_nominal.value, '0.000001');
  assert.match(report.scope, /no reviewed-part or functional-contract verdict/);
});

test('JUnit never hides unexecuted or integrity-failed cases', (t: TestContext) => {
  const folder = mkdtempSync(join(tmpdir(), 'junit-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const suite = () => parseXml(readFileSync(join(folder, 'junit.xml'), 'utf8'));
  writeJunit(folder, result([]));
  assert.equal(suite().attributes.get('failures'), '2');
  assert.equal(suite().attributes.get('skipped'), '0');
  assert.equal([...iter(suite(), 'failure')][0]?.attributes.get('message'), 'missing <native> "exporter"');
  assert.match(readFileSync(join(folder, 'junit.xml'), 'utf8'), /^<\?xml version='1\.0' encoding='utf-8'\?>\n<testsuite /);
  writeJunit(folder, result(['actual_native_export_is_parsed', 'actual_wrong_native_value_is_detected'].map(name => ({ case: name, status: 'passed' }))));
  assert.equal(suite().attributes.get('failures'), '1');
  assert.equal([...iter(suite(), 'testcase')].length, 2);
});
