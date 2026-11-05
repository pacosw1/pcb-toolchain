import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { duplicates, repair, repairFile, replacement } from './board-uuids.ts';

const ZONE = 'bbbbbbbb-0000-0000-0000-000000000001';
const BOARD = `(kicad_pcb
\t(version 20260206)
\t(footprint "R_0402"
\t\t(uuid "aaaaaaaa-0000-0000-0000-000000000001")
\t\t(property "Reference" "R1 (c)" (uuid "aaaaaaaa-0000-0000-0000-000000000002"))
\t\t(pad "1" smd rect (uuid "aaaaaaaa-0000-0000-0000-000000000003"))
\t)
\t(zone
\t\t(net 1)
\t\t(uuid "${ZONE}")
\t\t(polygon (pts (xy 0 0) (xy 1 0) (xy 1 1)))
\t)
\t(zone
\t\t(net 1)
\t\t(uuid "${ZONE}")
\t\t(polygon (pts (xy 0 0) (xy 2 0) (xy 2 2)))
\t)
\t(zone
\t\t(net 2)
\t\t(uuid "${ZONE}")
\t)
\t(gr_text "a \\"(\\" quote" (uuid "cccccccc-0000-0000-0000-000000000001"))
\t(segment (start 0 0) (end 1 1) (uuid "dddddddd-0000-0000-0000-000000000001"))
)
`;

test('finds every repeat with its item kind', () => {
  assert.deepEqual(duplicates(BOARD).map(({ kind, uuid, ordinal }) => [kind, uuid, ordinal]),
    [['zone', ZONE, 1], ['zone', ZONE, 2]]);
});

test('a clean board has none and is unchanged', () => {
  const text = BOARD.replace(ZONE, 'x').replace(ZONE, 'y');
  assert.deepEqual(duplicates(text), []);
  assert.deepEqual(repair(text), { text, rows: [] });
});

test('repair is deterministic and keeps everything else', () => {
  const { text, rows } = repair(BOARD);
  assert.deepEqual(repair(BOARD), { text, rows });
  assert.equal(rows.length, 2);
  const [first, second] = rows;
  assert.ok(first && second);
  assert.equal(new Set([first.new, second.new, first.uuid]).size, 3);
  assert.deepEqual(duplicates(text), []);
  // The first occurrence keeps its UUID; only the uuid tokens of the repeats change.
  assert.equal(text.split(ZONE).length - 1, 1);
  const strip = (value: string) => value.replaceAll(first.new, 'Z').replaceAll(second.new, 'Z').replaceAll(ZONE, 'Z');
  assert.equal(strip(text), strip(BOARD));
  assert.equal(first.new, replacement(ZONE, 1));
  assert.notEqual(first.new, second.new);
});

test('a replacement is the same on every host', () => {
  assert.equal(replacement(ZONE, 1), '9f667dc8-7ede-5bc7-82d4-b89ecc954fe7');
});

test('a replacement that already exists takes a later ordinal', () => {
  const taken = replacement(ZONE, 1);
  const text = `(a (uuid "${ZONE}") (uuid "${ZONE}") (uuid "${taken}"))`;
  assert.deepEqual(repair(text).rows.map(row => row.new), [replacement(ZONE, 1001)]);
});

test('repairFile writes only when needed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-uuids-'));
  try {
    const path = join(dir, 'b.kicad_pcb');
    writeFileSync(path, BOARD);
    assert.equal(repairFile(path, false).replaced, 0);
    assert.equal(readFileSync(path, 'utf8'), BOARD);
    assert.equal(repairFile(path).replaced, 2);
    assert.deepEqual(duplicates(readFileSync(path, 'utf8')), []);
    assert.equal(repairFile(path).replaced, 0);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
