import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { iotrouteMissing } from './iotroute-bin.ts';
import { startCheck } from './pcb-check-start.ts';

const needsBinary = { skip: iotrouteMissing() };
const cli = (name: string) => fileURLToPath(new URL(`../${name}`, import.meta.url));
const pcb = (root: string, ...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', cli(args[0] === 'check' ? 'pcb-check.ts' : 'pcb-observe.ts'), '--project', root, ...args], { encoding: 'utf8' });

function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cad-seal-cli-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'hardware-design/boards/X/cad'), { recursive: true });
  mkdirSync(join(root, 'tools'), { recursive: true });
  writeFileSync(join(root, 'hardware-design/boards/X/gate.json'), '{"project":"cad/X","checks":{"erc":true}}');
  writeFileSync(join(root, 'tools/gate.mjs'), 'process.exitCode = 0;');
  for (const ext of ['kicad_pcb', 'kicad_sch', 'kicad_pro']) writeFileSync(join(root, `hardware-design/boards/X/cad/X.${ext}`), `fixture ${ext}`);
  return { root, pcb: join(root, 'hardware-design/boards/X/cad/X.kicad_pcb') };
}

test('check stops on a missing seal before any run exists', async t => {
  const f = fixture(t), call = () => startCheck({ root: f.root, base: join(f.root, '.gate/cli'), board: 'X', timeout: 20, heartbeat: 1 });
  await assert.rejects(call(), /no CAD seal.*tools\/pcb seal X --accept --reason/s);
  assert.equal(existsSync(join(f.root, '.gate/cli')), false);
});

test('check on a changed board fails with the seal error and names the file', needsBinary, t => {
  const f = fixture(t);
  assert.equal(pcb(f.root, 'seal', 'X', '--accept', '--reason', 'first seal').status, 0);
  writeFileSync(f.pcb, 'plain file write');
  const call = pcb(f.root, 'check', 'X', '--detach', '--json');
  assert.equal(call.status, 2);
  assert.match(JSON.parse(call.stdout).cause, /changed outside our tools[\s\S]*hardware-design\/boards\/X\/cad\/X\.kicad_pcb/);
  assert.equal(existsSync(join(f.root, '.gate/cli')), false);
});

test('seal reports status read-only, accepts a person edit with a reason, and then the next command passes the seal check', needsBinary, t => {
  const f = fixture(t);
  const missing = pcb(f.root, 'seal', 'X', '--json');
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout).state, 'missing');
  assert.equal(existsSync(join(f.root, 'hardware-design/boards/X/cad-seal.json')), false);
  assert.equal(pcb(f.root, 'seal', 'X', '--accept').status, 2);
  assert.equal(pcb(f.root, 'seal', 'X', '--reason', 'x').status, 2);
  assert.equal(pcb(f.root, 'seal', 'X', '--accept', '--reason', 'first seal').status, 0);
  const clean = pcb(f.root, 'seal', 'X', '--json');
  assert.equal(clean.status, 0);
  assert.equal(JSON.parse(clean.stdout).state, 'sealed');
  writeFileSync(f.pcb, 'a person moved a part in KiCad');
  const broken = pcb(f.root, 'seal', 'X', '--json');
  assert.equal(broken.status, 1);
  assert.deepEqual(JSON.parse(broken.stdout).changed, ['hardware-design/boards/X/cad/X.kicad_pcb']);
  assert.match(pcb(f.root, 'seal', 'X').stdout + pcb(f.root, 'seal', 'X').stderr, /changed outside our tools/);
  assert.equal(pcb(f.root, 'seal', 'X', '--accept', '--reason', 'moved U1').status, 0);
  assert.equal(pcb(f.root, 'seal', 'X').status, 0);
  const log = readFileSync(join(f.root, '.gate/cad-seal/X.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(log.map(row => row.reason), ['first seal', 'moved U1']);
  const next = pcb(f.root, 'check', 'X', '--baseline', 'run-none', '--json');   // passes the seal check, then stops on the unknown baseline run
  assert.match(JSON.parse(next.stdout).cause, /unknown run: run-none/);
});
