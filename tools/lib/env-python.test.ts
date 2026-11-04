import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

// Stand-ins for python3.x that log each start, on an otherwise empty PATH: no real Python runs here.
function fakePythons(t: TestContext): { bin: string; log: string } {
  const bin = mkdtempSync(join(tmpdir(), 'env-python-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const log = join(bin, 'started');
  for (const name of ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3']) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho ${name} >> ${log}\necho True\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return { bin, log };
}

function run(bin: string, program: string) {
  const { PYTHON_MODERN: _unset, ...env } = process.env;
  return spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', program],
    { encoding: 'utf8', env: { ...env, PATH: `${bin}:/usr/bin:/bin` } });
}

const url = (name: string) => JSON.stringify(new URL(name, import.meta.url).pathname);

test('importing the board tools starts no Python', t => {
  const { bin, log } = fakePythons(t);
  const result = run(bin, `await import(${url('./env.mjs')}); await import(${url('./board-json.ts')}); await import(${url('./board-edit.ts')});`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(log), false);
});

test('modernPython() looks once, when it is asked', t => {
  const { bin, log } = fakePythons(t);
  const result = run(bin, `const {modernPython}=await import(${url('./env.mjs')}); console.log(modernPython(), modernPython());`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'python3.13 python3.13');
  assert.equal(readFileSync(log, 'utf8'), 'python3.13\n');
});
