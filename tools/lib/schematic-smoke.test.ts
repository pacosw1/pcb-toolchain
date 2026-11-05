// The report of the native proof. The proof itself needs kicad-cli: it runs in iot-lab's native job.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { writeJunit, type SmokeResult } from './schematic-smoke.ts';
import { iter, parseXml } from './xml-read.mjs';

const result = (cases: SmokeResult['cases']): SmokeResult => ({
  schema: 'x', export_only: true, status: 'failed', qualified: false, scope: 'native export only', cases, cause: 'missing <native> "exporter"', elapsed_s: 0.1,
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
