import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copperNames, derivedDielectrics, explicitDielectrics, stackupText, withStackup } from '../set_stackup.ts';

const SIX = ['F.Cu', 'In1.Cu', 'In2.Cu', 'In3.Cu', 'In4.Cu', 'B.Cu'];

test('explicit dielectrics alternate prepreg and core from the outside (JLC06161H-7628, D-142)', () => {
  const thicknesses = [0.2104, 0.4, 0.2028, 0.4, 0.2104];
  const dielectrics = explicitDielectrics(thicknesses, SIX.length);
  assert.deepEqual(dielectrics.map(gap => gap.thickness), thicknesses);
  assert.deepEqual(dielectrics.map(gap => gap.kind), ['prepreg', 'core', 'prepreg', 'core', 'prepreg']);
  const all = [...stackupText(SIX, dielectrics).matchAll(/\(thickness ([\d.]+)\)/g)].map(match => match[1]);
  assert.deepEqual(all.slice(1, 12).filter((_, i) => i % 2 === 0), ['0.035', '0.0152', '0.0152', '0.0152', '0.0152', '0.035']);
});

test('a dielectric count that does not fit the copper layers fails', () => {
  assert.throws(() => explicitDielectrics([0.2, 0.4], SIX.length), /2 dielectrics for 6 copper layers/);
});

test('the default four-layer build has outer prepreg and one inner core', () => {
  const dielectrics = derivedDielectrics(4, 0.2104, 1.6);
  assert.deepEqual(dielectrics.map(gap => gap.kind), ['prepreg', 'core', 'prepreg']);
  assert.equal(dielectrics[1]!.thickness, 1.0588);
});

test('a two-layer board is one core', () => {
  assert.deepEqual(derivedDielectrics(2, 0.2104, 1.6).map(gap => [gap.kind, gap.thickness]), [['core', 1.51]]);
});

test('copper names come from the layers list, top to bottom', () => {
  const board = '(kicad_pcb\n\t(layers\n\t\t(0 "F.Cu" signal)\n\t\t(2 "B.Cu" signal)\n\t\t(6 "In2.Cu" power)\n'
    + '\t\t(4 "In1.Cu" mixed)\n\t\t(9 "F.Adhes" user "F.Adhesive")\n\t)\n)\n';
  assert.deepEqual(copperNames(board), ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);
});

test('withStackup adds a missing stackup as the first child of the setup', () => {
  const added = withStackup('(kicad_pcb\n\t(setup\n\t\t(pad_to_mask_clearance 0)\n\t)\n)\n', '\t\t(stackup\n\t\t)');
  assert.equal(added, '(kicad_pcb\n\t(setup\n\t\t(stackup\n\t\t)\n\t\t(pad_to_mask_clearance 0)\n\t)\n)\n');
});

test('withStackup leaves an old stackup behind the new one: the known bug of set_stackup.py, kept for equal bytes', () => {
  const board = '(kicad_pcb\n\t(setup\n\t\t(stackup 1)\n\t)\n)\n';
  assert.equal(withStackup(board, '\t\t(stackup 2)'), '(kicad_pcb\n\t(setup\n\t\t(stackup 2)\t(stackup 1)\n\t)\n)\n');
});
