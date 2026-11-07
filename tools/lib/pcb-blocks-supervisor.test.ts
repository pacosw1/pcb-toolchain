import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { iotrouteMissing } from './iotroute-bin.ts';
import { status } from './pcb-runs.ts';
import { readPyJson, sha256File } from './json-file.ts';
import { verify as verifyEvidence } from './pcb-evidence.ts';
import { verifyBinding, type Binding } from './block-bindings.ts';
import { fingerprint } from './fingerprint.ts';

test('direct blocks CLI supervises the real inventory backend and seals its evidence', { skip: iotrouteMissing() }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pcb-blocks-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = fileURLToPath(new URL('..', import.meta.url));
  symlinkSync(tools, join(root, 'tools'));
  const call = spawnSync(join(tools, 'pcb'), ['--project', root, 'blocks', '--detach', '--json', 'inventory', 'UNKNOWN'], { encoding: 'utf8' });
  assert.equal(call.status, 0, call.stderr || call.stdout);
  const state = JSON.parse(call.stdout), folder = join(root, '.gate/cli', state.run_id);
  assert.equal(state.board, 'BLOCKS');
  for (let i = 0; i < 200; i++) {
    const observed = status(folder);
    if (['passed', 'failed', 'error', 'cancelled', 'timeout'].includes(String(observed.get('status'))) && observed.get('controller_alive') !== true) break;
    await delay(100);
  }
  const result = JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8'));
  assert.equal(result.scope, 'block_evidence');
  assert.equal(result.operation, 'blocks');
  assert.equal(result.cleanup.complete, true);
  const manifest = JSON.parse(readFileSync(join(folder, 'run.json'), 'utf8'));
  assert.deepEqual(manifest.arguments, ['inventory', 'UNKNOWN']);
  assert.match(readFileSync(join(folder, 'operation/blocks.log'), 'utf8'), /UNKNOWN/);
  assert.ok(result.evidence_sha256['operation/result.json']);
});

test('owned block bind returns a sealed draft artifact and rejects changed identity', { skip: iotrouteMissing() }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pcb-block-bind-')));t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = fileURLToPath(new URL('..', import.meta.url));symlinkSync(tools, join(root, 'tools'));
  const source = join(root, 'hardware-design/blocks/iot-lab.kicad_blocks/MODULE.kicad_block');mkdirSync(source, { recursive: true });
  const fp = (ref: string, path: string, net: string, xy: string, angle: number) => `(footprint "Lib:Exact" (layer "F.Cu") (at ${xy} ${angle})
    (path "${path}") (property "Reference" "${ref}") (property "Value" "1k") (property "MPN" "ABC") (property "LCSC" "C123")
    (attr smd) (pad "1" smd rect (at 0 0 ${angle}) (size 1 2) (layers "F.Cu" "F.Paste" "F.Mask") (net "${net}")))`;
  writeFileSync(join(source, 'MODULE.kicad_pcb'), `(kicad_pcb ${fp('R1', '/one', 'A', '2 3', 90)}${fp('R2', '/two', 'B', '5 8', 0)})`);
  const target = join(root, 'target.kicad_pcb');
  const targetText = `(kicad_pcb ${fp('R7', '/instance/one', 'X', '13 18', 180)}${fp('R8', '/instance/two', 'Y', '18 15', 90)})`;
  writeFileSync(target, targetText);
  for (const stem of [join(source, 'MODULE'), target.slice(0, -'.kicad_pcb'.length)]) for (const ext of ['.kicad_sch', '.kicad_pro', '.kicad_dru']) writeFileSync(stem + ext, '{}');
  writeFileSync(join(source, 'facts.json'), JSON.stringify({ level: 2, gates: 'historical only', ports: [], open_items: ['synthetic fixture, unqualified'] }));
  const call = async () => {
    const started = spawnSync(join(tools, 'pcb'), ['--project', root, 'blocks', '--detach', '--json', 'bind', 'MODULE', target, '--instance', '/instance'], { encoding: 'utf8' });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const state = JSON.parse(started.stdout), folder = join(root, '.gate/cli', state.run_id);
    for (let i = 0; i < 200; i++) {
      const current = status(folder);
      if (['passed', 'failed', 'error', 'timeout'].includes(String(current.get('status'))) && current.get('controller_alive') !== true) break;
      await delay(100);
    }
    return { folder, result: JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8')) };
  };
  const { folder, result } = await call(), artifact = join(folder, 'operation/binding.json');
  assert.equal(result.status, 'passed');assert.equal(result.scope, 'block_evidence');assert.equal(result.cleanup.complete, true);
  assert.equal(result.qualified, false);assert.equal(result.copper_reuse_approved, false);
  assert.equal(result.binding_artifact, artifact);assert.equal(result.binding_file_sha256, sha256File(artifact));
  assert.equal(result.evidence_sha256['operation/binding.json'], sha256File(artifact));
  const binding = readPyJson<Binding>(artifact), fresh = verifyBinding(binding);verifyEvidence(folder);
  assert.equal(result.binding_sha256, fingerprint(binding));
  assert.deepEqual(Object.fromEntries(fresh.refs), { R1: 'R7', R2: 'R8' });
  writeFileSync(target, targetText.replace('(property "MPN" "ABC")', '(property "MPN" "WRONG")'));
  assert.throws(() => verifyBinding(binding), /part|identity|binding|MPN|match/);
  const rejected = await call();assert.notEqual(rejected.result.status, 'passed');
  assert.equal(existsSync(join(rejected.folder, 'operation/binding.json')), false);
  writeFileSync(artifact, '{}');assert.throws(() => verifyEvidence(folder), /evidence changed/);
});

test('owned bind refuses caller-controlled output before starting a run', t => {
  const root = mkdtempSync(join(tmpdir(), 'pcb-bind-output-'));t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = fileURLToPath(new URL('..', import.meta.url)), output = join(root, 'keep');writeFileSync(output, 'reviewed');
  const call = spawnSync(join(tools, 'pcb'), ['--project', root, 'blocks', 'bind', 'X', 'target', '--instance', '/x', '--output', output], { encoding: 'utf8' });
  assert.notEqual(call.status, 0);assert.match(call.stderr, /output.*owned/);assert.equal(readFileSync(output, 'utf8'), 'reviewed');
  assert.equal(existsSync(join(root, '.gate/cli')), false);
});
