// Pose and copper counterexamples for native placement verification.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { footprints, footprintSignature, type Footprint } from './native-board.ts';
import { verifyPreserved, type PlacementProblem, type UnitPose } from './native-placement.ts';

const PCB = `(kicad_pcb (version 20260101)
 (footprint "R" (at 2 5) (property "Reference" "A") (uuid "a"))
 (footprint "R" (at 8 5) (property "Reference" "B" (at 0 0)) (uuid "b")
  (pad "1" smd rect (at 1 0) (size .5 .8) (net "N") (uuid "pad")))
 (segment (start 8 5) (end 4 5) (width .2) (layer "F.Cu") (net "N") (uuid "t")))`;
const POSE: UnitPose[] = [[2, 5, 0], [8, 4, 0]];

let root: string, source: string, target: string, problem: PlacementProblem;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'native-placement-'));
  source = join(root, 'input.kicad_pcb');
  target = join(root, 'output.kicad_pcb');
  writeFileSync(source, PCB);
  problem = { units: [{ refs: ['A'], fixed: true, x: 2, y: 5 }, { refs: ['B'], fixed: false, x: 8, y: 5 }] };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const verify = (pose: UnitPose[] = POSE, model = problem) => verifyPreserved(source, target, model, pose);

test('a rigid translation and a quarter turn keep the pad definition and the copper', () => {
  for (const quarter of [0, 1]) {
    let text = PCB.replace('(at 8 5)', `(at 8 4 ${90 * quarter})`);
    if (quarter) text = text.replace('(at 0 0)', '(at 0 0 90)').replace('(at 1 0)', '(at 1 0 90)');
    writeFileSync(target, text);
    assert.deepEqual(verify([[2, 5, 0], [8, 4, quarter]])[0], ['B']);
  }
});

test('native pad, copper, other-footprint and pose tampering is refused', () => {
  const text = PCB.replace('(at 8 5)', '(at 8 4)');
  const changes = [
    text.replace('(net "N") (uuid "pad")', '(net "OTHER") (uuid "pad")'), text.replace('(size .5 .8)', '(size .5 .9)'),
    text.replace('(width .2)', '(width .3)'), text.replace('(at 2 5)', '(at 3 5)'), text.replace('(at 8 4)', '(at 8 4.000001)'),
  ];
  for (const changed of changes) {
    writeFileSync(target, changed);
    assert.throws(() => verify(), changed);
  }
});

test('native reordering keeps every independent footprint item', () => {
  const original = footprints(source)[1] as Footprint;
  const reordered = { ...original, form: [...original.form.slice(0, 2), ...original.form.slice(2).reverse()] };
  assert.equal(footprintSignature(original), footprintSignature(reordered));
  reordered.form.push(structuredClone(reordered.form[2]) as never);
  assert.notEqual(footprintSignature(original), footprintSignature(reordered));
});

test('a locked footprint and owned board geometry are not exempted', () => {
  writeFileSync(source, PCB.replace('(uuid "b")', '(locked yes) (uuid "b")'));
  writeFileSync(target, PCB.replace('(uuid "b")', '(locked yes) (uuid "b")').replace('(at 8 5)', '(at 8 4)'));
  assert.throws(() => verify(), /locked/);
  writeFileSync(source, PCB);
  writeFileSync(target, PCB.replace('(at 8 5)', '(at 8 4)'));
  for (const name of ['cuts', 'borders', 'zones']) {
    const model = structuredClone(problem);
    (model.units[1] as never as Record<string, unknown>)[name] = ['owned'];
    assert.throws(() => verify(POSE, model), /geometry transform/);
  }
});

test('motion below native precision does not claim a placement change', () => {
  writeFileSync(target, PCB);
  assert.throws(() => verify([[2, 5, 0], [8 + 1e-9, 5, 0]]), /native coordinate precision/);
});

test('a changed footprint membership is refused', () => {
  writeFileSync(target, PCB.replace('"Reference" "A"', '"Reference" "C"'));
  assert.throws(() => verify(), /membership changed/);
});
