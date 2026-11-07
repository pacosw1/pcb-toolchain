// tools/build-bom-verified.mjs in a project-shaped folder, with stand-in kicad-cli and curl, and tools/lib/xml-read.mjs.
// Run: node --test tools/lib/build-bom-verified.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import {parseCsv} from './csv.mjs';
import {findText, iter, parseXml} from './xml-read.mjs';

const tools = new URL('..', import.meta.url).pathname;
const NET = `<?xml version="1.0" encoding="UTF-8"?>
<export version="E"><components>
<comp ref="R10"><value>1k &amp; more</value><footprint>iot-lab:C1</footprint><property name="Description" value="caf&#233; &lt;x&gt;"/></comp>
<comp ref="R2"><value>1k</value><footprint>iot-lab:C1</footprint></comp>
<comp ref="R3"><value>2k</value><footprint>iot-lab:C1</footprint><property name="dnp"/></comp>
<comp ref="J1"><value>x</value><footprint>Other:Lib</footprint></comp>
</components></export>
`;
function fixture(t, registry) {
  const root = mkdtempSync(join(tmpdir(), 'bomv-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(join(root, 'tools/lib'), {recursive: true});
  for (const name of ['build-bom-verified.mjs', 'jlc_stock.mjs']) copyFileSync(join(tools, name), join(root, 'tools', name));
  cpSync(join(tools, 'lib'), join(root, 'tools/lib'), {recursive: true});
  const board = join(root, 'hardware-design/boards/B');
  mkdirSync(board, {recursive: true});
  writeFileSync(join(board, 'gate.json'), '{"project":"cad/B"}');
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/kicad-cli'), `#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && { out=$2; shift; }; shift; done\ncp "${root}/net.xml" "$out"\n`, {mode: 0o755});
  writeFileSync(join(root, 'bin/curl'), `#!/bin/sh\nprintf '%s' '{"data":{"componentPageInfo":{"list":[{"componentCode":"C1","componentModelEn":"M","componentLibraryType":"base","stockCount":99999,"componentPrices":[]}]}}}'\n`, {mode: 0o755});
  writeFileSync(join(root, 'net.xml'), NET);
  if (registry) {
    mkdirSync(join(root, 'hardware-design/registry'), {recursive: true});
    writeFileSync(join(root, 'hardware-design/registry/boards.json'), JSON.stringify({schema_version: 1, boards: registry}));
  }
  const run = (name = 'B') => spawnSync(process.execPath, [join(root, 'tools/build-bom-verified.mjs'), name], {encoding: 'utf8',
    env: {...process.env, PATH: join(root, 'bin') + delimiter + process.env.PATH, KICAD_CLI: join(root, 'bin/kicad-cli')}});
  return {root, board, run};
}
const evidence = (f, path, code = 'C1', record = {}) => {
  const file = join(f.root, 'hardware-design/registry/evidence', path);
  mkdirSync(join(file, '..'), {recursive: true});
  writeFileSync(file, JSON.stringify({purchase_record: {componentCode: code, componentModelEn: 'M-' + path, componentSpecificationEn: '0603', componentBrandEn: 'Brand', ...record}}));
};
const datasheet = (f, name, sidecar) => {
  const dir = join(f.root, 'hardware-design/registry/datasheets');
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, name), '');
  if (sidecar) writeFileSync(join(dir, name + '.source.json'), JSON.stringify(sidecar));
};
const rows = (f, dir = f.board) => parseCsv(readFileSync(join(dir, 'BOM-VERIFIED.csv'), 'utf8'));
const BRAND = 5, SHEET = 6;

test('writes both CSV files with CRLF and sorted refs, through the Node jlc_stock', t => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'hardware-design/registry/evidence/2026-01-01/x/C1'), {recursive: true});
  writeFileSync(join(f.root, 'hardware-design/registry/evidence/2026-01-01/x/C1/C1.json'), '{"purchase_record":{"componentCode":"C1","componentModelEn":"MPN, one","componentSpecificationEn":"Plugin","componentBrandEn":"Brand"}}');
  mkdirSync(join(f.root, 'hardware-design/registry/datasheets'), {recursive: true});
  writeFileSync(join(f.root, 'hardware-design/registry/datasheets/Part_C1.pdf'), '');
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^PASS B: 2 BOM lines, 3 parts; jlc_stock:   lowest: C1 M \(R10,R2\) Basic stock 99999\n$/);
  assert.equal(readFileSync(join(f.board, 'BOM-JLC.csv'), 'utf8'), 'Comment,Designator,Footprint,LCSC Part #\r\n1k & more,"R10,R2",C1,C1\r\n');
  const day = readdirSync(join(f.root, 'hardware-design/registry/evidence')).find(name => name !== '2026-01-01');
  const lines = readFileSync(join(f.board, 'BOM-VERIFIED.csv'), 'utf8').split('\r\n');
  assert.equal(lines[1], `"R10,R2",café <x>,"MPN, one",C1,Plugin,Brand,../../registry/datasheets/Part_C1.pdf,Basic,"stock 99999 on ${day} (registry/evidence/${day}/B-stock.json, not reserved)",THT,,fit,`);
  assert.equal(lines[2], 'R3,,"MPN, one",C1,Plugin,Brand,../../registry/datasheets/Part_C1.pdf,Basic,"stock 99999 on ' + day + ' (registry/evidence/' + day + '/B-stock.json, not reserved)",THT,,DNP,');
});
test('a part without evidence prints FAIL and still exits 0, like the old tool', t => {
  const f = fixture(t), r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^FAIL B: 2 BOM lines, 3 parts; .*; C1: no JLC snapshot; C1: no datasheet; C1: no JLC snapshot; C1: no datasheet\n$/);
});
test('a board without a gate config ends like StopIteration', () => {
  const r = spawnSync(process.execPath, [join(tools, 'build-bom-verified.mjs'), 'NO-SUCH-BOARD'], {encoding: 'utf8'});
  assert.equal(r.status, 1);
  assert.equal(r.stderr, 'StopIteration\n');
});
test('finds snapshots at every lab layout and uses the newest one', t => {
  const f = fixture(t);
  evidence(f, '2026-01-01/x/C1/C1.json');
  evidence(f, '2026-01-02/C1.json');
  evidence(f, '2026-01-03/set/C1.json');
  assert.equal(f.run().status, 0);
  assert.equal(rows(f)[1][2], 'M-2026-01-03/set/C1.json');
  for (const path of ['2026-01-01/C1.json', '2026-01-01/set/C1.json', '2026-01-01/set/C1/C1.json']) {
    const g = fixture(t);
    evidence(g, path);
    const r = g.run();
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /no JLC snapshot/, path);
    assert.equal(rows(g)[1][2], 'M-' + path);
  }
});
test('a C-named file that is not a purchase record of the part is not a snapshot', t => {
  const f = fixture(t);
  evidence(f, '2026-01-01/C1.json');
  mkdirSync(join(f.root, 'hardware-design/registry/evidence/2026-01-03/s'), {recursive: true});
  writeFileSync(join(f.root, 'hardware-design/registry/evidence/2026-01-03/s/C1.json'), '{"code":200,"data":{},"message":"ok"}');
  evidence(f, '2026-01-04/C1.json', 'C2');
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /no JLC snapshot/);
  assert.equal(rows(f)[1][2], 'M-2026-01-01/C1.json');
  const g = fixture(t);
  evidence(g, '2026-01-04/C1.json', 'C2');
  assert.match(g.run().stdout, /C1: no JLC snapshot/);
});
test('links a datasheet stored under the MPN only when its source record names the part', t => {
  for (const sidecar of [{catalog_url: 'https://jlcpcb.com/partdetail/Maker-Part/C1'}, {catalog_url: 'https://jlcpcb.com/partdetail/C1'},
    {catalog_snapshot: 'hardware-design/registry/evidence/2026-01-01/set/C1.json'}]) {
    const f = fixture(t);
    evidence(f, '2026-01-01/C1.json');
    datasheet(f, 'Part-MPN.pdf', sidecar);
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /no datasheet/, JSON.stringify(sidecar));
    assert.equal(rows(f)[1][SHEET], '../../registry/datasheets/Part-MPN.pdf');
  }
});
test('does not link a datasheet that is not proven to be for the part', t => {
  const f = fixture(t);
  evidence(f, '2026-01-01/C1.json');
  datasheet(f, 'BZT52C1.pdf', {catalog_url: 'https://jlcpcb.com/partdetail/C173427', catalog_snapshot: 'x/C173427.json'});
  datasheet(f, 'Part.pdf');
  datasheet(f, 'Other.pdf', {catalog_url: 'https://jlcpcb.com/partdetail/C2'});
  datasheet(f, 'PartC1.pdf');
  datasheet(f, 'Conflict_C1.pdf', {catalog_url: 'https://jlcpcb.com/partdetail/C2'});
  datasheet(f, 'Mixed.pdf', {catalog_url: 'https://jlcpcb.com/partdetail/C1', catalog_snapshot: 'x/C2.json'});
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /C1: no datasheet/);
  assert.equal(rows(f)[1][SHEET], '');
});
test('a gate-only board writes into the directory of the board that owns its revision', t => {
  const f = fixture(t, [
    {id: 'GO', directory: 'GO', kind: 'gate-only', lifecycle: 'active', owner: 'OWN', revision: 'B'},
    {id: 'OWN', directory: 'OWN', kind: 'board', lifecycle: 'planned', revisions: [{revision: 'A', gate: 'OWN'}, {revision: 'B', gate: 'GO'}]},
  ]);
  mkdirSync(join(f.root, 'hardware-design/boards/GO'));
  mkdirSync(join(f.root, 'hardware-design/boards/OWN'));
  writeFileSync(join(f.root, 'hardware-design/boards/GO/gate.json'), '{"project":"../OWN/cad/revB/OWN"}');
  evidence(f, '2026-01-01/C1.json');
  datasheet(f, 'Part_C1.pdf');
  const r = f.run('GO');
  assert.equal(r.status, 0, r.stderr);
  const own = join(f.root, 'hardware-design/boards/OWN');
  assert.deepEqual(readdirSync(own).sort(), ['BOM-JLC.csv', 'BOM-VERIFIED.csv']);
  assert.equal(rows(f, own)[1][SHEET], '../../registry/datasheets/Part_C1.pdf');
  assert.equal(readFileSync(join(own, 'BOM-JLC.csv'), 'utf8'), 'Comment,Designator,Footprint,LCSC Part #\r\n1k & more,"R10,R2",C1,C1\r\n');
  assert.deepEqual(readdirSync(join(f.root, 'hardware-design/boards/GO')), ['gate.json']);
});
test('xml-read follows ElementTree on the KiCad netlist shape', () => {
  const root = parseXml('<?xml version="1.0"?><!-- c --><a x="1 &amp; 2" y=\'q\'><b>t<c/>tail</b><b/><d><![CDATA[<raw>]]></d></a>');
  assert.equal(root.attributes.get('x'), '1 & 2');
  assert.equal(root.attributes.get('y'), 'q');
  assert.equal(findText(root, 'b'), 't');
  assert.equal(findText(root, 'd'), '<raw>');
  assert.equal(findText(root, 'none'), null);
  assert.equal([...iter(root, 'b')].length, 2);
  assert.throws(() => parseXml('<a><b></a>'), /mismatched tag/);
  assert.throws(() => parseXml('<a>'), /no element found/);
  assert.throws(() => parseXml('<a>&nope;</a>'), /undefined entity/);
});
