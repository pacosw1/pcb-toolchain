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
  const entries = git('ls-tree', '-r', commit, '--', 'apps/job-daemon/src').toString().trim().split('\n').filter(Boolean);
  if (entries.some((entry) => !/^100(644|755) blob [0-9a-f]+\t/.test(entry))) throw new Error('daemon source must contain regular files only');
  if (!files.includes('apps/job-daemon/src/main.ts')) throw new Error('commit has no daemon entry point');
  const sourceHash = createHash('sha256');
  sourceHash.update('pcb-job-daemon-source-v1\0');
  for (const file of files.sort()) {
    const name = file.slice('apps/job-daemon/src/'.length);
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`unsupported daemon source entry: ${name}`);
    const data = git('show', `${commit}:${file}`);
    sourceHash.update(`${name}\0${data.length}\0`); sourceHash.update(data);
  }
  const archive = git('archive', '--format=tar', commit, '--', 'apps/job-daemon/src');
  const manifest = { commit, sha256: createHash('sha256').update(archive).digest('hex'), sourceSha256: sourceHash.digest('hex'), path: 'apps/job-daemon/src', format: 'tar' };
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
