import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceIdentity } from '../src/source-identity.ts';
// @ts-expect-error Plain JavaScript host installer.
import { install, recover } from '../deploy/install-release.mjs';
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
    await assert.rejects(install(root, archive, manifest, service), /previous service restored/);
    assert.equal(readFileSync(join(root, 'src/main.ts'), 'utf8'), 'old'); assert.equal(served, oldHash);
    failTarget = false;
    const result = await install(root, archive, manifest, service);
    assert.equal(served, manifest.sourceSha256); assert.equal(readFileSync(join(root, 'src/main.ts'), 'utf8'), 'new');
    assert.equal(readFileSync(join(result.backup, 'main.ts'), 'utf8'), 'old');
    const id = '1234567890abcdef';
    writeFileSync(join(root, '.deploy-journal.json'), JSON.stringify({ id, previous: manifest.sourceSha256 }));
    renameSync(join(root, 'src'), join(root, `.src-backup-${id}`));
    await recover(root, service);
    assert.equal(served, manifest.sourceSha256); assert.equal(readFileSync(join(root, 'src/main.ts'), 'utf8'), 'new');
    const bad = { ...manifest, sha256: '0'.repeat(64) };
    await assert.rejects(install(root, archive, bad, service), /checksum mismatch/);
    assert.equal(readFileSync(join(root, 'src/main.ts'), 'utf8'), 'new');
    const unavailable = { restart: async () => { throw Error('offline'); }, healthy: async () => false };
    await assert.rejects(install(root, archive, manifest, unavailable), /current service identity is not verified/);
    assert.equal(readFileSync(join(root, 'src/main.ts'), 'utf8'), 'new');
    // Interruption after the new directory was installed: recover restores the saved source.
    const second = 'fedcba0987654321';
    writeFileSync(join(root, '.deploy-journal.json'), JSON.stringify({ id: second, previous: manifest.sourceSha256 }));
    renameSync(join(root, 'src'), join(root, `.src-backup-${second}`));
    mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/main.ts'), 'incomplete');
    await recover(root, service);
    assert.equal(readFileSync(join(root, 'src/main.ts'), 'utf8'), 'new');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
