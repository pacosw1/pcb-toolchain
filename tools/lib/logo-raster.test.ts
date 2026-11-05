import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cropDark, grayOverWhite, joinedRects, logoRects, resize, type Gray } from './logo-raster.ts';
import { palettePng } from './silk-fixture.ts';

const gray = (width: number, rows: number[][]): Gray => ({ width, height: rows.length, pixels: Uint8Array.from(rows.flat()) });

test('a palette PNG reads as grey over white, transparent pixels white', () => {
  const image = grayOverWhite(palettePng([[0, 1], [2, 0]], [[0, 0, 0], [255, 255, 255], [10, 10, 10]], [255, 255, 0]));
  assert.deepEqual([...image.pixels], [0, 255, 255, 0]);
});

test('a PNG that is not 8-bit stays unread', () => {
  const file = palettePng([[0]], [[0, 0, 0]]);
  file[24] = 4;
  assert.throws(() => grayOverWhite(file), /depth 4/);
  assert.throws(() => grayOverWhite(Buffer.from('nothing here')), /not a PNG/);
});

test('the image is cut to its dark pixels', () => {
  const cut = cropDark(gray(4, [[255, 255, 255, 255], [255, 0, 100, 255], [255, 255, 255, 255]]));
  assert.deepEqual([cut.width, cut.height, ...cut.pixels], [2, 1, 0, 100]);
  assert.throws(() => cropDark(gray(1, [[255]])), /no dark pixel/);
});

test('resizing to the same size keeps every pixel', () => {
  const image = gray(3, [[0, 128, 255], [255, 128, 0]]);
  assert.deepEqual([...resize(image, 3, 2).pixels], [...image.pixels]);
});

test('resizing a flat image keeps its value', () => {
  assert.deepEqual([...resize(gray(4, [[50, 50, 50, 50], [50, 50, 50, 50]]), 2, 1).pixels], [50, 50]);
});

test('equal runs of adjacent rows join into one rectangle', () => {
  const rects = joinedRects(gray(4, [[0, 0, 255, 255], [0, 0, 255, 0], [255, 255, 255, 0]]), 0.1);
  assert.equal(rects.length, 2);
  const [wide, tall] = [rects.find(rect => rect[0] === 0)!, rects.find(rect => rect[0] > 0)!];
  assert.deepEqual(wide.map(value => Math.round(value * 10)), [0, 0, 2, 2]);
  assert.deepEqual(tall.map(value => Math.round(value * 10)), [3, 1, 4, 3]);
});

test('a logo takes its size from the width, with the aspect of the dark part', () => {
  const file = palettePng([[1, 1, 1, 1], [1, 0, 0, 1], [1, 1, 1, 1]], [[0, 0, 0], [255, 255, 255]]);
  const logo = logoRects(file, 0.4, 0.1);
  assert.ok(Math.abs(logo.width - 0.4) < 1e-9 && Math.abs(logo.height - 0.2) < 1e-9);
  assert.ok(logo.rects.length >= 1);
});
