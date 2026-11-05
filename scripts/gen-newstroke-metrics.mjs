#!/usr/bin/env node
// Writes tools/lib/newstroke-metrics.json from KiCad's common/newstroke_font.cpp, for tools/lib/stroke-text.ts.
//
//   scripts/gen-newstroke-metrics.mjs path/to/newstroke_font.cpp
//
// Each glyph is five characters in the font's own code (value + 'R', so a printable ASCII character each): left and right of
// the advance, then the left, right, top and bottom of the ink as the font draws it. The left of the advance comes off every
// value in stroke-text.ts, as KiCad's loadNewStrokeFont does. A glyph with no ink has spaces for its ink.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIRST = 0x20;
const LAST = 0x2e7f; // the last code before the CJK blocks; a silk label never needs those
const PER_LINE = 64;
const OUT = fileURLToPath(new URL('../tools/lib/newstroke-metrics.json', import.meta.url));

const source = readFileSync(process.argv[2], 'utf8');
const table = source.slice(source.indexOf('newstroke_font[] ='));

/** The C string literals of a table row, joined, with their escapes undone. */
const glyphText = row => [...row.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(match => match[1].replace(/\\(.)/g, '$1')).join('');

const rows = table.split('\n').filter(line => /^\s*"/.test(line)).map(glyphText);

function metrics(glyph) {
  const pairs = glyph.match(/[\s\S]{2}/g) ?? [];
  const [advance = 'RR', ...strokes] = pairs;
  const points = strokes.filter(pair => pair !== ' R');
  if (!points.length) return `${advance}    `.slice(0, 6);
  const xs = points.map(point => point.charCodeAt(0));
  const ys = points.map(point => point.charCodeAt(1));
  return advance + String.fromCharCode(Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys));
}

const glyphs = rows.slice(0, LAST - FIRST + 1).map(metrics).join('');
const size = 6;
const lines = [];
for (let at = 0; at < glyphs.length; at += PER_LINE * size) lines.push(glyphs.slice(at, at + PER_LINE * size));
writeFileSync(OUT, `${JSON.stringify({ about: 'KiCad newstroke metrics; made by scripts/gen-newstroke-metrics.mjs from common/newstroke_font.cpp (GPL-2.0-or-later)', first: FIRST, size, glyphs: lines }, null, 0).replace('"glyphs":[', '"glyphs":[\n').replaceAll('","', '",\n"')}\n`);
console.log(`${rows.length} glyphs in the font, ${glyphs.length / size} kept`);
