import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceIdentity } from '../src/source-identity.ts';
import http from 'node:http';
// @ts-expect-error Plain JavaScript host installer.
import { install, recover, verifySocket } from '../deploy/install-release.mjs';
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

test('socket must be in a private directory and owned by the expected user', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobd-socket-check-')); const socket = join(dir, 'status.sock');
  const server = http.createServer();
  try {
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    verifySocket(socket, process.getuid!());
    chmodSync(dir, 0o755); assert.throws(() => verifySocket(socket, process.getuid!()), /unsafe/);
    chmodSync(dir, 0o700); assert.throws(() => verifySocket(socket, process.getuid!() + 1), /unsafe/);
  } finally { if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
