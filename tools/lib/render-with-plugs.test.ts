import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addModel, footprints, mergeMaps, plugsFromBom, plugsFromSpec, plugTransform } from '../render_with_plugs.ts';

const BOM = `Designator,Function,MPN,Manufacturer,LCSC,Package
J1,RELAY LINK from INPUT-4D2A J2,WJ15EDGRC-3.81-04P-14-00A,Kangnex,C7245,"3.81 mm header"
P1,Mating plug for J1 (loose),WJ15EDGK-3.81-04P-14-00A,Kangnex,C7244,3.81 mm plug
"J3,J4","Mains terminals, 4 poles",WJ2EDGRC-5.08-04P-14-00A,Kangnex,C8446,"5.08 mm pluggable header"
"P3,P4",Mating plugs for J3/J4 (loose),WJ2EDGK-5.08-04P-14-00A,Kangnex,C71372,5.08 mm pluggable plug
J5,Fan connector,530470310,MOLEX,C122442,P=1.25mm
`;

const SPEC = `| Ref | Part | Pins |
| --- | --- | --- |
| J1 "24V IN" | MX2EDGRC-5.08-02P C5188019 (5.08 mm pluggable, right angle), loose plug P1 MX2EDGK-5.08-02P C5187912 | 1 +24 V |
| J2-J21 | MX15EDGRC-3.5-02P C5188295 (3.5 mm pluggable), loose plugs MX15EDGK-3.5-02P C5188249 | 1 24 V |
| J3 | MX15EDGRC-3.5-08P C5188301, plug P3 MX15EDGK-3.5-08P C5188255 | 1 24V_S |
| P3, P4 | Loose plugs 8P (not PCBA) | MX15EDGK-3.5-08P-GN01-Cu-Y-A | C5188255 | Extended |
| Mains terminals | 2 x 4-pole 5.08 mm pluggable (C8446 + C71372) |
`;

const FOOTPRINT = `\t(footprint "iot-lab:C7245"
\t\t(layer "F.Cu")
\t\t(at 120.77 108.1 180)
\t\t(pad "1" thru_hole rect
\t\t\t(at -5.72 0 180)
\t\t)
\t\t(pad "4" thru_hole circle
\t\t\t(at 5.72 0 180)
\t\t)
\t\t(fp_rect
\t\t\t(start -8.31 -1.85)
\t\t\t(end 8.31 7.8)
\t\t\t(layer "F.CrtYd")
\t\t)
\t\t(model "\${IOT_LAB}/x/C7245.step"
\t\t\t(offset
\t\t\t\t(xyz 0 -2.98 0)
\t\t\t)
\t\t)
\t)
`;
const BOARD = `(kicad_pcb\n${FOOTPRINT})`;

test('the BOM maps each header to its plug', () => {
  assert.deepEqual(plugsFromBom(BOM), new Map([['C7245', 'C7244'], ['C8446', 'C71372']]));
});

test('a SPEC table cell maps a header to its plug', () => {
  assert.deepEqual(plugsFromSpec(SPEC), new Map([['C5188019', 'C5187912'], ['C5188295', 'C5188249'], ['C5188301', 'C5188255']]));
});

test('merging rejects two plugs for one header', () => {
  const one = new Map([['C1', 'C2']]);
  assert.deepEqual(mergeMaps(one, new Map([['C1', 'C2'], ['C3', 'C4']])), new Map([['C1', 'C2'], ['C3', 'C4']]));
  assert.throws(() => mergeMaps(one, new Map([['C1', 'C9']])), /two plugs C2 and C9/);
});

test('footprints gives the header code and geometry', () => {
  const [footprint, ...others] = footprints(BOARD);
  assert.equal(others.length, 0);
  assert.equal(footprint!.code, 'C7245');
  assert.deepEqual(footprint!.padX, [-5.72, 5.72]);
  assert.deepEqual(footprint!.courtyard, [-8.31, -1.85, 8.31, 7.8]);
});

test('addModel inserts before the end of the footprint', () => {
  const out = addModel(BOARD, footprints(BOARD)[0]!, '/p/plug.step', { offset: [0, -7.55, -1.55], rotation: 180 });
  assert.equal(out.split('(model ').length - 1, 2);
  assert.ok(out.includes('(model "/p/plug.step" (offset (xyz 0 -7.55 -1.55)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 180)))\n\t)'));
  assert.ok(out.endsWith(')'));
});

test('an opening on footprint +y turns the plug', () => {
  assert.deepEqual(plugTransform([-8.31, -1.85, 8.31, 7.8], [-5.72, 5.72], -1.55), { offset: [0, -7.55, -1.55], rotation: 180 });
});

test('an opening on footprint -y keeps the plug', () => {
  assert.deepEqual(plugTransform([-2, -9, 5.5, 1.5], [0, 3.5], 0.5), { offset: [1.75, 8.75, 0.5], rotation: 0 });
});
