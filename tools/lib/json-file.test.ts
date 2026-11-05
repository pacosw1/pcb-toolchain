import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { atomicJson, readJson, sha256File } from './json-file.ts';

function folder(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'json-file-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('atomicJson writes Python text, makes the folder and leaves no temporary file', t => {
  const dir = folder(t);
  const file = join(dir, 'a/b/result.json');
  atomicJson(file, { name: 'Ω', list: [1, 2.5], empty: {} });
  assert.equal(readFileSync(file, 'utf8'), '{\n  "name": "\\u03a9",\n  "list": [\n    1,\n    2.5\n  ],\n  "empty": {}\n}\n');
  assert.deepEqual(readdirSync(join(dir, 'a/b')), ['result.json']);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readJson<{ name: string }>(file).name, 'Ω');
});

test('atomicJson refuses NaN and keeps the old file', t => {
  const file = join(folder(t), 'result.json');
  atomicJson(file, { ok: true });
  assert.throws(() => atomicJson(file, { nested: [{ value: Number.NaN }] }), RangeError);
  assert.deepEqual(readJson(file), { ok: true });
});

test('sha256File hashes the bytes', t => {
  const file = join(folder(t), 'data.bin');
  writeFileSync(file, 'hello');
  assert.equal(sha256File(file), createHash('sha256').update('hello').digest('hex'));
});
