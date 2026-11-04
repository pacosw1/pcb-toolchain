import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, afterEach, test } from 'node:test';
import { coreSources, iotrouteBin, iotrouteMissing, sourcesSha } from './iotroute-bin.ts';

const root = mkdtempSync(join(tmpdir(), 'iotroute-bin-'));
const saved = { bin: process.env.IOTROUTE_BIN, cache: process.env.IOTROUTE_CACHE };
after(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  for (const [key, value] of [['IOTROUTE_BIN', saved.bin], ['IOTROUTE_CACHE', saved.cache]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function core(name: string): string {
  const folder = join(root, name);
  mkdirSync(join(folder, 'src/b'), { recursive: true });
  mkdirSync(join(folder, 'src/a'), { recursive: true });
  for (const file of ['Cargo.toml', 'src/z.rs', 'src/m.rs', 'src/b/y.rs', 'src/a/x.rs']) writeFileSync(join(folder, file), file);
  return folder;
}

test('sources keep the os.walk order of run.py: a folder\'s files, then its sorted folders', () => {
  const folder = core('order');
  assert.deepEqual(coreSources(folder).map(file => relative(folder, file)), ['Cargo.toml', 'src/m.rs', 'src/z.rs', 'src/a/x.rs', 'src/b/y.rs']);
});

test('the sha is the value of run.py sources_sha on the same tree', () => {
  // run.sources_sha printed this for the same tree, in the route image.
  assert.equal(sourcesSha(core('sha')), 'c9369a2eec15ecf751ee5b77bc66167ed2ca854f7d96be66472a24d48652dd4c');
});

test('IOTROUTE_BIN wins and must be an executable file', () => {
  const exe = join(root, 'exe');
  writeFileSync(exe, '#!/bin/sh\n');
  chmodSync(exe, 0o755);
  process.env.IOTROUTE_BIN = exe;
  assert.equal(iotrouteBin(join(root, 'no-core')), exe);
  chmodSync(exe, 0o644);
  assert.throws(() => iotrouteBin(), /not an executable file/);
  process.env.IOTROUTE_BIN = root;
  assert.throws(() => iotrouteBin(), /not an executable file/);
});

test('a stamped cache folder is used without a build', () => {
  delete process.env.IOTROUTE_BIN;
  const folder = core('cached');
  process.env.IOTROUTE_CACHE = join(root, 'cache');
  const sha = sourcesSha(folder);
  const exe = join(root, 'cache', sha, 'release', 'iotroute');
  mkdirSync(join(root, 'cache', sha, 'release'), { recursive: true });
  writeFileSync(exe, '');
  writeFileSync(join(root, 'cache', sha, 'sources.sha256'), `${sha}\n`);
  assert.equal(iotrouteBin(folder), exe);
});

test('only a host with no binary and no cargo skips; a wrong IOTROUTE_BIN does not', () => {
  const path = process.env.PATH;
  process.env.IOTROUTE_CACHE = join(root, 'empty-cache');
  process.env.PATH = join(root, 'no-tools');
  try {
    delete process.env.IOTROUTE_BIN;
    assert.match(String(iotrouteMissing()), /no IOTROUTE_BIN, no cached build, no cargo/);
    process.env.IOTROUTE_BIN = join(root, 'not-there');
    assert.equal(iotrouteMissing(), false);
  } finally {
    process.env.PATH = path;
  }
});

test('a core without sources fails clearly', () => {
  delete process.env.IOTROUTE_BIN;
  const empty = join(root, 'empty');
  mkdirSync(empty);
  assert.throws(() => iotrouteBin(empty), /no router core sources/);
});
