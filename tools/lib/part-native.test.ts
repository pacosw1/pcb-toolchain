// The hash input and path rules of the native reader. Whole boards are read in part-evidence.test.ts.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Float } from './py-compat.mjs';
import { digest, encoded, owned, properties, readBoard } from './part-native.ts';
import { BOARD, FOLDER, makeFixture } from './part-fixture.ts';
import { statusBoard } from './part-review.ts';
import { stockBoard } from './part-stock.ts';
import { Atom, dump, items, parse, type CadList } from './pq-cadlib.ts';

test('encoded is compact sorted JSON that keeps non-ASCII text and number types', () => {
  const value = new Map<string, unknown>([['b', new Float(1)], ['a', [2n, 'µ']], ['10', true], ['2', null]]);
  assert.equal(encoded(value).toString(), '{"10":true,"2":null,"a":[2,"µ"],"b":1.0}');
  assert.equal(digest(encoded({})), '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
});

test('owned accepts only a file inside the root', (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), 'owned-'));
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  t.after(() => [root, outside].forEach(path => rmSync(path, { recursive: true, force: true })));
  mkdirSync(join(root, 'a'));
  writeFileSync(join(root, 'a/file'), 'x');
  writeFileSync(join(outside, 'file'), 'x');
  symlinkSync(join(outside, 'file'), join(root, 'a/link'));
  assert.ok(owned(root, 'a/file').endsWith('/a/file'));
  for (const name of ['/etc/passwd', 'a/../a/file', './a/file', 'a//file', 'a\\file', '', 7]) {
    assert.throws(() => owned(root, name), /expected repository-relative evidence path/);
  }
  assert.throws(() => owned(root, 'a/missing'), /missing evidence file: a\/missing/);
  assert.throws(() => owned(root, 'a/link'), /is not in the subpath of/);
});

test('properties refuse a duplicate', () => {
  assert.equal(properties(['footprint', ['property', 'Value', '1k']]).get('Value'), '1k');
  assert.throws(() => properties(['f', ['property', 'A', '1'], ['property', 'A', '2']]), /duplicate\/malformed native property/);
});

test('a board ID must be a configured name', () => {
  for (const board of ['lower', '../X', '', null]) assert.throws(() => readBoard('/tmp', board), /expected configured board ID/);
});

function pinlessFixture(t: TestContext, kind: 'npth' | 'electrical' | 'connected' | 'mixed' | 'no-pads' | 'wrong-unit', reference = 'J1') {
  const root = mkdtempSync(join(tmpdir(), 'pinless-'));t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = makeFixture(root), before = readBoard(root, BOARD);
  const schematic = join(root, FOLDER, 'fixture.kicad_sch'), pcb = join(root, FOLDER, 'fixture.kicad_pcb');
  const sch = parse(readFileSync(schematic, 'utf8')), board = parse(readFileSync(pcb, 'utf8'));
  const prop = (form: CadList, name: string) => items(form, 'property').find(row => row[1] === name)!;
  const symbol = items(sch, 'symbol').find(row => prop(row, 'Reference')[2] === 'J1')!;
  const footprint = items(board, 'footprint').find(row => prop(row, 'Reference')[2] === 'J1')!;
  const path = items(items(items(symbol, 'instances')[0]!, 'project')[0]!, 'path')[0]!;
  prop(symbol, 'Reference')[2] = reference;prop(footprint, 'Reference')[2] = reference;
  items(path, 'reference')[0]![1] = reference;
  if (kind !== 'wrong-unit') {
    items(sch, 'lib_symbols')[0]!.push(parse('(symbol "Fixture:Pinless" (symbol "Pinless_0_1") (symbol "Pinless_1_1"))'));
    items(symbol, 'lib_id')[0]![1] = 'Fixture:Pinless';
    const oldPins = new Set(items(symbol, 'pin'));
    for (let i = symbol.length - 1; i >= 0; i--) if (oldPins.has(symbol[i] as CadList)) symbol.splice(i, 1);
  } else {
    items(symbol, 'unit')[0]![1] = new Atom('2');items(path, 'unit')[0]![1] = new Atom('2');
  }
  if (kind !== 'electrical') {
    footprint[1] = 'Fixture:NPTH';prop(symbol, 'Footprint')[2] = 'Fixture:NPTH';
    const oldPads = new Set(items(footprint, 'pad'));
    for (let i = footprint.length - 1; i >= 0; i--) if (oldPads.has(footprint[i] as CadList)) footprint.splice(i, 1);
    if (kind !== 'no-pads') footprint.push(parse(`(pad "" np_thru_hole circle (at 0 0) (size 3.2 3.2) (drill 3.2) (layers "*.Cu" "*.Mask") ${kind === 'connected' ? '(net 1 "/A")' : ''})`));
    if (kind === 'mixed') footprint.push(parse('(pad "2" smd rect (at 3 0) (size 1 1) (layers "F.Cu"))'));
  }
  writeFileSync(schematic, dump(sch));writeFileSync(pcb, dump(board));
  return { root, manifest, before, schematic };
}

test('pinless non-H references classify from unconnected NPTH geometry without review approval', t => {
  const { root, manifest, before, schematic } = pinlessFixture(t, 'npth');
  const native = readBoard(root, BOARD), hole = native.parts.get('J1')!;
  assert.equal(native.parts.size, 4, JSON.stringify(native.blockers));assert.deepEqual(native.blockers, []);
  assert.equal(hole.pin_map.size, 0);assert.equal(hole.mechanical_only?.pad_count, 1);
  assert.deepEqual(hole.mechanical_only?.locations, [{ path: schematic.slice(root.length + 1), unit: 1 }]);
  assert.equal(hole.required, true, 'mechanical classification must not waive BOM/review requirements');
  assert.deepEqual(native.parts.get('J2'), before.parts.get('J2'), 'unrelated electrical asset/hash facts stay unchanged');
  rmSync(manifest);
  const status = statusBoard(root, BOARD);
  assert.equal(status.qualified, false);assert.equal(status.stock_current, false);assert.equal(status.release_approved, false);
  assert.ok(status.blockers.some(row => row.code === 'missing_part_review'));
});

test('electrical or connected pinless parts remain per-reference blockers while inventory continues', t => {
  for (const kind of ['electrical', 'connected', 'mixed', 'no-pads', 'wrong-unit'] as const) {
    const { root, schematic } = pinlessFixture(t, kind, 'H1');
    const native = readBoard(root, BOARD);
    assert.equal(native.parts.size, 3, kind);assert.equal(native.parts.has('H1'), false);
    const blocker = native.blockers.find(row => row.reference === 'H1')!;
    assert.equal(blocker.code, 'native_part_read');assert.equal(blocker.path, schematic.slice(root.length + 1));
    assert.equal(blocker.unit, kind === 'wrong-unit' ? 2 : 1);
    assert.match(blocker.detail, /H1.*fixture\.kicad_sch.*unit/);
    const candidate = join(root, 'candidate');mkdirSync(candidate);
    writeFileSync(join(candidate, 'release-manifest.json'), JSON.stringify({ schema_version: 1, scope: 'cad_fabrication_candidate', board: BOARD }));
    let queries = 0;
    const stock = stockBoard(root, BOARD, candidate, 1, join(root, 'receipts'), () => { queries++;return { status: 0 }; });
    assert.equal(queries, 0);assert.equal(stock.stock_current, false);
    assert.ok(stock.blockers.some(row => /native part identity is inconsistent/.test(row.detail)));
  }
});
