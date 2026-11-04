#!/usr/bin/env node
// Package committed daemon source, never the operator's working tree or configuration.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function prepareRelease(repo, revision, output) {
  const git = (...args) => execFileSync('git', args, { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
  const commit = git('rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`).toString().trim();
  const files = git('ls-tree', '-r', '--name-only', commit, '--', 'apps/job-daemon/src').toString().trim().split('\n').filter(Boolean);
  if (!files.includes('apps/job-daemon/src/main.ts')) throw new Error('commit has no daemon entry point');
  const archive = git('archive', '--format=tar', commit, '--', 'apps/job-daemon/src');
  const manifest = { commit, sha256: createHash('sha256').update(archive).digest('hex'), path: 'apps/job-daemon/src', format: 'tar' };
  // Exclusive creation avoids silently replacing a release another operator may be using.
  writeFileSync(output, archive, { flag: 'wx' });
  try { writeFileSync(`${output}.json`, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' }); }
  catch (error) { throw new Error(`archive created at ${output}, but manifest was not written: ${error.message}`); }
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [revision, output] = process.argv.slice(2);
  if (!revision || !output || process.argv.length !== 4) {
    console.error('usage: node prepare-release.mjs COMMIT OUTPUT.tar');
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(prepareRelease(process.cwd(), revision, resolve(output)))); }
    catch (error) { console.error(`prepare-release: ${error.message}`); process.exitCode = 1; }
  }
}
