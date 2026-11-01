import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {poolSize, runPool, ProcessGroups, BOARD_PEAK_BYTES} from './gate-pool.mjs';

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('pool never runs more than the limit and returns results in item order', async () => {
  let running = 0, peak = 0;
  const items = [50, 10, 40, 5, 30, 20, 1];
  const results = await runPool(items, 3, async (ms, index) => {
    running++; peak = Math.max(peak, running);
    await sleep(ms); running--;
    return {ok: true, index};
  });
  assert.equal(peak, 3);
  assert.deepEqual(results.map(r => r.item), items);
  assert.deepEqual(results.map(r => r.value.index), items.map((_, i) => i));
  assert.ok(results.every(r => r.status === 'ok'));
});

test('after a failure no new item starts, items in progress finish, the rest are skipped', async () => {
  const started = [];
  const results = await runPool(['a', 'b', 'c', 'd', 'e'], 2, async item => {
    started.push(item);
    if (item === 'a') { await sleep(5); return {ok: false, why: 'exit 1'}; }
    if (item === 'b') { await sleep(40); return {ok: true}; }
    return {ok: true};
  });
  assert.deepEqual(started, ['a', 'b']);
  assert.deepEqual(results.map(r => r.status), ['failed', 'ok', 'skipped', 'skipped', 'skipped']);
  const thrown = await runPool([1, 2], 1, async n => { if (n === 1) throw new Error('boom'); return {ok: true}; });
  assert.equal(thrown[0].status, 'failed'); assert.equal(thrown[0].error.message, 'boom'); assert.equal(thrown[1].status, 'skipped');
  let stop = false;
  const stopped = await runPool([1, 2, 3], 1, async n => { stop = n === 1; return {ok: true}; }, {shouldStop: () => stop});
  assert.deepEqual(stopped.map(r => r.status), ['ok', 'skipped', 'skipped']);
  await assert.rejects(runPool([1], 0, async () => ({ok: true})), /positive integer/);
});

test('pool size: cores / 2, available memory / board peak, board count; env override', () => {
  const gb = 1024 ** 3;
  assert.equal(poolSize({boards: 20, cpus: 15, availableBytes: 64 * gb}).jobs, 7);
  assert.equal(poolSize({boards: 20, cpus: 15, availableBytes: 9.4 * gb}).jobs, Math.floor(9.4 * gb / BOARD_PEAK_BYTES));
  assert.equal(poolSize({boards: 3, cpus: 15, availableBytes: 64 * gb}).jobs, 3);
  assert.equal(poolSize({boards: 20, cpus: 15, availableBytes: 0.5 * gb}).jobs, 1);
  assert.equal(poolSize({boards: 20, cpus: 1, availableBytes: 64 * gb}).jobs, 1);
  assert.equal(poolSize({boards: 20, cpus: 15, availableBytes: 0, override: '12'}).jobs, 12);
  assert.equal(poolSize({boards: 2, cpus: 15, availableBytes: 0, override: '12'}).jobs, 2);
  assert.throws(() => poolSize({boards: 2, cpus: 15, availableBytes: 0, override: '0'}), /IOT_LAB_GATE_JOBS/);
  assert.throws(() => poolSize({boards: 2, cpus: 15, availableBytes: 0, override: 'many'}), /IOT_LAB_GATE_JOBS/);
});

const forkChild = "const {spawn}=require('node:child_process');const c=spawn('sleep',['30'],{stdio:'ignore'});c.unref();console.log(c.pid);";

test('a grandchild left behind after the gate process exits is killed and reported', async () => {
  const groups = new ProcessGroups();
  const run = await groups.run(process.execPath, ['-e', forkChild]);
  const pid = Number(run.output.trim());
  assert.ok(pid > 0); assert.equal(run.code, 0); assert.equal(run.orphans, true);
  for (let i = 0; i < 50 && alive(pid); i++) await sleep(20);
  assert.equal(alive(pid), false);
  assert.equal(groups.running.size, 0);
});

test('a group member that exits within the grace time is not an orphan', async () => {
  const groups = new ProcessGroups();
  // The gate exits at once; its child (same group) exits 0.2 s later, as an exiting or unreaped member does.
  const run = await groups.run(process.execPath, ['-e', "const {spawn}=require('node:child_process');spawn('sleep',['0.2'],{stdio:'ignore'}).unref();"]);
  assert.equal(run.code, 0); assert.equal(run.orphans, false);
});

test('kill stops the whole process group of a running gate', async t => {
  const groups = new ProcessGroups();
  const dir = mkdtempSync(join(tmpdir(), 'gate-pool-')); t.after(() => rmSync(dir, {recursive: true, force: true}));
  const file = join(dir, 'pid');
  const pending = groups.run(process.execPath, ['-e', `${forkChild.replace('console.log(c.pid)', `require('node:fs').writeFileSync(${JSON.stringify(file)},String(c.pid))`)}setInterval(()=>{},1000);`]);
  while (!existsSync(file) || !readFileSync(file, 'utf8')) await sleep(10);
  const pid = Number(readFileSync(file, 'utf8'));
  assert.equal(alive(pid), true);
  groups.kill('SIGTERM');
  const run = await pending;
  assert.equal(run.signal, 'SIGTERM');
  for (let i = 0; i < 50 && alive(pid); i++) await sleep(20);
  assert.equal(alive(pid), false);
  const missing = await groups.run('/nonexistent/tool', []);
  assert.equal(missing.code, null); assert.match(missing.output, /ENOENT/);
});
