#!/usr/bin/env node
// BOM-VERIFIED.csv for a board from its native schematic + registry evidence (read only on JLC: tools/jlc_stock.mjs).
//
//   node tools/build-bom-verified.mjs BOARD [--boards N]
//
// 1. kicad-cli netlist of the board schematic (gate.json / gate.pending.json names the project); one line per C-number
//    (footprint iot-lab:<C>), DNP parts on their own line.
// 2. BOARD/BOM-JLC.csv (Designator, Value, LCSC Part #) -> tools/jlc_stock.mjs -> registry/evidence/<today>/<BOARD>-stock.json
//    (class Basic / Extended, stock, sha256 of the response).
// 3. BOARD/BOM-VERIFIED.csv in the ESP32-CORE column set: manufacturer / MPN / package from the newest JLC snapshot
//    (registry/evidence/<day>/**/<C>.json, purchase_record of that C), datasheet = a registry/datasheets/*.pdf proven to be
//    for that C (tools/lib/bom-evidence.mjs). The files go to the packet folder: for a revision gate (CELLULAR-B), the owner board.
// Stock is not reserved: recheck it on the order day. One line PASS / FAIL at the end (FAIL: a C-number without snapshot,
// datasheet or stock record).
import {existsSync, mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import {PyError, cli, compare, csvLine, get, head, item, jsonLoad, osError, parseArgs, print, processText, pyStr, readText, run, sorted, splitlines, strip, today, truthy} from './lib/py-compat.mjs';
import {packetDirectory} from './lib/board-registry.mjs';
import {evidenceLookup} from './lib/bom-evidence.mjs';
import {fileRoot} from './lib/project-root.mjs';
import {findText, iter, parseXml} from './lib/xml-read.mjs';

const ROOT = fileRoot;
const KCLI = process.env.KICAD_CLI ?? (process.platform === 'darwin' ? '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli' : 'kicad-cli');
const write = (path, text) => { try { writeFileSync(path, text); } catch (error) { throw osError(error, path); } };

function main() {
  const a = parseArgs({prog: 'build-bom-verified.mjs', positionals: ['board'], options: [{flag: '--boards', type: 'int', fallback: 5n}]}, process.argv.slice(2));
  const gdir = join(ROOT, 'hardware-design/boards', a.board);   // gate folder
  const bdir = join(ROOT, 'hardware-design/boards', packetDirectory(ROOT, a.board));   // packet folder: the owner of a revision gate
  const config = ['gate.json', 'gate.pending.json'].map(name => join(gdir, name)).find(path => existsSync(path));
  if (config === undefined) throw new PyError('StopIteration', '');
  const sch = join(gdir, item(jsonLoad(config), 'project') + '.kicad_sch');
  const xml = join(mkdtempSync(join(tmpdir(), 'tmp')), 'net.xml');
  run(KCLI, ['sch', 'export', 'netlist', '--format', 'kicadxml', '-o', xml, sch], {check: true});
  const lines = new Map();   // "<C>|<dnp>" -> line, in netlist order
  for (const c of iter(parseXml(readText(xml)), 'comp')) {
    const ref = c.attributes.get('ref'), val = findText(c, 'value') || '', fp = findText(c, 'footprint') || '';
    const lcsc = fp.startsWith('iot-lab:C') ? fp.split(':').at(-1) : '';
    const properties = [...iter(c, 'property')], dnp = properties.some(p => p.attributes.get('name') === 'dnp');
    if (!lcsc) continue;
    const key = `${lcsc}|${dnp}`;
    if (!lines.has(key)) lines.set(key, {c: lcsc, dnp, refs: [], value: val, desc: ''});
    const line = lines.get(key);
    line.refs.push(ref);
    for (const p of properties) if (p.attributes.get('name') === 'Description' && !line.desc) line.desc = p.attributes.get('value') ?? '';
  }
  const byKey = [...lines.values()].sort((x, y) => compare(x.c, y.c) || Number(x.dnp) - Number(y.dnp));
  const jlc = join(bdir, 'BOM-JLC.csv');
  write(jlc, csvLine(['Comment', 'Designator', 'Footprint', 'LCSC Part #'])
    + byKey.filter(v => !v.dnp).map(v => csvLine([v.value, sorted(v.refs).join(','), v.c, v.c])).join(''));
  const day = today(), stockOut = join(ROOT, 'hardware-design/registry/evidence', day, `${a.board}-stock.json`);
  mkdirSync(join(ROOT, 'hardware-design/registry/evidence', day), {recursive: true});
  const r = run(process.execPath, [join(ROOT, 'tools/jlc_stock.mjs'), jlc, stockOut, '--boards', String(a.boards)]);
  const stock = existsSync(stockOut) ? jsonLoad(stockOut) : new Map();
  const parts = stock instanceof Map ? get(stock, 'parts', stock) : new Map();
  const fails = [], rows = [];
  const found = evidenceLookup(join(ROOT, 'hardware-design/registry/evidence'), join(ROOT, 'hardware-design/registry/datasheets'));
  const firstRef = line => sorted(line.refs)[0];
  for (const line of [...lines.values()].sort((x, y) => compare(firstRef(x), firstRef(y)))) {
    const {c, dnp} = line;
    const snap = found.snapshot(c), ds = found.datasheets(c);
    const pr = snap ? item(jsonLoad(snap), 'purchase_record') : new Map();
    const st = parts instanceof Map ? get(parts, c, new Map()) : new Map();
    if (!snap) fails.push(`${c}: no JLC snapshot`);
    if (!ds.length) fails.push(`${c}: no datasheet`);
    if (!dnp && !truthy(st)) fails.push(`${c}: no stock record`);
    const spec = get(pr, 'componentSpecificationEn', '');
    if (spec === null) throw new PyError('TypeError', "argument of type 'NoneType' is not iterable");
    rows.push([sorted(line.refs).join(','), head(line.desc, 90), get(pr, 'componentModelEn', line.value), c, spec,
      get(pr, 'componentBrandEn', ''), ds.length ? relative(bdir, ds[0]) : '', get(st, 'class', ''),
      truthy(st) ? `stock ${pyStr(get(st, 'stock'))} on ${day} (${relative(join(ROOT, 'hardware-design'), stockOut)}, not reserved)` : dnp ? 'DNP' : 'no record',
      !spec.includes('Plugin') ? 'SMT' : 'THT', '', dnp ? 'DNP' : 'fit', '']);
  }
  write(join(bdir, 'BOM-VERIFIED.csv'), csvLine(['Designator', 'Function block', 'MPN/value', 'LCSC', 'Package', 'Manufacturer', 'Datasheet', 'JLC class', 'Stock status',
    'PCBA type', 'Variant', 'Assembly status', 'Reviewer note']) + rows.map(csvLine).join(''));
  const last = splitlines(strip(processText(r.stdout))).at(-1) ?? '';
  const count = [...lines.values()].reduce((sum, v) => sum + v.refs.length, 0);
  print(`${!fails.length && r.status === 0 ? 'PASS' : 'FAIL'} ${a.board}: ${rows.length} BOM lines, ${count} parts; jlc_stock: ${head(last, 160)}${fails.length ? `; ${fails.slice(0, 6).join('; ')}` : ''}`);
}

cli(main);
