import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { boardJson, cacheKey, jobArguments, pinnedKicadCommit, type BoardFetcher } from './board-json.ts';

const COMMIT = 'a'.repeat(40);

function project(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'board-json-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pcb = join(root, 'X.kicad_pcb');
  writeFileSync(pcb, '(kicad_pcb)');
  writeFileSync(join(root, 'X.kicad_pro'), '{}');
  writeFileSync(join(root, 'X.kicad_dru'), '(version 1)');
  return { root, pcb, cacheDir: join(root, 'cache') };
}

function counting(document: object = { schema_version: 1, nets: [] }) {
  const calls: string[][] = [];
  const fetcher: BoardFetcher = (input, file) => {
    calls.push(input.project);
    writeFileSync(file, JSON.stringify(document));
  };
  return { calls, fetcher };
}

test('an unchanged board is fetched once', t => {
  const { pcb, cacheDir } = project(t);
  const { calls, fetcher } = counting();
  const options = { cacheDir, kicadCommit: COMMIT, fetcher };
  assert.deepEqual(boardJson(pcb, options), { schema_version: 1, nets: [] });
  assert.deepEqual(boardJson(pcb, options), { schema_version: 1, nets: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.length, 2);
});

test('a change to the board, project, rules, schema or KiCad commit misses the cache', t => {
  const { root, pcb } = project(t);
  const key = (schema = 1, commit = COMMIT) => cacheKey(pcb, schema, commit);
  const keys = new Set([key()]);
  writeFileSync(pcb, '(kicad_pcb (version 2))');
  keys.add(key());
  writeFileSync(join(root, 'X.kicad_pro'), '{"net_settings":{}}');
  keys.add(key());
  writeFileSync(join(root, 'X.kicad_dru'), '(version 1)\n(rule a)');
  keys.add(key());
  keys.add(key(2));
  keys.add(key(1, 'b'.repeat(40)));
  assert.equal(keys.size, 6);
});

test('a board with no project still has a key, and adding a project changes it', t => {
  const root = mkdtempSync(join(tmpdir(), 'board-json-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pcb = join(root, 'Y.kicad_pcb');
  writeFileSync(pcb, '(kicad_pcb)');
  const bare = cacheKey(pcb, 1, COMMIT);
  writeFileSync(join(root, 'Y.kicad_pro'), '{}');
  assert.notEqual(cacheKey(pcb, 1, COMMIT), bare);
});

test('a wrong schema is refused and not kept', t => {
  const { pcb, cacheDir } = project(t);
  const { fetcher } = counting({ schema_version: 2 });
  assert.throws(() => boardJson(pcb, { cacheDir, kicadCommit: COMMIT, fetcher }), /schema 2, this tool reads 1/);
  assert.deepEqual(readdirSync(cacheDir), []);
});

test('a failed fetch leaves nothing in the cache', t => {
  const { pcb, cacheDir } = project(t);
  const fetcher: BoardFetcher = (_input, file) => {
    writeFileSync(file, '{"half');
    throw new Error('job failed');
  };
  assert.throws(() => boardJson(pcb, { cacheDir, kicadCommit: COMMIT, fetcher }), /job failed/);
  assert.deepEqual(readdirSync(cacheDir), []);
});

test('the job ships only the board files and the binary, and writes to out/', () => {
  const input = { pcb: '/a/X.kicad_pcb', project: ['/a/X.kicad_pro'], kicadCommit: COMMIT };
  const args = jobArguments(input, '/t/iotroute-linux-x86_64', 'img:1', '/r');
  assert.deepEqual(args.slice(0, 8), ['run', 'job', '--in', '/a/X.kicad_pcb', '--in', '/a/X.kicad_pro', '--in', '/t/iotroute-linux-x86_64']);
  assert.equal(args[args.indexOf('--image') + 1], 'img:1');
  assert.equal(args[args.indexOf('--results') + 1], '/r');
  assert.deepEqual(args.slice(args.indexOf('--') + 1, args.indexOf('--') + 3), ['sh', '-c']);
  assert.match(args.at(-3)!, /board-json "in\/\$1" > out\/board\.json$/);
  assert.equal(args.at(-1), 'X.kicad_pcb');
});

test('the pinned commit comes from the proto PIN', () => {
  assert.match(pinnedKicadCommit(), /^[0-9a-f]{40}$/);
});
