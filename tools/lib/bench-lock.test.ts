import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquire, DEFAULT_LOCK, readOwner } from './bench-lock.ts';

const fresh = () => { const dir = mkdtempSync(join(tmpdir(), 'bench-lock-')); return { dir, lock: join(dir, 'x.lock') }; };
const deadPid = (): number => { const child = spawnSync('true'); return child.pid ?? 999999; };

test('the default lock lives under the system temp dir, not one user', () => {
  assert.equal(DEFAULT_LOCK, join(tmpdir(), 'opencode', 'bench.lock'));
  assert.ok(DEFAULT_LOCK.startsWith(tmpdir()));
});

test('acquire records the owner, refuses a second holder by name, and release frees it', async () => {
  const { dir, lock } = fresh();
  try {
    const release = await acquire({ lock, label: 'one' });
    assert.equal(readOwner(lock)?.pid, process.pid);
    await assert.rejects(acquire({ lock, label: 'two' }), new RegExp(`held by pid ${process.pid} \\(one`));
    release();
    assert.equal(existsSync(lock), false);
    (await acquire({ lock, label: 'three' }))();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a lock whose owner process is gone is stale and taken over', async () => {
  const { dir, lock } = fresh();
  try {
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: deadPid(), started: 'then', label: 'ghost', cwd: '/' }));
    const release = await acquire({ lock, label: 'live' });
    assert.equal(readOwner(lock)?.label, 'live');
    release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('wait queues behind a live holder and proceeds once it releases', async () => {
  const { dir, lock } = fresh();
  try {
    const release = await acquire({ lock, label: 'first' });
    let seen: unknown = null;
    setTimeout(release, 60);
    const second = await acquire({ lock, label: 'second', wait: true, pollMs: 10, onWait: owner => { seen = owner?.label; } });
    assert.equal(seen, 'first');
    assert.equal(readOwner(lock)?.label, 'second');
    second();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
