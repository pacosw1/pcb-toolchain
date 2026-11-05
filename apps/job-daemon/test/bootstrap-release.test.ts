import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { sourceIdentity } from '../src/source-identity.ts';
// @ts-expect-error Deployment helpers are JavaScript.
import { prepareRelease } from '../deploy/prepare-release.mjs';
// @ts-expect-error Deployment helpers are JavaScript.
import { bootstrap, recoverLegacy } from '../deploy/bootstrap-release.mjs';

test('legacy bootstrap refuses unhealthy service and rolls back a failed target', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-legacy-bootstrap-'));
  try {
    const repo = path.join(dir, 'repo'), root = path.join(dir, 'host');
    fs.mkdirSync(path.join(repo, 'apps/job-daemon/src'), { recursive: true }); fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    fs.writeFileSync(path.join(root, 'src/main.ts'), 'old');
    const previous = sourceIdentity(path.join(root, 'src'));
    fs.writeFileSync(path.join(repo, 'apps/job-daemon/src/main.ts'), 'new'); git('add', '.'); git('commit', '-m', 'new');
    const archive = path.join(dir, 'release.tar'), manifest = prepareRelease(repo, 'HEAD', archive);
    let active = previous, allowLegacy = false, allowNew = true;
    const service = { legacyHealthy: async (expected: string) => allowLegacy && active === expected,
      newHealthy: async (expected: string) => allowNew && active === expected,
      restart: async () => { active = sourceIdentity(path.join(root, 'src')); } };
    await assert.rejects(bootstrap(root, archive, manifest, manifest.sha256, service), /preflight failed/);
    assert.equal(fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8'), 'old');
    allowLegacy = true; allowNew = false;
    await assert.rejects(bootstrap(root, archive, manifest, manifest.sha256, service), /previous service restored/);
    assert.equal(active, previous); assert.equal(fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8'), 'old');
    allowNew = true;
    const deployed = await bootstrap(root, archive, manifest, manifest.sha256, service);
    assert.equal(deployed.sourceSha256, manifest.sourceSha256);
    assert.equal(fs.readFileSync(path.join(deployed.backup, 'main.ts'), 'utf8'), 'old');
    const id = '1234567890abcdef';
    fs.writeFileSync(path.join(root, '.deploy-journal.json'), JSON.stringify({ id, previous: manifest.sourceSha256 }));
    fs.renameSync(path.join(root, 'src'), path.join(root, `.src-backup-${id}`));
    await recoverLegacy(root, service);
    assert.equal(active, manifest.sourceSha256);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
