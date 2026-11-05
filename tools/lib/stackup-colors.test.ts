import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyColors } from './stackup-colors.ts';

const BOARD = `(setup
\t(stackup
\t\t(layer "F.SilkS"
\t\t\t(type "Top Silk Screen")
\t\t\t(color "White")
\t\t)
\t\t(layer "F.Mask"
\t\t\t(type "Top Solder Mask")
\t\t\t(thickness 0.01)
\t\t)
\t\t(layer "F.Cu"
\t\t\t(type "copper")
\t\t)
\t\t(copper_finish "None")
\t)
)
\t(gr_text "x"
\t\t(layer "F.Mask")
\t\t(color "keep")
\t)`;

test('the mask and silk layers get one colour after their type, and the finish is set', () => {
  const text = applyColors(BOARD, 'Black', 'Black', 'ENIG');
  assert.match(text, /"Top Silk Screen"\)\n\t\t\t\(color "Black"\)\n\t\t\)/);
  assert.match(text, /"Top Solder Mask"\)\n\t\t\t\(color "Black"\)\n\t\t\t\(thickness 0\.01\)/);
  assert.match(text, /\(copper_finish "ENIG"\)/);
});

test('copper layers and items after the stackup are left alone', () => {
  const text = applyColors(BOARD, 'Green', 'White', 'ENIG');
  assert.match(text, /"copper"\)\n\t\t\)/);
  assert.match(text, /\(color "keep"\)/);
});

test('a second run gives the same text', () => {
  const once = applyColors(BOARD, 'Blue', 'White', 'ENIG');
  assert.equal(applyColors(once, 'Blue', 'White', 'ENIG'), once);
});

test('a render shows black as a near-opaque hex', () => {
  assert.match(applyColors(BOARD, 'Black', 'White', 'ENIG', true), /\(color "#0E0E10F5"\)/);
});

test('a colour JLC does not make is refused', () => {
  assert.throws(() => applyColors(BOARD, 'Pink', 'White', 'ENIG'), /not a JLC option: mask Pink, silk White, finish ENIG/);
});
