import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { boardJson, cacheKey, jobArguments, pinnedKicadCommit, type BoardFetcher } from './board-json.ts';

const COMMIT = 'a'.repeat(40);
const SCHEMA = 'iot-lab.board.v1';
const fileHash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

function project(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'board-json-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pcb = join(root, 'X.kicad_pcb');
  writeFileSync(pcb, '(kicad_pcb)');
  writeFileSync(join(root, 'X.kicad_pro'), '{}');
  writeFileSync(join(root, 'X.kicad_dru'), '(version 1)');
  return { root, pcb, cacheDir: join(root, 'cache') };
}

/** A fetcher that answers for whatever board it is given, with `over` on top. */
function counting(over: object = {}) {
  const calls: { pcb: string; project: string[] }[] = [];
  const fetcher: BoardFetcher = (input, file) => {
    calls.push(input);
    writeFileSync(file, JSON.stringify({ schema: SCHEMA, kicad_commit: COMMIT, board_sha256: fileHash(input.pcb), ...over }));
  };
  return { calls, fetcher };
}

test('an unchanged board is fetched once', t => {
  const { pcb, cacheDir } = project(t);
  const { calls, fetcher } = counting();
  const options = { cacheDir, kicadCommit: COMMIT, fetcher };
  assert.equal(boardJson(pcb, options).schema, SCHEMA);
  assert.equal(boardJson(pcb, options).schema, SCHEMA);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.project.length, 2);
});

test('a change to the board, project, rules, schema or KiCad commit misses the cache', t => {
  const { root, pcb } = project(t);
  const key = (schema = SCHEMA, commit = COMMIT) => cacheKey(pcb, schema, commit);
  const keys = new Set([key()]);
  writeFileSync(pcb, '(kicad_pcb (version 2))');
  keys.add(key());
  writeFileSync(join(root, 'X.kicad_pro'), '{"net_settings":{}}');
  keys.add(key());
  writeFileSync(join(root, 'X.kicad_dru'), '(version 1)\n(rule a)');
  keys.add(key());
  keys.add(key('iot-lab.board.v2'));
  keys.add(key(SCHEMA, 'b'.repeat(40)));
  keys.add(cacheKey(pcb, SCHEMA, COMMIT, true));
  assert.equal(keys.size, 7);
});

test('a board with no project still has a key, and adding a project changes it', t => {
  const root = mkdtempSync(join(tmpdir(), 'board-json-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pcb = join(root, 'Y.kicad_pcb');
  writeFileSync(pcb, '(kicad_pcb)');
  const bare = cacheKey(pcb, SCHEMA, COMMIT);
  writeFileSync(join(root, 'Y.kicad_pro'), '{}');
  assert.notEqual(cacheKey(pcb, SCHEMA, COMMIT), bare);
});

test('a wrong schema, KiCad commit or board hash is refused and not kept', t => {
  const { pcb, cacheDir } = project(t);
  const refused = (over: object, message: RegExp) => {
    assert.throws(() => boardJson(pcb, { cacheDir, kicadCommit: COMMIT, fetcher: counting(over).fetcher }), message);
    assert.deepEqual(readdirSync(cacheDir), []);
  };
  refused({ schema: 'iot-lab.board.v2' }, /schema iot-lab\.board\.v2, this tool reads/);
  refused({ kicad_commit: 'b'.repeat(40) }, /not the pinned/);
  refused({ board_sha256: 'c'.repeat(64) }, /of another file/);
});

test('refill reads a refilled copy, under its own key, and the source stays as it was', t => {
  const { root, pcb, cacheDir } = project(t);
  const { calls, fetcher } = counting();
  const refiller = (source: string, outDir: string) => {
    const copy = join(outDir, 'X.kicad_pcb');
    copyFileSync(source, copy);
    writeFileSync(copy, '(kicad_pcb (zone (filled)))');
    copyFileSync(join(root, 'X.kicad_pro'), join(outDir, 'X.kicad_pro'));
    return copy;
  };
  const before = readFileSync(pcb, 'utf8');
  const options = { cacheDir, kicadCommit: COMMIT, fetcher, refill: true, refiller };
  boardJson(pcb, options);
  boardJson(pcb, options);
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0]!.pcb, pcb);
  assert.equal(readFileSync(pcb, 'utf8'), before);
  boardJson(pcb, { cacheDir, kicadCommit: COMMIT, fetcher });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.pcb, pcb);
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
