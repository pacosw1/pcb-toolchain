import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refsOffSilk } from '../silk_refs.ts';

const BOARD = `(kicad_pcb
\t(footprint "iot-lab:C1"
\t\t(layer "F.Cu")
\t\t(property "Reference" "C5"
\t\t\t(at 0 -1 0)
\t\t\t(layer "F.SilkS")
\t\t\t(uuid "a")
\t\t)
\t\t(property "Value" "100nF"
\t\t\t(at 0 1 0)
\t\t\t(layer "F.SilkS")
\t\t\t(uuid "b")
\t\t)
\t\t(fp_text user "+"
\t\t\t(at 1 1 0)
\t\t\t(layer "F.SilkS")
\t\t)
\t)
\t(footprint "iot-lab:C2"
\t\t(layer "B.Cu")
\t\t(property "Reference" "J3"
\t\t\t(layer "B.SilkS")
\t\t\t(uuid "c")
\t\t)
\t)
\t(footprint "iot-lab:C3"
\t\t(layer "F.Cu")
\t\t(property "Reference" "U1"
\t\t\t(at 0 -1 0)
\t\t\t(layer "F.Fab")
\t\t\t(uuid "d")
\t\t)
\t)
\t(gr_text "RS-485"
\t\t(at 5 5 0)
\t\t(layer "F.SilkS")
\t)
)
`;

test('references on silk go to the Fab layer of their side, with or without an (at) line', () => {
  const { text, moved } = refsOffSilk(BOARD);
  assert.equal(moved, 2);
  assert.match(text, /"C5"\n\t\t\t\(at 0 -1 0\)\n\t\t\t\(layer "F\.Fab"\)/);
  assert.match(text, /"J3"\n\t\t\t\(layer "B\.Fab"\)/);
});

test('values, footprint texts and board texts stay on silk', () => {
  const { text } = refsOffSilk(BOARD);
  assert.equal(text.match(/\(layer "F\.SilkS"\)/g)?.length, 3);
});

test('a second run moves nothing', () => {
  const once = refsOffSilk(BOARD).text;
  assert.deepEqual(refsOffSilk(once), { text: once, moved: 0 });
});
