import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquire, DEFAULT_LOCK, readOwner } from './bench-lock.ts';
import { iotrouteMissing } from './iotroute-bin.ts';

// The lock is an OS flock held by the iotroute helper. Without a built binary these cases cannot run.
const skip = iotrouteMissing();
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), 'bench-lock-')); return { dir, lock: join(dir, 'x.lock') }; };
const deadPid = (): number => { const child = spawnSync('true'); return child.pid ?? 999999; };

test('the default lock lives under the system temp dir, not one user', () => {
  assert.equal(DEFAULT_LOCK, join(tmpdir(), 'opencode', 'bench.lock'));
  assert.ok(DEFAULT_LOCK.startsWith(tmpdir()));
});

test('acquire records the owner, refuses a second holder by name, and release frees it', { skip }, async () => {
  const { dir, lock } = fresh();
  try {
    const release = await acquire({ lock, label: 'one' });
    assert.equal(readOwner(lock)?.pid, process.pid);
    await assert.rejects(acquire({ lock, label: 'two' }), new RegExp(`held by pid ${process.pid} \\(one`));
    await release();
    const again = await acquire({ lock, label: 'three' });
    assert.equal(readOwner(lock)?.label, 'three');
    await again();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a lock file left by a dead process is free: liveness is the flock, never the pid', { skip }, async () => {
  const { dir, lock } = fresh();
  try {
    // A crash loses the flock but leaves the file and its owner JSON.
    writeFileSync(lock, JSON.stringify({ pid: deadPid(), started: 'then', label: 'ghost', cwd: '/' }));
    const release = await acquire({ lock, label: 'live' });
    assert.equal(readOwner(lock)?.label, 'live');
    await release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('wait queues behind a live holder and proceeds once it releases', { skip }, async () => {
  const { dir, lock } = fresh();
  let fallback: NodeJS.Timeout | undefined;
  try {
    const release = await acquire({ lock, label: 'first' });
    let waits = 0;
    let notify: () => void = () => {};
    const observed = new Promise<void>(resolve => { notify = resolve; });
    // Release only once the waiter has actually observed the holder, so this never depends on how fast a poll runs.
    fallback = setTimeout(() => { void release(); }, 10_000);
    const releaser = (async () => { await observed; await release(); })();
    const second = await acquire({ lock, label: 'second', wait: true, pollMs: 20, onWait: () => { waits += 1; notify(); } });
    assert.ok(waits >= 1, `waited ${waits} times`);
    assert.equal(readOwner(lock)?.label, 'second');
    await second();
    await releaser;
  } finally { if (fallback) clearTimeout(fallback); rmSync(dir, { recursive: true, force: true }); }
});

test('two concurrent takers of a dead owner file never both hold the lock', { skip }, async () => {
  const { dir, lock } = fresh();
  try {
    writeFileSync(lock, JSON.stringify({ pid: deadPid(), started: 'then', label: 'ghost', cwd: '/' }));
    const results = await Promise.allSettled([acquire({ lock, label: 'a' }), acquire({ lock, label: 'b' })]);
    const held = results.filter((result): result is PromiseFulfilledResult<() => Promise<void>> => result.status === 'fulfilled');
    assert.equal(held.length, 1);
    assert.ok(['a', 'b'].includes(readOwner(lock)?.label ?? ''));
    await held[0]!.value();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an ownerless legacy lock directory is cleared and replaced', { skip }, async () => {
  const { dir, lock } = fresh();
  try {
    mkdirSync(lock);
    const release = await acquire({ lock, label: 'after' });
    assert.equal(readOwner(lock)?.label, 'after');
    await release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a live legacy lock directory is named, not stolen', { skip }, async () => {
  const { dir, lock } = fresh();
  try {
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, started: 'then', label: 'legacy', cwd: '/' }));
    await assert.rejects(acquire({ lock, label: 'new' }), /held by pid \d+ \(legacy/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
