import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { attachToUnits, bindInstance, verifyBinding } from './block-bindings.ts';
import { footprints, footprintSignature } from './native-board.ts';

const fp = (ref: string, uid: string, net: string, xy: string, angle: number) => `(footprint "Lib:Exact" (layer "F.Cu") (at ${xy} ${angle})
  (path "${uid}") (property "Reference" "${ref}") (property "Value" "1k")
  (property "MPN" "ABC") (property "LCSC" "C123")
  (attr smd) (pad "1" smd rect (at 0 0 ${angle}) (size 1 2)
    (layers "F.Cu" "F.Paste" "F.Mask") (net "${net}") (uuid "${ref}-pad")))`;

let root: string, block: string, target: string, targetText: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'block-bindings-'));
  block = join(root, 'MODULE.kicad_block');
  mkdirSync(block);
  const source = join(block, 'MODULE.kicad_pcb');
  target = join(root, 'target.kicad_pcb');
  targetText = `(kicad_pcb ${fp('R7', '/instance/one', 'X', '13 18', 180)}${fp('R8', '/instance/two', 'Y', '18 15', 90)})`;
  writeFileSync(source, `(kicad_pcb ${fp('R1', '/one', 'A', '2 3', 90)}${fp('R2', '/two', 'B', '5 8', 0)})`);
  writeFileSync(target, targetText);
  for (const base of [join(block, 'MODULE'), join(root, 'target')]) {
    for (const extension of ['.kicad_sch', '.kicad_pro', '.kicad_dru']) writeFileSync(base + extension, '{}');
  }
  writeFileSync(join(block, 'facts.json'), JSON.stringify({ level: 0, ports: [], open_items: ['not bench verified'] }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const bind = () => bindInstance(block, target, '/instance');

test('an exact rigid rotated instance binds', () => {
  const binding = bind();
  assert.deepEqual(Object.fromEntries(binding.refs), { R1: 'R7', R2: 'R8' });
  assert.deepEqual(Object.fromEntries(binding.net_map), { A: 'X', B: 'Y' });
  assert.deepEqual(binding.transform, { rotation_quarters: 1, translation_mm: ['10', '20'] });
  assert.equal(binding.qualified, false);
  assert.equal(binding.copper_reuse_approved, false);
  assert.equal(binding.declared_level, 0);
});

test('part, pad and relative pose changes fail early', () => {
  for (const [from, to] of [['(property "MPN" "ABC")', '(property "MPN" "OTHER")'], ['(size 1 2)', '(size 1 1)'], ['(at 13 18 180)', '(at 13.1 18 180)']]) {
    writeFileSync(target, targetText.replace(from as string, to as string));
    assert.throws(bind);
  }
});

test('a missing component and collapsed nets are refused', () => {
  for (const [from, to] of [['"/instance/two"', '"/another/two"'], ['(net "Y")', '(net "X")']]) {
    writeFileSync(target, targetText.replaceAll(from as string, to as string));
    assert.throws(bind);
  }
});

test('a rule or source revision invalidates a binding', () => {
  const first = bind();
  verifyBinding(first);
  writeFileSync(join(root, 'target.kicad_dru'), 'new rule');
  assert.throws(() => verifyBinding(first), /stale/);
  const second = bind();
  writeFileSync(join(block, 'facts.json'), '{"level":1}');
  assert.throws(() => verifyBinding(second), /stale/);
});

test('a binding read back from JSON still verifies', () => {
  const binding = bind();
  const stored = JSON.parse(JSON.stringify({
    ...binding, refs: Object.fromEntries(binding.refs), net_map: Object.fromEntries(binding.net_map),
    target_inputs: Object.fromEntries(binding.target_inputs),
  }));
  assert.doesNotThrow(() => verifyBinding(stored));
});

test('a footprint signature ignores a rigid pose but not a changed definition', () => {
  const board = (text: string) => {
    writeFileSync(join(root, 'sig.kicad_pcb'), `(kicad_pcb ${text})`);
    return footprintSignature(footprints(join(root, 'sig.kicad_pcb'))[0] as never);
  };
  const base = board(fp('R1', '/a', 'N', '1 2', 90));
  assert.equal(base, board(fp('R1', '/a', 'N', '9 7', 90)));
  assert.notEqual(base, board(fp('R1', '/a', 'M', '1 2', 90)));
});

test('a fresh binding attaches to its one intact unit and the input stays as it was', () => {
  const binding = bind();
  const problem = { board_file: target, units: [{ name: 'module', refs: ['R7', 'R8'] }] };
  const result = attachToUnits(problem, [binding]);
  assert.equal(result.block_bindings[0]?.unit, 'module');
  assert.deepEqual(result.block_bindings[0]?.refs, ['R7', 'R8']);
  assert.ok(!('block_bindings' in problem));
  assert.throws(() => attachToUnits(problem, [binding, binding]), /distinct intact/);
});

test('split units or a wrong target cannot claim block reuse', () => {
  const binding = bind();
  for (const problem of [
    { board_file: target, units: [{ name: 'a', refs: ['R7'] }, { name: 'b', refs: ['R8'] }] },
    { board_file: '/different.kicad_pcb', units: [{ name: 'module', refs: ['R7', 'R8'] }] },
  ]) assert.throws(() => attachToUnits(problem, [binding]));
});
