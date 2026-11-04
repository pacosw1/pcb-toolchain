import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { pack } from '../pack-fab.ts';
import { openZip, readEntry } from './zip-read.mjs';

function gerbers(t: TestContext): { root: string; input: string } {
  const root = mkdtempSync(join(tmpdir(), 'pack-fab-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, 'gerber');
  mkdirSync(join(input, 'a/b'), { recursive: true });
  mkdirSync(join(input, 'a-b'));
  writeFileSync(join(input, 'a/b/one.gbr'), 'G04 test*\nM02*\n');
  writeFileSync(join(input, 'a-b/two.gbr'), 'second\n');
  return { root, input };
}

test('the archive is deterministic, sorted by path parts, and keeps the original bytes', t => {
  const { root, input } = gerbers(t);
  pack(input, join(root, 'one.zip'));
  pack(input, join(root, 'two.zip'));
  const archive = readFileSync(join(root, 'one.zip'));
  assert.deepEqual(archive, readFileSync(join(root, 'two.zip')));
  const zip = openZip(archive);
  assert.deepEqual(zip.entries.map(entry => entry.filename), ['a/b/one.gbr', 'a-b/two.gbr']);
  assert.equal(readEntry(zip, zip.entries[0]!).toString(), 'G04 test*\nM02*\n');
});

test('an existing archive is never replaced', t => {
  const { root, input } = gerbers(t);
  const destination = join(root, 'one.zip');
  pack(input, destination);
  const before = readFileSync(destination);
  assert.throws(() => pack(input, destination), /EEXIST/);
  assert.deepEqual(readFileSync(destination), before);
});

test('an empty folder and a symbolic link are refused', t => {
  const { root, input } = gerbers(t);
  mkdirSync(join(root, 'empty'));
  assert.throws(() => pack(join(root, 'empty'), join(root, 'x.zip')), /empty or contains symbolic links/);
  symlinkSync('/etc/hosts', join(input, 'link.gbr'));
  assert.throws(() => pack(input, join(root, 'y.zip')), /empty or contains symbolic links/);
});
