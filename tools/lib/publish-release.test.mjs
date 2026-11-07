// tools/publish-release.mjs: claim the destination with mkdir, then rename the stage over the empty claim.
// Run: node --test tools/lib/publish-release.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, symlinkSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';

const tool = new URL('../publish-release.mjs', import.meta.url).pathname;
const publish = (...args) => spawnSync(process.execPath, [tool, ...args], {encoding: 'utf8'});
const started = (args, hook = []) => new Promise(done => {
  const child = spawn(process.execPath, [...hook, tool, ...args], {stdio: ['ignore', 'ignore', 'pipe']});
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  child.on('close', (status, signal) => done({status, signal, stderr}));
});
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'publish-release-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const stage = name => {
    const path = join(root, name);
    mkdirSync(join(path, 'gate'), {recursive: true});
    writeFileSync(join(path, 'gate/result.json'), name);
    writeFileSync(join(path, 'release-manifest.json'), name);
    return path;
  };
  return {root, stage, destination: join(root, 'candidate')};
}
// Node arguments that wrap fs.renameSync: `before` runs just before the rename, the moment between the two steps.
function hooked(root, before) {
  const file = join(root, 'hook.mjs');
  writeFileSync(file, `import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const rename = fs.renameSync;
fs.renameSync = (a, b) => { ${before}; return rename(a, b); };
syncBuiltinESMExports();
`);
  return ['--import', file];
}
const until = async ready => { for (let i = 0; i < 2000 && !ready(); i++) await wait(5); assert.ok(ready(), 'timed out'); };

test('a stale empty destination left by a crash is reclaimed', t => {
  const f = fixture(t), stage = f.stage('one');
  mkdirSync(f.destination);
  const old = new Date(Date.now() - 60_000);
  utimesSync(f.destination, old, old);
  const r = publish(stage, f.destination);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(f.destination, 'release-manifest.json'), 'utf8'), 'one');
});

test('publishing moves the whole stage and keeps its mode', t => {
  const f = fixture(t), stage = f.stage('one'), mode = statSync(stage).mode;
  const r = publish(stage, f.destination);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout + r.stderr, '');
  assert.equal(existsSync(stage), false);
  assert.equal(readFileSync(join(f.destination, 'gate/result.json'), 'utf8'), 'one');
  assert.equal(statSync(f.destination).mode, mode);
});

test('every kind of existing destination is refused and left as it was', t => {
  const f = fixture(t), stage = f.stage('one');
  const empty = join(f.root, 'empty'), full = join(f.root, 'full'), file = join(f.root, 'file'), link = join(f.root, 'link');
  mkdirSync(empty); mkdirSync(full); writeFileSync(join(full, 'keep'), 'keep'); writeFileSync(file, 'keep'); symlinkSync(join(f.root, 'nowhere'), link);
  for (const destination of [empty, full, file, link]) {
    const r = publish(stage, destination);
    assert.equal(r.status, 1);
    assert.equal(r.stderr, `FAIL: release publication: [Errno 17] File exists: '${destination}'\n`);
    assert.equal(readFileSync(join(stage, 'gate/result.json'), 'utf8'), 'one');
  }
  assert.deepEqual(readdirSync(empty), []);
  assert.deepEqual(readdirSync(full), ['keep']);
  assert.equal(readFileSync(file, 'utf8'), 'keep');
  assert.ok(lstatSync(link).isSymbolicLink());
});

test('a failure leaves no claim behind', t => {
  const f = fixture(t), stage = f.stage('one'), missing = join(f.root, 'missing');
  const gone = publish(missing, f.destination);
  assert.equal(gone.status, 1);
  assert.equal(gone.stderr, `FAIL: release publication: [Errno 2] No such file or directory: '${f.destination}'\n`);
  assert.equal(existsSync(f.destination), false);
  const inside = join(stage, 'inside'), nested = publish(stage, inside);   // the rename fails after the claim
  assert.equal(nested.status, 1);
  assert.equal(nested.stderr, `FAIL: release publication: [Errno 22] Invalid argument: '${inside}'\n`);
  assert.equal(existsSync(inside), false);
  assert.equal(existsSync(join(stage, 'gate/result.json')), true);
  const parent = join(missing, 'candidate'), noParent = publish(stage, parent);
  assert.equal(noParent.status, 1);
  assert.equal(noParent.stderr, `FAIL: release publication: [Errno 2] No such file or directory: '${parent}'\n`);
});

test('a stage that is not a real directory is refused before any claim', t => {
  const f = fixture(t), file = join(f.root, 'file'), link = join(f.root, 'link');
  writeFileSync(file, 'x'); symlinkSync(f.stage('one'), link);
  for (const source of [file, link]) {
    const r = publish(source, f.destination);
    assert.equal(r.status, 1);
    assert.equal(r.stderr, `FAIL: release publication: [Errno 20] Not a directory: '${source}'\n`);
    assert.equal(existsSync(f.destination), false);
  }
});

test('wrong arguments fail with the old messages', () => {
  assert.equal(publish().stderr, "FAIL: release publication: publish() missing 2 required positional arguments: 'source' and 'destination'\n");
  const r = publish('one');
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "FAIL: release publication: publish() missing 1 required positional argument: 'destination'\n");
});

test('a publisher that arrives inside the gap loses at mkdir, and a reader there sees only an empty directory', async t => {
  const f = fixture(t), first = f.stage('first'), second = f.stage('second');
  const claimed = join(f.root, 'claimed'), go = join(f.root, 'go');
  const before = `fs.writeFileSync(${JSON.stringify(claimed)}, ''); while (!fs.existsSync(${JSON.stringify(go)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)`;
  const running = started([first, f.destination], hooked(f.root, before));
  await until(() => existsSync(claimed));
  assert.deepEqual(readdirSync(f.destination), []);
  const loser = publish(second, f.destination);
  assert.equal(loser.status, 1);
  assert.match(loser.stderr, /File exists/);
  assert.equal(existsSync(join(second, 'release-manifest.json')), true);
  writeFileSync(go, '');
  const winner = await running;
  assert.equal(winner.status, 0, winner.stderr);
  assert.equal(readFileSync(join(f.destination, 'release-manifest.json'), 'utf8'), 'first');
});

test('a crash inside the gap loses nothing, blocks publishing, and rmdir recovers', async t => {
  const f = fixture(t), stage = f.stage('one');
  const crashed = await started([stage, f.destination], hooked(f.root, "process.kill(process.pid, 'SIGKILL')"));
  assert.equal(crashed.signal, 'SIGKILL');
  assert.deepEqual(readdirSync(f.destination), []);
  assert.equal(readFileSync(join(stage, 'gate/result.json'), 'utf8'), 'one');
  assert.equal(publish(stage, f.destination).status, 1);
  rmdirSync(f.destination);
  assert.equal(publish(stage, f.destination).status, 0);
  assert.equal(readFileSync(join(f.destination, 'gate/result.json'), 'utf8'), 'one');
});

test('the rename cannot replace a published candidate, even if someone removed the claim in the gap', async t => {
  const f = fixture(t), stage = f.stage('late'), other = f.stage('other');
  const before = `fs.rmdirSync(${JSON.stringify(f.destination)}); rename(${JSON.stringify(other)}, ${JSON.stringify(f.destination)})`;
  const r = await started([stage, f.destination], hooked(f.root, before));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Directory not empty|File exists/);
  assert.equal(readFileSync(join(f.destination, 'release-manifest.json'), 'utf8'), 'other');
  assert.equal(readFileSync(join(stage, 'release-manifest.json'), 'utf8'), 'late');
});

test('of racing publishers exactly one wins, and a reader sees nothing, an empty directory or the whole candidate', async t => {
  const f = fixture(t), rounds = 25, racers = 8;
  for (let round = 0; round < rounds; round++) {
    const destination = join(f.root, 'candidate-' + round), stages = Array.from({length: racers}, (_, i) => f.stage(`r${round}-${i}`));
    let reading = true;
    const reader = (async () => {
      while (reading) {
        let names = [];
        try { names = readdirSync(destination); } catch (e) { assert.equal(e.code, 'ENOENT'); }
        if (names.length) assert.deepEqual(names.sort(), ['gate', 'release-manifest.json']);
        await wait(0);
      }
    })();
    const results = await Promise.all(stages.map(stage => started([stage, destination])));
    reading = false;
    await reader;
    const winners = results.flatMap((r, i) => r.status === 0 ? [i] : []);
    assert.equal(winners.length, 1, JSON.stringify(results));
    for (const r of results) if (r.status !== 0) assert.match(r.stderr, /^FAIL: release publication: \[Errno 17\] File exists: /);
    const name = `r${round}-${winners[0]}`;
    assert.equal(readFileSync(join(destination, 'release-manifest.json'), 'utf8'), name);
    assert.equal(readFileSync(join(destination, 'gate/result.json'), 'utf8'), name);
    stages.forEach((stage, i) => assert.equal(existsSync(stage), i !== winners[0]));
  }
});
