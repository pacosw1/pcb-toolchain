#!/usr/bin/env node
// Datasheet identity check for the active parts of a board BOM (no network).
//
//   node tools/datasheet_audit.mjs <BOARD> [--json OUT] [--prefixes U,Q,D,Y,K,F]
//
// For each BOM line (cad/fab/<BOARD>-BOM-JLC.csv) with a designator of the listed prefixes: the datasheet files in
// hardware-design/registry/datasheets/ for that C-number (file name *_<C>.pdf, or a .source.json whose catalog_url or
// catalog_snapshot names the C-number), their text (tools/pdftext.swift, macOS PDFKit), and:
//   MPN      the manufacturer part number (EasyEDA record of the C-number) or its longest prefix (>= 5 characters,
//            letters and digits only) is in the text;
//   PACKAGE  the package family of the EasyEDA footprint (SOT-23, SOIC, SMA, ...) is in the text.
// Status: OK (full MPN and package), CORE (MPN prefix and package: a family datasheet; read the ordering table),
// NO_PACKAGE (MPN found, package not), WRONG (MPN not in the text), IMAGE (no text: read it by eye), MISSING.
// Exit 1 on WRONG or MISSING. A person reads CORE, NO_PACKAGE and IMAGE.
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {PyError, SystemExit, cli, compare, dictRows, get, globNames, head, item, jsonDumps, jsonLoad, ljust, osError, parseArgs, print, pyStr, readText, run, sorted, split, strip, truthy} from './lib/py-compat.mjs';
import {fileRoot, projectRoot} from './lib/project-root.mjs';

const PROJECT = projectRoot();
const REG = join(PROJECT, 'hardware-design', 'registry');
const DS = join(REG, 'datasheets');
const PDFTEXT = join(homedir(), '.cache/iot-lab/pdftext');
const PKG = ['SOT-23', 'SOT-223', 'SOT-89', 'SOT-323', 'SOT-363', 'SOT-563', 'SOIC', 'SOP', 'SSOP', 'TSSOP', 'HTSSOP', 'MSOP',
  'HSOP', 'QFN', 'VQFN', 'DFN', 'SON', 'WSON', 'VSON', 'LQFP', 'TQFP', 'SMA', 'SMB', 'SMC', 'SMAF', 'SOD-123',
  'SOD-123F', 'SOD-323', 'SOD-523', 'TO-252', 'TO-263', 'DPAK', 'SO-8FL', 'DFN5', 'SC-70', 'SC-88', 'UDFN', 'LGA',
  '0402', '0603', '0805', '1206', '1210', '1812', '2920'];

const texts = new Map();
function pdftext(path) {
  if (texts.has(path)) return texts.get(path);
  if (!existsSync(PDFTEXT)) {
    mkdirSync(dirname(PDFTEXT), {recursive: true});
    run('swiftc', ['-O', join(fileRoot, 'tools', 'pdftext.swift'), '-o', PDFTEXT], {check: true, stdio: 'inherit'});
  }
  const text = run(PDFTEXT, [path], {stdio: ['ignore', 'pipe', 'ignore']}).stdout.toString('utf8');
  texts.set(path, text);
  return text;
}

const norm = s => (truthy(s) ? s : '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// The .source.json files are read once; the old tool read them again for each part, with the same result.
let sources = null;
function sourceRecords() {
  sources ??= globNames(DS).filter(name => name.endsWith('.pdf.source.json')).flatMap(name => {
    const path = join(DS, name);
    try { return [[path, jsonLoad(path)]]; } catch { return []; }   // an unreadable record names no part
  });
  return sources;
}

function filesFor(code, mpn = '') {
  const pdfs = globNames(DS).filter(name => name.endsWith('.pdf'));
  const out = new Set(pdfs.filter(name => name.endsWith(`_${code}.pdf`)).map(name => join(DS, name)));
  const m = norm(mpn);
  if (m.length >= 4) {   // a file named for the part (W5500.pdf, DP1435-5V.pdf), not yet linked to the C-number
    for (const name of pdfs) {
      const fn = norm(name.slice(0, -4));
      if (fn && (fn.startsWith(m) || m.startsWith(fn)) && fn.length >= Math.min(m.length, 4)) out.add(join(DS, name));
    }
  }
  for (const [path, record] of sourceRecords()) {
    const named = ['catalog_url', 'catalog_snapshot'].some(key => {
      const value = pyStr(get(record, key, ''));
      return value.replace(/\/+$/, '').endsWith(code) || value.includes(`/${code}.`);
    });
    if (named) out.add(path.slice(0, -'.source.json'.length));
  }
  return sorted([...out].filter(path => existsSync(path)));
}

function easyeda(code) {
  const path = join(REG, 'cad-assets', code, 'easyeda-bridge-source.json');
  if (!existsSync(path)) return ['', ''];
  const r = item(jsonLoad(path), 'result'), cp = get(item(item(r, 'dataStr'), 'head'), 'c_para', new Map());
  const part = get(cp, 'Manufacturer Part'), pkg = get(cp, 'package');
  return [truthy(part) ? part : get(r, 'title', ''), truthy(pkg) ? pkg : get(get(r, 'packageDetail', new Map()), 'title', '')];
}

function packageFamily(pkg) {
  const u = pkg.toUpperCase();
  const hits = PKG.filter(p => u.startsWith(p) || u.startsWith(p.replace('-', '')));
  if (hits.length) return hits.reduce((best, p) => p.length > best.length ? p : best);
  return u ? u.split(/[-_]/)[0] : '';
}

function check(code, mpn, pkg) {
  const files = filesFor(code, mpn);
  if (!files.length) return ['MISSING', '', ''];
  const family = packageFamily(pkg), rank = {OK: 5, CORE: 4, NO_PACKAGE: 3, IMAGE: 2, WRONG: 1};
  let best = ['WRONG', '', basename(files[0])];
  for (const f of files) {
    const tn = norm(pdftext(f)), name = basename(f);
    let st;
    if (tn.length < 200) st = ['IMAGE', 'no text layer', name];
    else {
      const m = norm(mpn);
      let hit = '';
      for (let n = m.length; n >= Math.min(m.length, 5); n--) {
        if (tn.includes(m.slice(0, n))) { hit = m.slice(0, n); break; }
      }
      if (!hit) st = ['WRONG', `MPN ${mpn} not in text`, name];
      else {
        const hasPackage = Boolean(family) && tn.includes(norm(family)), full = hit === m;
        if (full && hasPackage) st = ['OK', `${mpn}; package ${family}`, name];
        else if (hasPackage) st = ['CORE', `prefix ${hit} of ${mpn}; package ${family}`, name];
        else st = ['NO_PACKAGE', `${full ? 'MPN' : 'prefix ' + hit}; package ${family || pkg} not in text`, name];
      }
    }
    if (rank[st[0]] > rank[best[0]]) best = st;
  }
  return best;
}

function main() {
  const a = parseArgs({prog: 'datasheet_audit.mjs', positionals: ['board'],
    options: [{flag: '--json'}, {flag: '--prefixes', fallback: 'U,Q,D,Y,K,F'}]}, process.argv.slice(2));
  const active = new RegExp(`^(${a.prefixes.split(',').join('|')})\\d`);
  const bd = join(PROJECT, 'hardware-design', 'boards', a.board);
  const stem = basename(item(jsonLoad(join(bd, 'gate.json')), 'project'));
  const res = [];
  for (const r of dictRows(readText(join(bd, 'cad', 'fab', `${stem}-BOM-JLC.csv`)))) {
    const act = split(item(r, 'Designator'), ',').map(strip).filter(Boolean).filter(x => active.test(x));
    if (!act.length) continue;
    const code = strip(item(r, 'LCSC Part #')), [mpn, pkg] = easyeda(code), [status, note, file] = check(code, mpn, pkg);
    res.push({refs: act.join(','), code, mpn, package: pkg, status, note, file});
  }
  const count = new Map();
  for (const x of res) count.set(x.status, (count.get(x.status) ?? 0) + 1);
  const summary = [...count].sort(([x], [y]) => compare(x, y)).map(([k, v]) => `${k} ${v}`).join(', ');
  print(`datasheet_audit ${a.board}: ${res.length} active part types; ${summary}`);
  for (const x of res) {
    if (x.status !== 'OK') print(`  ${ljust(x.status, 10)} ${ljust(head(x.refs, 18), 18)} ${ljust(x.code, 10)} ${ljust(head(x.mpn, 24), 24)} ${head(x.note, 70)} [${head(x.file, 40)}]`);
  }
  if (a.json) {
    try { writeFileSync(a.json, jsonDumps(res, 1)); } catch (error) { throw osError(error, a.json); }
  }
  throw new SystemExit(res.some(x => x.status === 'WRONG' || x.status === 'MISSING') ? 1 : 0);
}

cli(main);
