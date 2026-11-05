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
  const result = run(bin, `await import(${url('./env.mjs')}); await import(${url('./board-json.ts')}); await import(${url('./board-edit.ts')}); await import(${url('./kicad-happy-phases.ts')});`);
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

const DOCTOR = new URL('../doctor.mjs', import.meta.url).pathname;

function doctor(bin: string, env: Record<string, string>) {
  const { PYTHON_MODERN: _unset, REMOTE_NO_DAEMON: _local, ...base } = process.env;
  return spawnSync(process.execPath, [DOCTOR, '--gate-only'], { encoding: 'utf8',
    env: { ...base, PATH: `${bin}:/usr/bin:/bin`, PCB_HOST_PLATFORM: 'darwin', KICAD_CLI: '/no/such', KICAD_PYTHON: '/no/such', ...env } });
}

test('doctor on macOS names the job runtime and starts no Python', t => {
  const { bin, log } = fakePythons(t);
  const { stdout } = doctor(bin, {});
  assert.match(stdout, /^ok {4}kicad-happy runtime \(daemon job\): iot-lab-route:\S+ Python \d/m);
  assert.doesNotMatch(stdout, /Python 3\.10/);
  assert.equal(existsSync(log), false);
});

test('doctor asks for a local Python only for a local run, and does not require it', t => {
  const { bin, log } = fakePythons(t);
  for (const name of ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3']) writeFileSync(join(bin, name), `#!/bin/sh\necho ${name} >> ${log}\nexit 1\n`);
  const { stdout } = doctor(bin, { REMOTE_NO_DAEMON: '1' });
  assert.match(stdout, /^warn {2}Python 3\.10 or later \(local kicad-happy run\): not found/m);
  assert.equal(existsSync(log), true);
});
