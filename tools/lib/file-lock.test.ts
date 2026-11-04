import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { LockBusyError, holdJobSlot, holdLock, holdResourceGuard, lockHeld } from './file-lock.ts';
import { iotrouteBin, iotrouteMissing } from './iotroute-bin.ts';
const needsBinary = { skip: iotrouteMissing() };   // runs for real in CI job tools-iotroute

const root = mkdtempSync(join(tmpdir(), 'file-lock-'));
after(() => rmSync(root, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('a held lock is seen as held, and free again after release', needsBinary, async () => {
  const path = join(root, 'a/b/slot');
  assert.equal(lockHeld(path), false);
  assert.equal(existsSync(path), false, 'the probe never creates the file');
  const lock = await holdLock(path);
  assert.equal(lockHeld(path), true);
  await lock.release();
  await lock.release();
  assert.equal(lockHeld(path), false);
});

test('code after an awaited release runs even when nothing else keeps the process alive', needsBinary, () => {
  const program = `import { holdLock } from ${JSON.stringify(new URL('./file-lock.ts', import.meta.url).href)};
    const lock = await holdLock(${JSON.stringify(join(root, 'last'))});
    await lock.release();
    console.log('after release');`;
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', program], { encoding: 'utf8', timeout: 30000 });
  assert.equal(run.stdout, 'after release\n', run.stderr);
});

test('a second holder fails at once without a wait', needsBinary, async () => {
  const path = join(root, 'busy');
  const lock = await holdLock(path);
  await assert.rejects(holdLock(path), LockBusyError);
  await lock.release();
});

test('a wait outlasts a short holder and gives up on a long one', needsBinary, async () => {
  const path = join(root, 'wait');
  const first = await holdLock(path);
  const waiting = holdLock(path, { waitS: 5 });
  await sleep(100);
  await first.release();
  const second = await waiting;
  const started = Date.now();
  await assert.rejects(holdLock(path, { waitS: 0.2 }), LockBusyError);
  assert.ok(Date.now() - started >= 200);
  await second.release();
});

test('job slot and guard keep the text of the Python errors', needsBinary, async () => {
  const slot = join(root, 'slot');
  const held = await holdJobSlot(slot);
  await assert.rejects(holdJobSlot(slot), { message: 'another cooperating BASE-B pipeline is active; retry after it finishes' });
  await held.release();
  const guard = await holdResourceGuard(root);
  await assert.rejects(holdResourceGuard(root, 0.05), { message: 'resource ledger busy; admission deadline reached' });
  await guard.release();
});

test('a bad wait or path fails clearly', needsBinary, async () => {
  await assert.rejects(holdLock(join(root, 'x'), { waitS: -1 }), RangeError);
  await assert.rejects(holdLock(root), /lock helper failed/);
});

test('the ticket stays locked through TERM to the holder and frees on KILL or owner death', needsBinary, async () => {
  const path = join(root, 'ticket');
  const helper = spawn(iotrouteBin(), ['lock', 'hold', path], { stdio: ['pipe', 'pipe', 'inherit'] });
  await new Promise(resolve => helper.stdout.once('data', resolve));
  helper.kill('SIGTERM');
  await sleep(100);
  assert.equal(lockHeld(path), true, 'a group TERM must not free the lock during owner cleanup');
  helper.kill('SIGKILL');
  await new Promise(resolve => helper.once('exit', resolve));
  assert.equal(lockHeld(path), false);

  const script = `require('node:child_process').spawn(process.argv[1], ['lock', 'hold', process.argv[2]], { stdio: ['pipe', 'inherit', 'inherit'] });
    setInterval(() => {}, 1000);`;
  const owner = spawn(process.execPath, ['-e', script, iotrouteBin(), path], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(resolve => owner.stdout.once('data', resolve));
  assert.equal(lockHeld(path), true);
  owner.kill('SIGKILL');
  await new Promise(resolve => owner.once('exit', resolve));
  const deadline = Date.now() + 2000;
  while (lockHeld(path) && Date.now() < deadline) await sleep(10);
  assert.equal(lockHeld(path), false, 'the death of the owner closes stdin and frees the lock');
});
