// tools/jlc_stock.mjs and tools/jlc_api_evidence.mjs against a stand-in curl. Run: node --test tools/lib/jlc-tools.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';

const tool = name => new URL(`../${name}`, import.meta.url).pathname;
const record = (code, more = '') => `{"componentCode":"${code}","componentModelEn":"M-${code}","componentLibraryType":"expand","stockCount":100000,"componentPrices":[{"startNumber":1,"endNumber":9,"productPrice":0.125,"x":1}]${more}}`;
const page = list => `{"data":{"componentPageInfo":{"list":[${list}]}}}`;

// A curl that logs its argv and answers from <code>.json in the fixture folder.
function fixture(t, answers) {
  const root = mkdtempSync(join(tmpdir(), 'jlc-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/curl'), `#!${process.execPath}
const fs=require('fs'),a=process.argv.slice(2),p=${JSON.stringify(root)};
fs.appendFileSync(p+'/curl.log',JSON.stringify(a)+'\\n');
const c=/"keyword": "([^"]*)"/.exec(a[a.indexOf('-d')+1])[1];
process.stdout.write(fs.existsSync(p+'/'+c+'.json')?fs.readFileSync(p+'/'+c+'.json'):'{"data":null}');
`, {mode: 0o755});
  for (const [code, text] of Object.entries(answers)) writeFileSync(join(root, code + '.json'), text);
  const run = (name, args, env = {}) => spawnSync(process.execPath, [tool(name), ...args],
    {cwd: root, encoding: 'utf8', env: {...process.env, PATH: join(root, 'bin') + delimiter + process.env.PATH, ...env}});
  return {root, run};
}
const bom = rows => 'Comment,Designator,Footprint,LCSC Part #\n' + rows.join('\n') + '\n';

test('jlc_stock writes the evidence file, totals and the lowest stocks', t => {
  const f = fixture(t, {C1: page(record('C1')), C2: page(record('C2', ',"preferredComponentFlag":true'))});
  writeFileSync(join(f.root, 'b.csv'), bom(['Cap,"C1,C2",fp,C1', 'Cap2,C3,fp, C1 ', 'Res,R1,fp,C2']));
  const r = f.run('jlc_stock.mjs', ['b.csv', 'o.json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'jlc_stock: 2 of 2 codes found (3 BOM lines, 4 parts); Extended types 1; parts per board at the first price tier 0.50 USD\n'
    + '  lowest: C1 M-C1 (C1,C2,C3) Extended stock 100000\n  lowest: C2 M-C2 (R1) Preferred stock 100000\n');
  const out = readFileSync(join(f.root, 'o.json'), 'utf8');
  assert.match(out, /^\{\n {2}"fetched_at_utc": "\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}\+00:00",\n {2}"source_url": "https:/);
  assert.match(out, /"prices": \[\n {8}\{\n {10}"startNumber": 1,\n {10}"endNumber": 9,\n {10}"productPrice": 0\.125\n {8}\}\n {6}\]/);
  assert.ok(out.endsWith('\n  }\n}'));
  const body = JSON.parse(readFileSync(join(f.root, 'curl.log'), 'utf8').split('\n')[0]).at(-1);
  assert.equal(body, '{"keyword": "C1", "currentPage": 1, "pageSize": 10, "searchSource": "search"}');
});
test('jlc_stock keeps a price exactly as it came: 1.0, 1e-05 and a big int', t => {
  const prices = '[{"startNumber":12345678901234567890,"endNumber":1,"productPrice":1.0},{"startNumber":1,"endNumber":2,"productPrice":1e-05}]';
  const f = fixture(t, {C1: page(`{"componentCode":"C1","componentModelEn":"caf\u00e9","componentLibraryType":"base","stockCount":1234.0,"componentPrices":${prices}}`)});
  writeFileSync(join(f.root, 'b.csv'), bom(['X,R1,fp,C1']));
  assert.equal(f.run('jlc_stock.mjs', ['b.csv', 'o.json', '--boards', '1', '--min-margin', '1']).status, 0);
  const out = readFileSync(join(f.root, 'o.json'), 'utf8');
  for (const text of ['"startNumber": 12345678901234567890', '"productPrice": 1.0', '"productPrice": 1e-05', '"stock": 1234.0', '"model": "caf\\u00e9"']) assert.ok(out.includes(text), text);
});
test('jlc_stock prints FAIL lines and exits 1', t => {
  const f = fixture(t, {C1: page(record('C1')), C2: page(record('C9'))});
  writeFileSync(join(f.root, 'b.csv'), bom(['X,R1,fp,C1', 'Y,R2,fp,C2']));
  const r = f.run('jlc_stock.mjs', ['b.csv', 'o.json', '--boards', '100000', '--min-margin', '10']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL C1 M-C1: stock 100000 < 1000000 \(qty 1 x 100000 boards x margin 10\)\nFAIL C2 \(Y\): no exact catalog record\n$/);
});
test('jlc_stock usage errors exit 2 and name the program', t => {
  const f = fixture(t, {});
  const r = f.run('jlc_stock.mjs', ['--boards', 'x', 'a', 'b']);
  assert.equal(r.status, 2);
  assert.equal(r.stderr, "usage: jlc_stock.mjs [-h] [--boards BOARDS] [--min-margin MIN_MARGIN] bom out\njlc_stock.mjs: error: argument --boards: invalid int value: 'x'\n");
  const missing = f.run('jlc_stock.mjs', ['nofile.csv', 'o.json']);
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr, "FileNotFoundError: [Errno 2] No such file or directory: 'nofile.csv'\n");
});
