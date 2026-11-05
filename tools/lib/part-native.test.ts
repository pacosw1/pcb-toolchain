// The hash input and path rules of the native reader. Whole boards are read in part-evidence.test.ts.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Float } from './py-compat.mjs';
import { digest, encoded, owned, properties, readBoard } from './part-native.ts';

test('encoded is compact sorted JSON that keeps non-ASCII text and number types', () => {
  const value = new Map<string, unknown>([['b', new Float(1)], ['a', [2n, 'µ']], ['10', true], ['2', null]]);
  assert.equal(encoded(value).toString(), '{"10":true,"2":null,"a":[2,"µ"],"b":1.0}');
  assert.equal(digest(encoded({})), '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
});

test('owned accepts only a file inside the root', (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), 'owned-'));
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  t.after(() => [root, outside].forEach(path => rmSync(path, { recursive: true, force: true })));
  mkdirSync(join(root, 'a'));
  writeFileSync(join(root, 'a/file'), 'x');
  writeFileSync(join(outside, 'file'), 'x');
  symlinkSync(join(outside, 'file'), join(root, 'a/link'));
  assert.ok(owned(root, 'a/file').endsWith('/a/file'));
  for (const name of ['/etc/passwd', 'a/../a/file', './a/file', 'a//file', 'a\\file', '', 7]) {
    assert.throws(() => owned(root, name), /expected repository-relative evidence path/);
  }
  assert.throws(() => owned(root, 'a/missing'), /missing evidence file: a\/missing/);
  assert.throws(() => owned(root, 'a/link'), /is not in the subpath of/);
});

test('properties refuse a duplicate', () => {
  assert.equal(properties(['footprint', ['property', 'Value', '1k']]).get('Value'), '1k');
  assert.throws(() => properties(['f', ['property', 'A', '1'], ['property', 'A', '2']]), /duplicate\/malformed native property/);
});

test('a board ID must be a configured name', () => {
  for (const board of ['lower', '../X', '', null]) assert.throws(() => readBoard('/tmp', board), /expected configured board ID/);
});
