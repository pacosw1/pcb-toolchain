import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { aligned, bodyBox, courtyard, fabBox, model, padsBox, place } from '../fp_courtyard.ts';
import { setCourtyard, type Box } from './courtyard.ts';
import { kicadCli } from './env.mjs';
import { projectRoot } from './project-root.mjs';
import { stepBox, stepCandidates, stlBox } from './step-box.ts';

const FP = `(footprint "X"
  (fp_line (start -3 -1) (end 3 -1) (layer F.Fab) (width 0.1))
  (fp_line (start -3 1) (end 3 1) (layer F.Fab) (width 0.1))
  (fp_line (start -5 -2) (end 5 2) (layer F.SilkS) (width 0.1))
  (fp_line (start -9 -9) (end 9 9) (layer F.Cu) (width 0.1))
  (pad 1 smd rect (at -3.5 0 90) (size 2 1) (layers F.Cu F.Paste F.Mask))
  (pad 2 thru_hole circle (at 3.5 0) (size 1 1) (drill 0.5) (layers *.Cu *.Mask))
  (fp_rect (start -5.25 -2.25) (end 5.25 2.25) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd"))
  (fp_line (start -6 -3) (end 6 -3) (layer F.CrtYd) (width 0.05))
  (model "\${IOT_LAB}/x/part.wrl"
    (offset (xyz 1 1 0))
    (scale (xyz 1 1 1))
    (rotate (xyz 0 0 0))
  )
)`;
const NO_FAB = FP.replaceAll('(layer F.Fab)', '(layer F.SilkS)');
const RAW: Box = [0, 0, 2, 1];
const noStep = () => null;
const sources = (box: Box | null) => ({ stepBox: () => box, bodies: {}, env: {}, root: '/r' });

test('a STEP box goes to the footprint with its offset and y flipped', () => {
  assert.deepEqual(place(RAW, { offset: [1, 1], scale: 1, rotation: 0 }), [1, -2, 3, -1]);
});

test('a STEP box turns as KiCad turns it: rotate z by -rotation, then the offset', () => {
  assert.deepEqual(place(RAW, { offset: [0, 0], scale: 1, rotation: 180 }), [-2, 0, 0, 1]);
  assert.deepEqual(place(RAW, { offset: [0, 0], scale: 1, rotation: 90 }), [0, 0, 1, 2]);
});

test('a STEP box scales', () => {
  assert.deepEqual(place(RAW, { offset: [0, 0], scale: 2, rotation: 0 }), [0, -2, 4, 0]);
});

test('the pad box uses the rotation of each pad', () => {
  assert.deepEqual(padsBox(FP), [-4, -1, 4, 1]);
});

test('the fab outline leaves out circles and text', () => {
  const circle = FP.replace('(pad 1', '(fp_circle (center 0 5) (end 0 6) (layer F.Fab) (width 0.1))\n  (pad 1');
  assert.deepEqual(fabBox(circle), [-3, -1, 3, 1]);
  assert.equal(fabBox(NO_FAB), null);
});

test('a model path expands IOT_LAB, and its STEP files come first', () => {
  const found = model(FP, { IOT_LAB: '/r' });
  assert.deepEqual(found, { path: '/r/x/part.wrl', offset: [1, 1], scale: 1, rotation: 0 });
  assert.deepEqual(stepCandidates(found!.path), ['/r/x/part.step', '/r/x/part.stp', '/r/x/part.wrl']);
});

test('a model with an uneven scale or a tilt is refused', () => {
  assert.throws(() => model(FP.replace('(scale (xyz 1 1 1))', '(scale (xyz 1 2 1))'), {}, '/r'), /uniform scale/);
  assert.throws(() => model(FP.replace('(rotate (xyz 0 0 0))', '(rotate (xyz 90 0 0))'), {}, '/r'), /uniform scale/);
});

test('an aligned STEP body wins', () => {
  // raw x -3.5..1.5, y -0.5..0.5, offset (1, 1): x -2.5..2.5, y -1.5..-0.5
  assert.deepEqual(bodyBox(FP, sources([-3.5, -0.5, 1.5, 0.5])), { box: [-2.5, -1.5, 2.5, -0.5], source: 'step' });
});

test('a misaligned STEP body falls back to the fab outline', () => {
  assert.deepEqual(bodyBox(FP, sources([10, 10, 12, 12])), { box: [-3, -1, 3, 1], source: 'fab (step misaligned)' });
});

test('with no STEP and no fab outline the datasheet body is used', () => {
  const found = bodyBox(NO_FAB, { stepBox: noStep, bodies: { C1: { body: [-1, -1, 1, 1] } }, key: 'C1', env: {}, root: '/r' });
  assert.deepEqual(found, { box: [-1, -1, 1, 1], source: 'datasheet' });
});

test('no body source fails', () => {
  assert.throws(() => bodyBox(NO_FAB, sources(null)), /no body source/);
});

test('alignment allows leads under the pads, not a body past the silk', () => {
  assert.equal(aligned([-4.4, -1, 4.4, 1], FP), true);
  assert.equal(aligned([-4, -1, 4, 3], FP), false);
});

test('alignment takes a body inside the fab outline', () => {
  const tall = FP.replace('(start -3 1) (end 3 1) (layer F.Fab)', '(start -3 4) (end 3 4) (layer F.Fab)');
  assert.equal(aligned([-3, -1, 3, 4], tall), true);
});

test('the courtyard is pads and body plus the margin, without the silk', () => {
  assert.deepEqual(courtyard(FP, [-2.5, -1.5, 2.5, -0.5], 0.25), [-4.25, -1.75, 4.25, 1.25]);
});

test('the courtyard is never smaller than the pads plus the margin', () => {
  assert.deepEqual(courtyard(FP, [-0.1, -0.1, 0.1, 0.1], 0.25), [-4.25, -1.25, 4.25, 1.25]);
});

test('setting the courtyard replaces every courtyard item and nothing else', () => {
  const out = setCourtyard(FP, [-4.25, -1.25, 4.25, 1.25]);
  assert.equal(out.match(/CrtYd/g)?.length, 1);
  assert.ok(out.includes('(fp_rect (start -4.25 -1.25) (end 4.25 1.25) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd"))'));
  assert.ok(out.indexOf('F.CrtYd') < out.indexOf('(model'));
  const others = (text: string) => text.split('\n').filter(line => !line.includes('CrtYd'));
  assert.deepEqual(others(out), others(FP));
  assert.equal(setCourtyard(out, [-4.25, -1.25, 4.25, 1.25]), out);
});

test('a footprint with no courtyard gets one', () => {
  const bare = FP.split('\n').filter(line => !line.includes('CrtYd')).join('\n');
  assert.equal(setCourtyard(bare, [0, 0, 1, 1]).match(/F\.CrtYd/g)?.length, 1);
});

test('an ASCII STL gives the box of its vertices in x and y', () => {
  const mesh = 'solid \n facet normal 0 0 1\n   outer loop\n     vertex -1.5e+00 2.0e-01 9\n     vertex 3.0e+00 -4.0e-01 -9\n   endloop\n endfacet\nendsolid\n';
  assert.deepEqual(stlBox(mesh), [-1.5, -0.4, 3, 0.2]);
  assert.equal(stlBox('solid \nendsolid\n'), null);
});

const CHIP = join(projectRoot(), 'hardware-design/registry/cad-assets/C14663/C14663.3dshapes/C0603_L1.6-W0.8-H0.8.step');

test('the box of a real 0603 STEP model is the body', { skip: !(existsSync(kicadCli) && existsSync(CHIP)) && 'needs kicad-cli and IOT_LAB' }, () => {
  assert.deepEqual(stepBox(CHIP)!.map(value => Math.round(value * 100) / 100), [-0.8, -0.4, 0.8, 0.4]);
});

test('a model path with no STEP file has no box', t => {
  const dir = mkdtempSync(join(tmpdir(), 'step-box-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'part.wrl'), '');
  assert.equal(stepBox(join(dir, 'part.wrl')), null);
});
