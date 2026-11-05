import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { cacheKey, revision, safePath } from './block-sources.ts';
import { recolorSvg, viewVariant, VIEWS } from './block-views.ts';

let folder: string;

beforeEach(() => { folder = realpathSync(mkdtempSync(join(tmpdir(), 'block-views-'))); });
afterEach(() => rmSync(folder, { recursive: true, force: true }));

test('the cache key changes with content and with the variant', () => {
  const path = join(folder, 'a.kicad_pcb');
  writeFileSync(path, '1');
  const first = cacheKey([path], 'top');
  writeFileSync(path, '2');
  const second = cacheKey([path], 'top');
  assert.notEqual(first, second);
  assert.notEqual(second, cacheKey([path], 'bottom'));
});

test('the revision changes when a file changes or appears', () => {
  const path = join(folder, 'a.kicad_pcb');
  writeFileSync(path, '1');
  const first = revision([folder]);
  writeFileSync(path, '22');
  const second = revision([folder]);
  writeFileSync(join(folder, 'b.kicad_sch'), 'x');
  const third = revision([folder]);
  assert.equal(new Set([first, second, third]).size, 3);
  assert.equal(third, revision([folder]));
});

test('the view variant changes with the export command', () => {
  const before = viewVariant('front');
  const entry = VIEWS.front as (typeof VIEWS)[string];
  const [extension, command] = entry;
  VIEWS.front = [extension, (source, out) => [...command(source, out), '--extra']];
  try {
    assert.notEqual(before, viewVariant('front'));
  } finally {
    VIEWS.front = entry;
  }
});

test('the variant text names the program, as the Python cache key did', () => {
  assert.ok(viewVariant('top').startsWith('top kicad-cli pcb render --side top'));
});

test('every fill and stroke color becomes one; none stays', () => {
  const svg = '<g style="fill:#C2C200; stroke:#C2C200"><path fill="#000000" stroke="#FF00ff"/></g><rect fill="none"/>';
  assert.equal(recolorSvg(svg, '#00B8D4'), '<g style="fill:#00B8D4; stroke:#00B8D4"><path fill="#00B8D4" stroke="#00B8D4"/></g><rect fill="none"/>');
});

test('a path inside the root resolves; traversal is refused', () => {
  writeFileSync(join(folder, 'a.txt'), '');
  assert.equal(safePath(folder, 'a.txt'), join(folder, 'a.txt'));
  assert.equal(safePath(folder, '../etc/passwd'), null);
  assert.equal(safePath(folder, '/etc/passwd'), null);
});
