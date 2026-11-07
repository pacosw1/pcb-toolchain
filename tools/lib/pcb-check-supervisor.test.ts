import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { sealFixtureBoard } from './cad-seal-fixture.ts';
import { iotrouteBin, iotrouteMissing } from './iotroute-bin.ts';
import { startCheck } from './pcb-check-start.ts';
import { status } from './pcb-runs.ts';
import { verify } from './pcb-evidence.ts';

const needsBinary = { skip: iotrouteMissing() };
const installed = fileURLToPath(new URL(`../../bin/iotroute-${process.platform === 'darwin' ? 'darwin-arm64' : 'linux-x86_64'}`, import.meta.url));
const terminal = new Set(['passed', 'failed', 'error', 'cancelled', 'timeout']);

async function settled(folder: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 300; i++) {
    const state = status(folder);
    if (terminal.has(String(state.get('status'))) && state.get('controller_alive') !== true)
      return JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8')) as Record<string, unknown>;
    await delay(100);
  }
  throw new Error(`check did not settle: ${readFileSync(join(folder, 'worker.log'), 'utf8')}`);
}

function fixture(t: { after(fn: () => void): void }, body: string): string {
  const root = mkdtempSync(join(tmpdir(), 'pcb-check-supervisor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'hardware-design/boards/X'), { recursive: true });
  mkdirSync(join(root, 'tools'), { recursive: true });
  writeFileSync(join(root, 'hardware-design/boards/X/gate.json'), '{"project":"cad/X","checks":{"erc":true}}');
  writeFileSync(join(root, 'tools/gate.mjs'), body);
  sealFixtureBoard(root, 'X');
  return root;
}

const gate = (code: number, end = true) => `
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
const dir=process.argv[process.argv.indexOf('--evidence-dir')+1]; mkdirSync(dir,{recursive:true});
appendFileSync(dir+'/events.jsonl', JSON.stringify({schema_version:1,time:new Date().toISOString(),type:'gate.start'})+'\\n');
${end ? "appendFileSync(dir+'/events.jsonl', JSON.stringify({schema_version:1,time:new Date().toISOString(),type:'gate.end'})+'\\n');" : ''}
writeFileSync(dir+'/result.json',JSON.stringify({exit:${code},changedDuringRun:false,metrics:{erc_errors:${code}},provenance:{input_sha256:'a'.repeat(64),tools:{kicad:'fixture'}},checks:{erc:{status:${JSON.stringify(code ? 'failed' : 'passed')},metrics:{erc_errors:${code}}}}}));
process.exitCode=${code};`;

test('check seals a matching gate only after the owned worker settles', needsBinary, async t => {
  const root = fixture(t, gate(0));
  const folder = await startCheck({ root, base: join(root, '.gate/cli'), board: 'X', timeout: 20, heartbeat: 1 });
  const result = await settled(folder);
  assert.equal(result.status, 'passed');
  assert.equal((result.cleanup as { complete?: boolean }).complete, true);
  assert.equal((verify(folder)).get('status'), 'passed');
  assert.equal(JSON.parse(readFileSync(join(folder, 'worker-owner.json'), 'utf8')).cleanup.complete, true);
  assert.ok(readFileSync(join(folder, 'events.jsonl'), 'utf8').includes('"type": "run.end"'));
});

test('installed pcb check admits a detached run without Python', { skip: !existsSync(installed) }, async t => {
  const root = fixture(t, gate(0));
  const shim = join(root, 'shim'); mkdirSync(shim);
  writeFileSync(join(shim, 'python3'), '#!/bin/sh\nexit 72\n', { mode: 0o755 });
  const bin = fileURLToPath(new URL('../../bin/pcb', import.meta.url));
  const call = spawnSync(bin, ['--project', root, 'check', 'X', '--detach', '--json'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${shim}:${process.env.PATH}` },
  });
  assert.equal(call.status, 0, call.stderr || call.stdout);
  const state = JSON.parse(call.stdout);
  assert.match(state.run_id, /^run-/);
  const result = await settled(join(root, '.gate/cli', state.run_id));
  assert.equal(result.status, 'passed');
});

test('check attaches to an open cycle without Python', needsBinary, async t => {
  const root = fixture(t, gate(0)), base = join(root, '.gate/cli'), cycle = join(base, 'cycle-test');
  mkdirSync(cycle, { recursive: true });
  writeFileSync(join(cycle, 'cycle.json'), JSON.stringify({ root: realpathSync(root), board: 'X', status: 'open', runs: [] }));
  const shim = join(root, 'shim'); mkdirSync(shim);
  writeFileSync(join(shim, 'python3'), '#!/bin/sh\nexit 72\n', { mode: 0o755 });
  const cli = fileURLToPath(new URL('../pcb-check.ts', import.meta.url));
  const call = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, '--project', root, 'check', 'X', '--cycle', 'cycle-test', '--detach', '--json'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${shim}:${process.env.PATH}` },
  });
  assert.equal(call.status, 0, call.stderr || call.stdout);
  const state = JSON.parse(call.stdout), record = JSON.parse(readFileSync(join(cycle, 'cycle.json'), 'utf8'));
  assert.equal(record.runs[0].run_id, state.run_id);
  assert.equal(record.runs[0].stage, 'verification');
  assert.equal((await settled(join(base, state.run_id))).status, 'passed');
});

test('a supervisor that cannot start leaves no run linked to its cycle', needsBinary, async t => {
  const root = fixture(t, gate(0)), base = join(root, '.gate/cli'), cycle = join(base, 'cycle-test');
  mkdirSync(cycle, { recursive: true });
  writeFileSync(join(cycle, 'cycle.json'), JSON.stringify({ root: realpathSync(root), board: 'X', status: 'open', runs: [] }));
  // While the cycle lock is taken for the attach, the run folder gets a directory where worker.log goes: the start then fails.
  const shim = join(root, 'iotroute-shim');
  writeFileSync(shim, `#!/bin/sh\ncase "$*" in *cycle.lock*) mkdir "$(ls -d "${base}"/run-* | head -1)/worker.log" 2>/dev/null;; esac\nexec "${iotrouteBin()}" "$@"\n`, { mode: 0o755 });
  const saved = process.env.IOTROUTE_BIN;
  process.env.IOTROUTE_BIN = shim;
  t.after(() => { if (saved === undefined) delete process.env.IOTROUTE_BIN; else process.env.IOTROUTE_BIN = saved; });
  await assert.rejects(startCheck({ root, base, board: 'X', cycle: 'cycle-test', timeout: 20, heartbeat: 1 }), /EISDIR/);
  assert.deepEqual(JSON.parse(readFileSync(join(cycle, 'cycle.json'), 'utf8')).runs, []);
});

test('conflicting check flags fail before creating a run', () => {
  const root = mkdtempSync(join(tmpdir(), 'pcb-check-flags-'));
  try {
    const cli = fileURLToPath(new URL('../pcb-check.ts', import.meta.url));
    const call = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, '--project', root,
      'check', 'X', '--changed', '--fresh', '--json'], { encoding: 'utf8' });
    assert.equal(call.status, 2);
    assert.match(JSON.parse(call.stdout).cause, /cannot be used together/);
    assert.equal(existsSync(join(root, '.gate/cli')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('check never passes without gate.end', needsBinary, async t => {
  const root = fixture(t, gate(0, false));
  const folder = await startCheck({ root, base: join(root, '.gate/cli'), board: 'X', timeout: 20, heartbeat: 1 });
  const result = await settled(folder);
  assert.equal(result.status, 'error');
  assert.match(String(result.cause), /terminal evidence disagree/);
});

test('check refuses a gate changed after admission even if the tool exits zero', needsBinary, async t => {
  const root = fixture(t, gate(0) + `\nwriteFileSync('hardware-design/boards/X/gate.json', '{}');`);
  const folder = await startCheck({ root, base: join(root, '.gate/cli'), board: 'X', timeout: 20, heartbeat: 1 });
  const result = await settled(folder);
  assert.equal(result.status, 'error');
  assert.match(String(result.cause), /configured gate changed after check admission/);
});

test('deadline cancels the owned gate and never produces a pass', needsBinary, async t => {
  const root = fixture(t, 'setTimeout(() => {}, 30000);');
  const folder = await startCheck({ root, base: join(root, '.gate/cli'), board: 'X', timeout: 0.5, heartbeat: 0.1 });
  const result = await settled(folder);
  assert.equal(result.status, 'timeout');
  assert.equal((result.cleanup as { complete?: boolean }).complete, true);
  assert.equal(existsSync(join(folder, 'gate/result.json')), false);
});

test('cancellation stops the owned gate before a terminal receipt is sealed', needsBinary, async t => {
  const root = fixture(t, 'setTimeout(() => {}, 30000);');
  const folder = await startCheck({ root, base: join(root, '.gate/cli'), board: 'X', timeout: 20, heartbeat: 0.1 });
  for (let i = 0; i < 100 && status(folder).get('status') !== 'running'; i++) await delay(50);
  writeFileSync(join(folder, 'cancel.request'), '{}');
  const result = await settled(folder);
  assert.equal(result.status, 'cancelled');
  assert.equal((result.cleanup as { complete?: boolean }).complete, true);
  assert.equal(existsSync(join(folder, 'gate/result.json')), false);
});

test('a killed worker cannot leave a successful terminal receipt', needsBinary, async t => {
  const root = fixture(t, 'setTimeout(() => {}, 30000);');
  const folder = await startCheck({ root, base: join(root, '.gate/cli'), board: 'X', timeout: 20, heartbeat: 0.1 });
  let pid = 0;
  for (let i = 0; i < 100 && !pid; i++) {
    const state = status(folder);
    if (state.get('status') === 'running') pid = Number(state.get('worker_pid'));
    if (!pid) await delay(50);
  }
  assert.ok(pid > 0);
  process.kill(pid, 'SIGKILL');
  const result = await settled(folder);
  assert.equal(result.status, 'error');
  assert.notEqual(result.exit_code, 0);
  assert.equal(existsSync(join(folder, 'gate/result.json')), false);
});

test('doctor runs as an owned environment observation with sealed evidence', needsBinary, async t => {
  const root = fixture(t, gate(0));
  writeFileSync(join(root, 'tools/doctor.mjs'), "console.log('fixture doctor'); process.exitCode = 1;");
  const folder = await startCheck({ root, base: join(root, '.gate/cli'), board: 'ENVIRONMENT', operation: 'doctor', timeout: 20, heartbeat: 1 });
  const result = await settled(folder);
  assert.equal(result.status, 'failed');
  assert.equal(result.scope, 'environment');
  assert.equal(result.operation, 'doctor');
  assert.equal((result.cleanup as { complete?: boolean }).complete, true);
  assert.equal(verify(folder).get('status'), 'failed');
  assert.match(readFileSync(join(folder, 'operation/doctor.log'), 'utf8'), /fixture doctor/);
});

test('doctor deadline cancels the owned observation', needsBinary, async t => {
  const root = fixture(t, gate(0));
  writeFileSync(join(root, 'tools/doctor.mjs'), 'setTimeout(() => {}, 30000);');
  const folder = await startCheck({ root, base: join(root, '.gate/cli'), board: 'ENVIRONMENT', operation: 'doctor', timeout: 0.5, heartbeat: 0.1 });
  const result = await settled(folder);
  assert.equal(result.status, 'timeout');
  assert.equal((result.cleanup as { complete?: boolean }).complete, true);
});

test('doctor CLI attaches its environment observation to the selected board cycle', needsBinary, async t => {
  const root = fixture(t, gate(0)), base = join(root, '.gate/cli'), cycle = join(base, 'cycle-doctor');
  mkdirSync(cycle, { recursive: true });
  writeFileSync(join(cycle, 'cycle.json'), JSON.stringify({ root: realpathSync(root), board: 'X', status: 'open', runs: [] }));
  writeFileSync(join(root, 'tools/doctor.mjs'), "console.log('doctor passed');");
  const shim = join(root, 'shim'); mkdirSync(shim);
  writeFileSync(join(shim, 'python3'), '#!/bin/sh\nexit 72\n', { mode: 0o755 });
  const cli = fileURLToPath(new URL('../pcb', import.meta.url));
  const call = spawnSync(cli, ['--project', root, 'doctor', '--cycle', 'cycle-doctor', '--detach', '--json'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${shim}:${process.env.PATH}` },
  });
  assert.equal(call.status, 0, call.stderr || call.stdout);
  const state = JSON.parse(call.stdout), record = JSON.parse(readFileSync(join(cycle, 'cycle.json'), 'utf8'));
  assert.equal(state.board, 'X');
  assert.equal(record.runs[0].run_id, state.run_id);
  assert.equal(record.runs[0].stage, 'verification');
  assert.equal((await settled(join(base, state.run_id))).status, 'passed');
});

test('direct pcb dispatcher answers without Python', t => {
  const root = fixture(t, gate(0)), shim = join(root, 'shim'); mkdirSync(shim);
  writeFileSync(join(shim, 'python3'), '#!/bin/sh\necho legacy-fallback >&2\nexit 72\n', { mode: 0o755 });
  const cli = fileURLToPath(new URL('../pcb', import.meta.url));
  const env = { ...process.env, PATH: `${shim}:${process.env.PATH}` };
  const native = spawnSync(cli, ['--project', root, 'list', '--json'], { encoding: 'utf8', env });
  assert.equal(native.status, 0, native.stderr || native.stdout);
  assert.doesNotMatch(native.stderr, /legacy-fallback/);
  const build = spawnSync(cli, ['--project', root, 'build', 'X'], { encoding: 'utf8', env });
  assert.doesNotMatch(build.stderr, /legacy-fallback/);
});
