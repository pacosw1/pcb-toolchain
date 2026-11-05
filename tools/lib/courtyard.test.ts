import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { refresh, urlUuid5 } from '../refresh_courtyards.ts';
import { courtyardBox, setCourtyard } from './courtyard.ts';
import { formatG } from './py-numbers.ts';

const FOOTPRINT = `(footprint "X"
  (fp_line (start -3 -1) (end 3 -1) (layer F.Fab) (width 0.1))
  (fp_line (start -9 -9) (end 9 9) (layer F.Cu) (width 0.1))
  (pad 1 smd rect (at -3.5 0 90) (size 2 1) (layers F.Cu F.Paste F.Mask))
  (fp_rect (start -5.25 -2.25) (end 5.25 2.25) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd"))
  (fp_line (start -6 -3) (end 6 -3) (layer F.CrtYd) (width 0.05))
  (model "\${IOT_LAB}/x/part.wrl"
    (offset (xyz 1 1 0))
    (scale (xyz 1 1 1))
    (rotate (xyz 0 0 0))
  )
)`;

const LIBRARY = `(module easyeda2kicad:C0603 (layer F.Cu)
\t(pad 1 smd rect (at -0.7 0 0) (size 0.8 0.9) (layers F.Cu F.Paste F.Mask))
\t(fp_rect (start -1.35 -0.7) (end 1.35 0.7) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd"))
  (model "x.step")
)`;

const BOARD = `(kicad_pcb
\t(footprint "iot-lab:C1"
\t\t(layer "F.Cu")
\t\t(uuid "11111111-1111-1111-1111-111111111111")
\t\t(at 10 20 90)
\t\t(property "Reference" "C5"
\t\t\t(at 0 -1 0)
\t\t)
\t\t(fp_line
\t\t\t(start -1 -1)
\t\t\t(end 1 -1)
\t\t\t(stroke
\t\t\t\t(width 0.12)
\t\t\t\t(type solid)
\t\t\t)
\t\t\t(layer "F.SilkS")
\t\t\t(uuid "22222222-2222-2222-2222-222222222222")
\t\t)
\t\t(fp_rect
\t\t\t(start -1.64 -0.96)
\t\t\t(end 1.64 0.96)
\t\t\t(stroke
\t\t\t\t(width 0.05)
\t\t\t\t(type solid)
\t\t\t)
\t\t\t(fill no)
\t\t\t(layer "F.CrtYd")
\t\t\t(uuid "33333333-3333-3333-3333-333333333333")
\t\t)
\t\t(fp_circle
\t\t\t(center 0 0)
\t\t\t(end 1.25 0)
\t\t\t(stroke
\t\t\t\t(width 0.05)
\t\t\t\t(type solid)
\t\t\t)
\t\t\t(fill no)
\t\t\t(layer "F.CrtYd")
\t\t\t(uuid "44444444-4444-4444-4444-444444444444")
\t\t)
\t\t(pad "1" smd rect
\t\t\t(at -0.7 0 90)
\t\t\t(size 0.8 0.9)
\t\t\t(layers "F.Cu" "F.Paste" "F.Mask")
\t\t)
\t\t(model "x.step"
\t\t\t(offset
\t\t\t\t(xyz 0 0 0)
\t\t\t)
\t\t)
\t)
\t(footprint "MountingHole:MH"
\t\t(layer "F.Cu")
\t\t(uuid "55555555-5555-5555-5555-555555555555")
\t\t(fp_circle
\t\t\t(center 0 0)
\t\t\t(end 3 0)
\t\t\t(layer "F.CrtYd")
\t\t)
\t)
)
`;

function library(): string {
  const lib = mkdtempSync(join(tmpdir(), 'courtyard-'));
  writeFileSync(join(lib, 'C1.kicad_mod'), LIBRARY);
  return lib;
}

const withoutCourtyard = (text: string) => text.split('\n').filter(line => !line.includes('CrtYd'));

test('setCourtyard replaces every courtyard item and nothing else', () => {
  const out = setCourtyard(FOOTPRINT, [-4.25, -1.25, 4.25, 1.25]);
  assert.equal(out.split('CrtYd').length - 1, 1);
  assert.ok(out.includes('(fp_rect (start -4.25 -1.25) (end 4.25 1.25) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd"))'));
  assert.ok(out.indexOf('F.CrtYd') < out.indexOf('(model'));
  assert.deepEqual(withoutCourtyard(out), withoutCourtyard(FOOTPRINT));
  assert.equal(setCourtyard(out, [-4.25, -1.25, 4.25, 1.25]), out);
});

test('setCourtyard adds a courtyard to a footprint without one', () => {
  const bare = withoutCourtyard(FOOTPRINT).join('\n');
  assert.equal(setCourtyard(bare, [0, 0, 1, 1]).split('F.CrtYd').length - 1, 1);
});

test('courtyardBox covers every courtyard item and only those', () => {
  assert.deepEqual(courtyardBox(FOOTPRINT), [-6, -3, 6, 2.25]);
  assert.equal(courtyardBox('(footprint "X"\n)'), null);
});

test('refresh replaces only the courtyard of iot-lab footprints', () => {
  const { text, rows } = refresh(BOARD, library());
  assert.deepEqual(rows, [{ ref: 'C5', code: 'C1', old: [-1.64, -0.96, 1.64, 0.96], box: [-1.35, -0.7, 1.35, 0.7] }]);
  assert.ok(!text.includes('33333333') && !text.includes('44444444'));
  assert.ok(text.includes('(fp_rect (start -1.35 -0.7) (end 1.35 0.7) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd") (uuid "'));
  assert.ok(text.includes('(end 3 0)\n\t\t\t(layer "F.CrtYd")'));
  const old = new Set(withoutCourtyard(BOARD));
  assert.ok(withoutCourtyard(text).every(line => old.has(line)));
});

test('refresh is deterministic and idempotent', () => {
  const lib = library();
  const { text } = refresh(BOARD, lib);
  assert.equal(refresh(BOARD, lib).text, text);
  assert.equal(refresh(text, lib).text, text);
});

test('refresh stops on a bottom-side footprint and on a missing library footprint', () => {
  const lib = library();
  assert.throws(() => refresh(BOARD.replace('(layer "F.Cu")\n\t\t(uuid "1111', '(layer "B.Cu")\n\t\t(uuid "1111'), lib), /not on F\.Cu/);
  assert.throws(() => refresh(BOARD.replaceAll('iot-lab:C1', 'iot-lab:C9'), lib), /no library footprint/);
});

test('urlUuid5 sets the version and variant bits of a name-based uuid', () => {
  assert.match(urlUuid5('crtyd:x'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('formatG prints as Python :g does', () => {
  const cases: [number, string][] = [[0, '0'], [-4.25, '-4.25'], [100, '100'], [1234.5678, '1234.57'], [0.0001, '0.0001'],
    [0.00001234, '1.234e-05'], [1234567, '1.23457e+06'], [999999.5, '1e+06'], [1.35, '1.35']];
  for (const [value, text] of cases) assert.equal(formatG(value), text);
});
