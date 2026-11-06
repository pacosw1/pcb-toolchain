import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifySeal } from './cad-seal.ts';
import { sealFixtureBoard } from './cad-seal-fixture.ts';
import { repairFile } from './board-uuids.ts';

const tools = (name: string) => fileURLToPath(new URL(`../${name}`, import.meta.url));
const FAKE_CLI = `#!/bin/sh
for a in "$@"; do [ "$prev" = --output ] && out=$a; prev=$a; last=$a; done
echo '{"defaults":true}' > "$(dirname "$last")/X.kicad_pro"
echo '{"violations":[],"unconnected_items":[],"schematic_parity":[]}' > "$out"
`;
const SILK = '(kicad_pcb\n\t(footprint "iot-lab:C1"\n\t\t(layer "F.Cu")\n\t\t(property "Reference" "C5"\n\t\t\t(at 0 -1 0)\n\t\t\t(layer "F.SilkS")\n\t\t\t(uuid "a")\n\t\t)\n\t)\n)\n';

function fixture(t: { after(fn: () => void): void }, text = SILK) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cad-seal-writers-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'hardware-design/boards/X/cad'), { recursive: true });
  writeFileSync(join(root, 'hardware-design/boards/X/gate.json'), '{"project":"cad/X","checks":{}}');
  const pcb = join(root, 'hardware-design/boards/X/cad/X.kicad_pcb');
  writeFileSync(pcb, text); writeFileSync(pcb.replace('.kicad_pcb', '.kicad_pro'), '{"original":true}'); writeFileSync(pcb.replace('.kicad_pcb', '.kicad_sch'), '(kicad_sch)');
  sealFixtureBoard(root, 'X');
  const log = () => readFileSync(join(root, '.gate/cad-seal/X.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { root, pcb, log };
}
const run = (script: string, ...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', script, ...args], { encoding: 'utf8' });

test('saveBoardInPlace keeps the seal: the board and the restored .kicad_pro are resealed, with the tool named in the log', t => {
  const f = fixture(t), cli = join(f.root, 'kicad-cli'), script = join(f.root, 'set-thing.ts');
  writeFileSync(cli, FAKE_CLI); chmodSync(cli, 0o755);
  writeFileSync(script, `import {saveBoardInPlace} from ${JSON.stringify(tools('lib/board-edit.ts'))}; saveBoardInPlace(process.argv[2]!, '(kicad_pcb (edited))');`);
  const call = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', script, f.pcb], { encoding: 'utf8', env: { ...process.env, KICAD_CLI: cli } });
  assert.equal(call.status, 0, call.stderr);
  assert.equal(readFileSync(f.pcb, 'utf8'), '(kicad_pcb (edited))');
  verifySeal(f.root, 'X');
  const rows = f.log();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].tool, 'set-thing');
  assert.equal(JSON.parse(readFileSync(join(f.root, 'hardware-design/boards/X/cad-seal.json'), 'utf8')).writer.tool, 'set-thing');
});

test('saveBoardInPlace refuses a board that changed outside our tools and leaves it as it is', t => {
  const f = fixture(t), cli = join(f.root, 'kicad-cli'), script = join(f.root, 'set-thing.ts');
  writeFileSync(cli, FAKE_CLI); chmodSync(cli, 0o755);
  writeFileSync(script, `import {saveBoardInPlace} from ${JSON.stringify(tools('lib/board-edit.ts'))}; saveBoardInPlace(process.argv[2]!, '(kicad_pcb (edited))');`);
  writeFileSync(f.pcb, 'edited in KiCad');
  const call = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', script, f.pcb], { encoding: 'utf8', env: { ...process.env, KICAD_CLI: cli } });
  assert.notEqual(call.status, 0);
  assert.match(call.stderr, /changed outside our tools/);
  assert.equal(readFileSync(f.pcb, 'utf8'), 'edited in KiCad');
});

test('a plain file writer keeps the seal and a tampered board stops it', t => {
  const f = fixture(t);
  const done = run(tools('silk_refs.ts'), f.pcb);
  assert.equal(done.status, 0, done.stderr);
  assert.match(readFileSync(f.pcb, 'utf8'), /F\.Fab/);
  verifySeal(f.root, 'X');
  assert.equal(f.log().at(-1).tool, 'silk_refs');
  writeFileSync(f.pcb, SILK);
  const refused = run(tools('silk_refs.ts'), f.pcb);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr + refused.stdout, /changed outside our tools/);
  assert.equal(readFileSync(f.pcb, 'utf8'), SILK);
});

test('repairFile and set_stackup keep the seal', t => {
  const uuid = '11111111-2222-4333-8444-555555555555';
  const layers = '(kicad_pcb\n\t(layers\n\t\t(0 "F.Cu" signal)\n\t\t(2 "B.Cu" signal)\n\t)\n\t(setup\n\t)\n';
  const f = fixture(t, `${layers}\t(zone (uuid "${uuid}"))\n\t(zone (uuid "${uuid}"))\n)\n`);
  assert.equal(repairFile(f.pcb).replaced, 1);
  verifySeal(f.root, 'X');
  const done = run(tools('set_stackup.ts'), f.pcb);
  assert.equal(done.status, 0, done.stderr);
  verifySeal(f.root, 'X');
  assert.equal(f.log().at(-1).tool, 'set_stackup');
});
