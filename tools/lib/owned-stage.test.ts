import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OwnedStageError, startOwned } from './owned-stage.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'owned-stage-test-')));
after(() => rmSync(root, { recursive: true, force: true }));
const sh = (script: string) => ['/bin/sh', '-c', script];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fileText(path: string): Promise<string> {
  for (let tries = 0; tries < 500; tries += 1) {
    if (existsSync(path) && readFileSync(path, 'utf8').trim() !== '') return readFileSync(path, 'utf8').trim();
    await sleep(10);
  }
  throw new Error(`${path} never appeared`);
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const collected = (stream: NodeJS.ReadableStream | null): Promise<string> => new Promise(resolve => {
  let text = '';
  stream?.setEncoding('utf8').on('data', (part: string) => { text += part; }).on('end', () => resolve(text));
});

test('a settled stage reports its code, CPU and cleanup', async () => {
  const stage = startOwned(sh('exit 3'));
  assert.equal(stage.done, false);
  const result = await stage.settled;
  assert.equal(stage.done, true);
  assert.equal(result.returncode, 3);
  assert.equal(typeof result.childCpuS, 'number');
  assert.equal(result.adoptedChildCpuS, 0);
  assert.match(result.cpuScope, /wait4/);
  assert.deepEqual(result.cleanup, { complete: true, errors: [], child_reaped: true, family_cleanup: 'registered owned-stage groups', owned_group_gone: true });
});

test('pipes, a log file, cwd and the exact environment reach the stage', async () => {
  const log = join(root, 'log');
  const fd = openSync(log, 'w');
  const stage = startOwned(sh('pwd; echo "$ONLY_TEST ${HOME:-unset}"; echo to-log >&2'),
    { cwd: root, env: { ONLY_TEST: 'exact', PATH: '/bin:/usr/bin' }, stdin: 'ignore', stdout: 'pipe', stderr: fd });
  closeSync(fd);
  const output = collected(stage.stdout);
  assert.equal((await stage.settled).returncode, 0);
  assert.equal(await output, `${root}\nexact unset\n`);
  assert.equal(readFileSync(log, 'utf8'), 'to-log\n');
});

test('stdin pipes reach the stage', async () => {
  const stage = startOwned(['/bin/cat'], { stdin: 'pipe', stdout: 'pipe' });
  const output = collected(stage.stdout);
  stage.stdin?.end('through\n');
  await stage.settled;
  assert.equal(await output, 'through\n');
});

test('a missing executable rejects with the spawn error and clean state', async () => {
  const stage = startOwned(['/nonexistent/owned-test-executable']);
  await assert.rejects(stage.settled, (error: OwnedStageError) => {
    assert.ok(error instanceof OwnedStageError);
    assert.equal(error.kind, 'FileNotFoundError');
    assert.equal(error.cleanup.child_reaped, true);
    return true;
  });
  assert.equal(stage.done, true);
});

test('an expired deadline rejects as TimeoutExpired and never runs the command', async () => {
  const marker = join(root, 'never');
  const stage = startOwned(['/usr/bin/touch', marker], { env: { ...process.env, IOT_LEAN_DEADLINE: 'clock-monotonic-v1:1.0' } });
  await assert.rejects(stage.settled, { kind: 'TimeoutExpired' });
  assert.equal(existsSync(marker), false);
});

test('cancel ends the stage with TERM and returns the cleanup', async () => {
  const pidfile = join(root, 'leader');
  const stage = startOwned(sh(`echo $$ > ${pidfile}; exec sleep 30`), { stdin: 'ignore' });
  const leader = Number(await fileText(pidfile));
  const cleanup = await stage.cancel();
  assert.equal(cleanup.complete, true, JSON.stringify(cleanup));
  assert.equal((await stage.settled).returncode, -15);
  assert.equal(alive(leader), false);
  assert.deepEqual(await stage.cancel(), cleanup, 'a second cancel gives the same answer');
});

test('cancel right after start never leaves a stage behind', async () => {
  const marker = join(root, 'racy');
  const stage = startOwned(sh(`sleep 0.2; touch ${marker}`), { stdin: 'ignore' });
  const cleanup = await stage.cancel();
  assert.equal(cleanup.complete, true, JSON.stringify(cleanup));
  await sleep(300);
  assert.equal(existsSync(marker), false);
});

test('cancel returns the cleanup of a stage that failed', async () => {
  const stage = startOwned(['/nonexistent/owned-test-executable']);
  await assert.rejects(stage.settled, { kind: 'FileNotFoundError' }); // settled first: a TERM now would beat the broker's start
  const cleanup = await stage.cancel();
  assert.equal(cleanup.child_reaped, true);
  assert.equal(cleanup.family_cleanup, 'registered owned-stage groups', 'the cleanup of the failed stage, not of an early stop');
});

test('a broker killed outright reports unconfirmed cleanup, never a clean one', async () => {
  const pidfile = join(root, 'orphan');
  // The leader's parent is the broker, so the stage can kill its own broker and live on as a real orphan.
  const stage = startOwned(sh(`echo $$ > ${pidfile}; kill -KILL $PPID; exec sleep 30`), { stdin: 'ignore' });
  await assert.rejects(stage.settled, (error: OwnedStageError) => {
    assert.ok(error instanceof OwnedStageError);
    assert.equal(error.cleanup.complete, false);
    assert.equal(error.cleanup.child_reaped, false);
    assert.equal(error.cleanup.family_cleanup, 'unconfirmed');
    return true;
  });
  assert.equal((await stage.cancel()).complete, false, 'cancel must not claim what it cannot know');
  process.kill(Number(await fileText(pidfile)), 'SIGKILL');
});

test('a child cannot reset lineage metadata', () => {
  assert.throws(() => startOwned(['true'], { env: { IOT_LEAN_STAGE_HANDLE: 'x' } }), /lineage/);
  assert.throws(() => startOwned(['true'], { env: { IOT_LEAN_STAGE_DEPTH: '1' } }), /lineage/);
  assert.throws(() => startOwned([]), RangeError);
});

test('a stage started inside a stage goes through the root broker', async () => {
  const child = fileURLToPath(new URL('./owned-stage.ts', import.meta.url));
  const script = `import { startOwned } from ${JSON.stringify(child)};
    const stage = startOwned(['/bin/sh', '-c', 'echo "$IOT_LEAN_STAGE_DEPTH"; exit 4'], { env: { PATH: '/bin:/usr/bin' }, stdout: 'inherit' });
    const result = await stage.settled;
    console.log(result.returncode, result.cleanup.complete);`;
  const stage = startOwned([process.execPath, '--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' });
  const output = collected(stage.stdout);
  assert.equal((await stage.settled).returncode, 0);
  assert.equal(await output, '2\n4 true\n');
});
