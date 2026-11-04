import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
// @ts-expect-error The release utility is plain JavaScript, also usable without a build.
import { prepareRelease } from '../deploy/prepare-release.mjs';

test('release contains the requested committed source, not dirty files or secrets', () => {
  const root = mkdtempSync(join(tmpdir(), 'jobd-release-'));
  try {
    const repo = join(root, 'repo'); mkdirSync(join(repo, 'apps/job-daemon/src'), { recursive: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(repo, 'apps/job-daemon/src/main.ts'), 'committed\n');
    git('add', '.'); git('commit', '-m', 'source');
    const commit = git('rev-parse', 'HEAD').toString().trim();
    writeFileSync(join(repo, 'apps/job-daemon/src/main.ts'), 'dirty\n');
    writeFileSync(join(repo, 'apps/job-daemon/src/secret'), 'untracked\n');
    const out = join(root, 'release.tar');
    const manifest = prepareRelease(repo, 'HEAD', out);
    assert.equal(manifest.commit, commit);
    assert.equal(manifest.sha256, createHash('sha256').update(readFileSync(out)).digest('hex'));
    assert.deepEqual(JSON.parse(readFileSync(`${out}.json`, 'utf8')), manifest);
    const paths = execFileSync('tar', ['-tf', out]).toString();
    assert.match(paths, /apps\/job-daemon\/src\/main.ts/);
    assert.doesNotMatch(paths, /secret/);
    assert.equal(execFileSync('tar', ['-xOf', out, 'apps/job-daemon/src/main.ts']).toString(), 'committed\n');
    assert.throws(() => prepareRelease(repo, 'HEAD', out), /EEXIST/);
    assert.throws(() => prepareRelease(repo, 'missing-ref', join(root, 'missing.tar')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
