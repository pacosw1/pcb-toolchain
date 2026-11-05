import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, test } from 'node:test';
import { find, reuse, snapshot, targetPlan } from './block-reuse.ts';

let library: string, block: string;

beforeEach(() => {
  library = mkdtempSync(join(tmpdir(), 'block-reuse-'));
  block = join(library, 'USB.kicad_block');
  mkdirSync(block);
  writeFileSync(join(block, 'USB.json'), JSON.stringify({ description: 'USB sink', keywords: 'ESD' }));
  writeFileSync(join(block, 'facts.json'), JSON.stringify({
    level: 2, gates: 'historical pass', ports: [{ name: 'VBUS', limits: '5 V' }], open_items: ['recheck stock'],
  }));
  writeFileSync(join(block, 'USB.kicad_pcb'), '(kicad_pcb\n\t(footprint "Package:X"\n\t\t(property "Reference" "U1")\n\t\t(property "MPN" "ABC")\n\t)\n)');
  writeFileSync(join(block, 'USB.kicad_sch'), '(kicad_sch)');
  writeFileSync(join(block, 'USB.kicad_pro'), '{}');
});
afterEach(() => rmSync(library, { recursive: true, force: true }));

test('a historical claim is not promoted', () => {
  const row = reuse(library, 'USB');
  assert.equal(row.declared_level, 2);
  assert.equal(row.qualification, 'unverified_for_target');
  assert.deepEqual(row.open_items, ['recheck stock']);
});

test('a rule change invalidates a proposal; GUI state does not', () => {
  const old = reuse(library, 'USB').source_sha256;
  writeFileSync(join(block, 'USB.kicad_prl'), 'new window');
  assert.equal(reuse(library, 'USB', old).source_sha256, old);
  writeFileSync(join(block, 'USB.kicad_dru'), '(version 1)');
  assert.throws(() => reuse(library, 'USB', old), /stale/);
});

test('the digest hashes the file table as sorted json.dumps text', () => {
  rmSync(block, { recursive: true });
  mkdirSync(block);
  writeFileSync(join(block, 'b.json'), '{}');
  writeFileSync(join(block, 'a.json'), '[]');
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  const table = `{"a.json": "${sha('[]')}", "b.json": "${sha('{}')}"}`;
  assert.equal(snapshot(block).digest, sha(table));
  assert.deepEqual([...snapshot(block).files.keys()], ['a.json', 'b.json']);
});

test('filters and the explanation of a match', () => {
  const rows = find(library, 'usb esd', 'abc', 'Package:X');
  assert.deepEqual(rows.map(row => row.id), ['USB']);
  assert.deepEqual(rows[0]?.matches.get('esd'), ['keywords']);
  assert.deepEqual(find(library, 'usb', 'other'), []);
});

test('missing CAD and level stay unknown', () => {
  unlinkSync(join(block, 'USB.kicad_sch'));
  unlinkSync(join(block, 'facts.json'));
  const row = reuse(library, 'USB');
  assert.equal(row.declared_level, null);
  assert.deepEqual(row.missing_files, ['USB.kicad_sch']);
  assert.ok(row.facts_errors.length);
});

test('a library behind a symlink records its real path, and CRLF text parses', () => {
  const link = `${library}-link`;
  symlinkSync(library, link);
  try {
    writeFileSync(join(block, 'USB.kicad_pcb'), '(kicad_pcb\r\n\t(footprint "Package:X"\r\n\t\t(property "Reference" "U1")\r\n\t)\r\n)');
    const row = reuse(link, 'USB');
    assert.equal(row.source_directory, join(realpathSync(library), 'USB.kicad_block'));
    assert.deepEqual(row.parts.map(part => part.ref), ['U1']);
  } finally {
    rmSync(link);
  }
});

test('a path escape is refused', () => {
  assert.throws(() => reuse(library, '../USB'), /invalid block ID/);
});

test('an external dependency is not silently hashed', () => {
  const outside = join(library, 'external.kicad_sym');
  writeFileSync(outside, 'external');
  symlinkSync(outside, join(block, 'external.kicad_sym'));
  assert.throws(() => reuse(library, 'USB'), /external/);
});

test('a target plan refuses changed requirements and a wrong mapping', () => {
  const requirements = join(library, 'SPEC.md'), manifest = join(library, 'target.json');
  writeFileSync(requirements, 'USB input');
  writeFileSync(manifest, JSON.stringify({ inputs: ['SPEC.md'] }));
  const plan = targetPlan(library, 'USB', manifest);
  assert.deepEqual(plan.unmapped_ports, ['VBUS']);
  plan.port_map.set('VBUS', '+5V_USB');
  const checked = targetPlan(library, 'USB', manifest, plan);
  assert.deepEqual(checked.unmapped_ports, []);
  assert.equal(checked.qualification, 'unverified_for_target');
  plan.port_map.set('extra', 'GND');
  assert.throws(() => targetPlan(library, 'USB', manifest, plan), /exactly/);
  writeFileSync(requirements, 'Different input');
  assert.throws(() => targetPlan(library, 'USB', manifest, plan), /stale/);
});

test('a target plan refuses a changed block', () => {
  const manifest = join(library, 'target.json');
  writeFileSync(manifest, JSON.stringify({ inputs: ['USB.kicad_block/USB.kicad_pcb'] }));
  const plan = targetPlan(library, 'USB', manifest);
  writeFileSync(join(block, 'USB.kicad_dru'), '(version 1)');
  assert.throws(() => targetPlan(library, 'USB', manifest, plan), /stale/);
});
