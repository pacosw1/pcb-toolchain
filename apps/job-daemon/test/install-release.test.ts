import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { sourceIdentity } from '../src/source-identity.ts';
import http from 'node:http';
// @ts-expect-error Plain JavaScript host installer.
import { acquireLock, install, recover, verifySocket } from '../deploy/install-release.mjs';
// @ts-expect-error Plain JavaScript release preparer.
import { prepareRelease } from '../deploy/prepare-release.mjs';

test('installer verifies identity, rolls back failure, and recovers interruption', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobd-install-'));
  try {
    const repo = join(dir, 'repo'), root = join(dir, 'host');
    mkdirSync(join(repo, 'apps/job-daemon/src'), { recursive: true }); mkdirSync(join(root, 'src'), { recursive: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(root, 'src/main.ts'), 'old');
    const oldHash = sourceIdentity(join(root, 'src'));
    writeFileSync(join(repo, 'apps/job-daemon/src/main.ts'), 'new'); git('add', '.'); git('commit', '-m', 'new');
    const archive = join(dir, 'release.tar'), manifest = prepareRelease(repo, 'HEAD', archive);
    let served = oldHash, failTarget = false;
    const service = { restart: async () => { served = sourceIdentity(join(root, 'src')); }, healthy: async (expected: string) => served === expected && !(failTarget && expected === manifest.sourceSha256) };
    failTarget = true;
    await assert.rejects(install(root, archive, manifest, manifest.sha256, service), /previous service restored/);
    assert.equal(readFileSync(join(root, 'src/main.ts'), 'utf8'), 'old'); assert.equal(served, oldHash);
    failTarget = false;
    const result = await install(root, archive, manifest, manifest.sha256, service);
    assert.equal(served, manifest.sourceSha256); assert.equal(readFileSync(join(root, 'src/main.ts'), 'utf8'), 'new');
    assert.equal(readFileSync(join(result.backup, 'main.ts'), 'utf8'), 'old');
    const id = '1234567890abcdef';
    writeFileSync(join(root, '.deploy-journal.json'), JSON.stringify({ id, previous: manifest.sourceSha256 }));
    renameSync(join(root, 'src'), join(root, `.src-backup-${id}`));
    await recover(root, service);
    assert.equal(served, manifest.sourceSha256); assert.equal(readFileSync(join(root, 'src/main.ts'), 'utf8'), 'new');
    const bad = { ...manifest, sha256: '0'.repeat(64) };
    await assert.rejects(install(root, archive, bad, manifest.sha256, service), /independently supplied archive hash/);
    await assert.rejects(install(root, archive, manifest, '0'.repeat(64), service), /independently supplied archive hash/);
    const bytes = readFileSync(archive); writeFileSync(archive, Buffer.from('tampered'));
    await assert.rejects(install(root, archive, manifest, manifest.sha256, service), /archive checksum mismatch/);
    writeFileSync(archive, bytes);
    assert.equal(readFileSync(join(root, 'src/main.ts'), 'utf8'), 'new');
    const unavailable = { restart: async () => { throw Error('offline'); }, healthy: async () => false };
    await assert.rejects(install(root, archive, manifest, manifest.sha256, unavailable), /current service identity is not verified/);
    assert.equal(readFileSync(join(root, 'src/main.ts'), 'utf8'), 'new');
    // Interruption after the new directory was installed: recover restores the saved source.
    const second = 'fedcba0987654321';
    writeFileSync(join(root, '.deploy-journal.json'), JSON.stringify({ id: second, previous: manifest.sourceSha256 }));
    renameSync(join(root, 'src'), join(root, `.src-backup-${second}`));
    mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/main.ts'), 'incomplete');
    await recover(root, service);
    assert.equal(readFileSync(join(root, 'src/main.ts'), 'utf8'), 'new');
    const corrupt = 'aabbccddeeff0011';
    writeFileSync(join(root, '.deploy-journal.json'), JSON.stringify({ id: corrupt, previous: oldHash }));
    mkdirSync(join(root, `.src-backup-${corrupt}`));
    writeFileSync(join(root, `.src-backup-${corrupt}`, 'main.ts'), 'corrupt');
    await assert.rejects(recover(root, service), /backup source cannot be verified/);
    assert.equal(readFileSync(join(root, 'src/main.ts'), 'utf8'), 'new');
    assert.equal(readFileSync(join(root, `.src-backup-${corrupt}`, 'main.ts'), 'utf8'), 'corrupt');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** A host root and a release whose source differs from it, with a service that serves what is in src/. */
async function deployFixture(dir: string) {
  const repo = join(dir, 'repo'), root = join(dir, 'host');
  mkdirSync(join(repo, 'apps/job-daemon/src'), { recursive: true }); mkdirSync(join(root, 'src'), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, 'src/main.ts'), 'old');
  const oldHash = sourceIdentity(join(root, 'src'));
  writeFileSync(join(repo, 'apps/job-daemon/src/main.ts'), 'new'); git('add', '.'); git('commit', '-m', 'new');
  const archive = join(dir, 'release.tar'), manifest = prepareRelease(repo, 'HEAD', archive);
  let served = oldHash;
  const service = { restart: async () => { served = sourceIdentity(join(root, 'src')); }, healthy: async (expected: string) => served === expected };
  return { root, archive, manifest, oldHash, service };
}

test('a crash after the new release proved healthy and before the journal went keeps the release', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobd-install-'));
  try {
    const { root, manifest, oldHash, service } = await deployFixture(dir);
    // The state a crash leaves: new source in place and serving, the old one saved, the journal still there.
    const id = '1234567890abcdef';
    renameSync(join(root, 'src'), join(root, `.src-backup-${id}`));
    mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/main.ts'), 'new');
    await service.restart();
    writeFileSync(join(root, '.deploy-journal.json'), JSON.stringify({ id, previous: oldHash, target: manifest.sourceSha256 }));
    const result = await recover(root, service);
    assert.deepEqual(result, { committed: manifest.sourceSha256 });
    assert.equal(readFileSync(join(root, 'src/main.ts'), 'utf8'), 'new');
    assert.equal(existsSync(join(root, '.deploy-journal.json')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a journal whose target does not serve is still rolled back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobd-install-'));
  try {
    const { root, manifest, oldHash } = await deployFixture(dir);
    const id = '1234567890abcdef';
    renameSync(join(root, 'src'), join(root, `.src-backup-${id}`));
    mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/main.ts'), 'new');
    writeFileSync(join(root, '.deploy-journal.json'), JSON.stringify({ id, previous: oldHash, target: manifest.sourceSha256 }));
    let served = '';
    const sick = { restart: async () => { served = sourceIdentity(join(root, 'src')); }, healthy: async (expected: string) => served === expected && expected === oldHash };
    assert.deepEqual(await recover(root, sick), { restored: oldHash });
    assert.equal(readFileSync(join(root, 'src/main.ts'), 'utf8'), 'old');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a deployment leaves only the newest backup and removes stale stage and failed directories', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobd-install-'));
  try {
    const { root, archive, manifest, service } = await deployFixture(dir);
    for (const stale of ['.src-stage-aaaaaaaaaaaaaaaa', '.src-backup-bbbbbbbbbbbbbbbb', '.src-failed-cccccccccccccccc']) {
      mkdirSync(join(root, stale)); writeFileSync(join(root, stale, 'main.ts'), 'stale');
    }
    const result = await install(root, archive, manifest, manifest.sha256, service);
    assert.deepEqual(readdirSync(root).filter((n) => n.startsWith('.src-')), [basename(result.backup)]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the deploy lock: a live holder blocks, a dead holder is taken over, a fresh lock with no pid waits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobd-lock-'));
  try {
    const lock = join(dir, '.deploy-lock');
    const alive = (pid: number) => pid === 111;
    const release = acquireLock(lock, { pid: 111, alive, now: () => 1_000 });
    assert.throws(() => acquireLock(lock, { pid: 222, alive, now: () => 1_000 }), /another installer is running \(pid 111\)/);
    release();
    assert.equal(existsSync(lock), false);
    mkdirSync(lock); writeFileSync(join(lock, 'pid'), '333');
    const taken = acquireLock(lock, { pid: 222, alive, now: () => 1_000 });
    assert.equal(readFileSync(join(lock, 'pid'), 'utf8'), '222');
    taken();
    mkdirSync(lock);
    assert.throws(() => acquireLock(lock, { pid: 222, alive, now: () => Date.now() }), /being created/);
    assert.equal(typeof acquireLock(lock, { pid: 222, alive, now: () => Date.now() + 120_000 }), 'function');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('socket must be in a private directory and owned by the expected user', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobd-socket-check-')); const subdir = join(dir, 'default'); mkdirSync(subdir, { mode: 0o700 }); const socket = join(subdir, 'pid-1.sock');
  const server = http.createServer();
  try {
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    verifySocket(socket, process.getuid!());
    chmodSync(dir, 0o755); assert.throws(() => verifySocket(socket, process.getuid!()), /unsafe/);
    chmodSync(dir, 0o700); assert.throws(() => verifySocket(socket, process.getuid!() + 1), /unsafe/);
  } finally { if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
