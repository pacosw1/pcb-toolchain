import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inkBox, lineAdvance, textBox, turned, type Box, type TextStyle } from './stroke-text.ts';

const near = (actual: Box, expected: Box, tolerance = 0.0015): void => {
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]!) < tolerance, `${actual.join(' ')} is not ${expected.join(' ')}`));
};

// Each box is the extent of the strokes that kicad-cli 10.0.6 plots to a Gerber for this text at the origin, pen width included.
const PLOTTED: [string, TextStyle, Box][] = [
  ['A', { height: 1, width: 1, thickness: 0.15 }, [-0.408, -0.62, 0.408, 0.53]],
  ['J12 24V DC IN', { height: 1.27, width: 1.27, thickness: 0.19, h: 'left' }, [0.211, -0.848, 14.19, 0.673]],
  ['gyp_j', { height: 1, width: 1, thickness: 0.15, h: 'right' }, [-3.793, -0.62, -0.214, 0.863]],
  ['CAN_L', { height: 0.8, width: 0.8, thickness: 0.15, v: 'top' }, [-1.713, -0.045, 1.789, 0.981]],
  ['CAN_H', { height: 0.8, width: 0.8, thickness: 0.15, v: 'bottom' }, [-1.808, -0.981, 1.77, 0.045]],
  ['18-32V', { height: 1.5, width: 1.2, thickness: 0.225, h: 'left' }, [0.264, -0.93, 7.232, 0.795]],
  ['GND', { height: 1, width: 1, thickness: 0.15, h: 'left', v: 'top', mirrored: true }, [-3.031, -0.035, -0.214, 1.115]],
  ['BACK SIDE', { height: 1, width: 1, thickness: 0.15, h: 'right', mirrored: true }, [0.214, -0.62, 7.888, 0.53]],
  ['TURNED', { height: 1, width: 1, thickness: 0.15, h: 'right', angle: 90 }, [-0.62, 0.214, 0.53, 5.84]],
  ['CEN', { height: 1, width: 1, thickness: 0.15, angle: 90 }, [-0.62, -1.313, 0.53, 1.361]],
  ['• bullet', { height: 1, width: 1, thickness: 0.15, h: 'left', v: 'top' }, [0.5, -0.035, 6.364, 1.115]],
  ['A B', { height: 2, width: 2, thickness: 0.3 }, [-2.579, -1.24, 2.388, 1.06]],
  ['two\nlines', { height: 1, width: 1, thickness: 0.15, h: 'left', v: 'top' }, [0.119, -0.035, 3.555, 2.725]],
  ['three\nlines\nhere', { height: 1.2, width: 1.2, thickness: 0.18, h: 'right', v: 'bottom' }, [-4.666, -5.31, -0.257, -0.066]],
];

for (const [text, style, expected] of PLOTTED) {
  test(`the ink of ${JSON.stringify(text)} is where KiCad plots it`, () => near(inkBox(text, style), expected));
}

test('a text with no ink is an empty box at the anchor', () => {
  assert.deepEqual(inkBox(' ', { height: 1, width: 1, thickness: 0.15 }), [0, 0, 0, 0]);
});

test('a character past the table is a square of the text size', () => {
  assert.equal(lineAdvance('\u{4e00}', 2), 2);
});

test('the text box follows GetTextBox: pen margin, then the height fudge', () => {
  // width: advance less the inter-character gap, plus 3 pens. height: (height + 3 pens) * 1.17.
  const style: TextStyle = { height: 1, width: 1, thickness: 0.2 };
  const [x0, y0, x1, y1] = textBox('A', style);
  assert.ok(Math.abs(x1 - x0 - (lineAdvance('A', 1) - 0.2 + 0.6)) < 1e-9);
  assert.ok(Math.abs(y1 - y0 - 1.6 * 1.17) < 1e-9);
  assert.ok(Math.abs(x0 + x1) < 1e-9 && Math.abs(y0 + y1) < 1e-9);
});

test('the text box follows the justification and the mirror', () => {
  const style: TextStyle = { height: 1, width: 1, thickness: 0.2 };
  assert.equal(textBox('A', { ...style, h: 'left' })[0], 0);
  assert.ok(textBox('A', { ...style, h: 'left', mirrored: true })[2] < 1e-9);
  assert.equal(textBox('A', { ...style, v: 'top' })[1], -1.6 * 0.17);
});

test('a turned box is the box of its turned corners', () => {
  assert.deepEqual(turned([0, 0, 2, 1], 90), [0, -2, 1, 0]);
  assert.deepEqual(turned([0, 0, 2, 1], 0), [0, 0, 2, 1]);
});
