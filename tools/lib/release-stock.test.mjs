// tools/release-stock.mjs against a stand-in curl. Run: node --test tools/lib/release-stock.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';

const tool = new URL('../release-stock.mjs', import.meta.url).pathname;
const URL_JLC = 'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList';
const page = (code, stock) => `{"data":{"componentPageInfo":{"list":[{"componentCode":"${code}","stockCount":${stock}}]}}}`;
const sha = data => createHash('sha256').update(data).digest('hex');
const manifest = populations => JSON.stringify({schema_version: 1, scope: 'cad_fabrication_candidate', board: 'BOARD', assembly: {populations}});
const both = {full: {references: {R1: 'C1', R2: 'C1', R3: 'C2'}}, small: {references: {R1: 'C1'}}};

// A curl that logs its argv and answers with <code>.json, or fails when <code>.fail exists.
function fixture(t, answers, text = manifest(both)) {
  const root = mkdtempSync(join(tmpdir(), 'release-stock-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'candidate'));
  writeFileSync(join(root, 'candidate/release-manifest.json'), text);
  writeFileSync(join(root, 'bin/curl'), `#!${process.execPath}
const fs=require('fs'),a=process.argv.slice(2),p=${JSON.stringify(root)};
fs.appendFileSync(p+'/curl.log',JSON.stringify(a)+'\\n');
const c=/"keyword": "([^"]*)"/.exec(a[a.indexOf('-d')+1])[1];
if(fs.existsSync(p+'/'+c+'.fail')){process.stderr.write('curl: (22) The requested URL returned error: 503\\n');process.exit(22);}
process.stdout.write(fs.readFileSync(p+'/'+c+'.json'));
`, {mode: 0o755});
  for (const [code, value] of Object.entries(answers)) writeFileSync(join(root, code + '.json'), value);
  const run = (...args) => spawnSync(process.execPath, [tool, ...args], {cwd: root, encoding: 'utf8',
    env: {...process.env, PATH: join(root, 'bin') + delimiter + process.env.PATH}});
  return {root, run, text};
}

test('saves the original responses and a receipt bound to the candidate', t => {
  const f = fixture(t, {C1: page('C1', 10), C2: page('C2', 5)});
  const r = f.run('candidate', 'out', '--boards', '5');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'START: assembly stock C1\nPASS: C1 assembly stock=10 required=10\n'
    + 'START: assembly stock C2\nPASS: C2 assembly stock=5 required=5\nPASS: original JLC stock receipts saved; stock is not reserved\n');
  assert.deepEqual(readdirSync(join(f.root, 'out')).sort(), ['C1.json', 'C2.json', 'stock.json']);
  assert.equal(readFileSync(join(f.root, 'out/C1.json'), 'utf8'), page('C1', 10));
  const text = readFileSync(join(f.root, 'out/stock.json'), 'utf8'), receipt = JSON.parse(text);
  assert.match(text, /^\{\n {2}"schema_version": 1,\n {2}"board": "BOARD",\n {2}"candidate_sha256": "[0-9a-f]{64}",\n {2}"source_url": "https:/);
  assert.ok(text.endsWith('\n  }\n}\n'));
  assert.equal(receipt.candidate_sha256, sha(f.text));
  assert.equal(receipt.source_url, URL_JLC);
  assert.equal(receipt.boards, 5);
  assert.equal(receipt.order_day_utc, new Date().toISOString().slice(0, 10));
  const c1 = receipt.parts.C1;
  assert.deepEqual(Object.keys(c1), ['required', 'fetched_at_utc', 'response', 'response_sha256']);
  assert.equal(c1.required, 10);
  assert.equal(c1.response, 'C1.json');
  assert.equal(c1.response_sha256, sha(page('C1', 10)));
  assert.match(c1.fetched_at_utc, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}\+00:00$/);
  const call = JSON.parse(readFileSync(join(f.root, 'curl.log'), 'utf8').split('\n')[0]);
  assert.equal(call.at(-1), URL_JLC);
  assert.equal(call[call.indexOf('-d') + 1], '{"keyword": "C1", "currentPage": 1, "pageSize": 10, "searchSource": "search"}');
  assert.ok(call.includes('Content-Type: application/json'));
});

test('the quantity is the largest single population, not the sum', t => {
  const f = fixture(t, {C1: page('C1', 2), C2: page('C2', 1)}, manifest({a: {references: {R1: 'C1', R2: 'C1'}}, b: {references: {R1: 'C1', R3: 'C2'}}}));
  assert.equal(f.run('candidate', 'out', '--boards', '1').status, 0);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'out/stock.json'))).parts.C1.required, 2);
});

test('short, missing, ambiguous or non-integer stock fails with exit 1 and keeps the receipts', t => {
  const f = fixture(t, {C1: page('C1', 9), C2: '{"data":{"componentPageInfo":{"list":[{"componentCode":"C2","stockCount":1000.0}]}}}'});
  const r = f.run('candidate', 'out', '--boards', '5');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, 'START: assembly stock C1\nFAIL: C1 assembly stock=9 required=10\n'
    + 'START: assembly stock C2\nFAIL: C2 assembly stock=1000.0 required=5\nFAIL: unavailable or stale assembly stock: C1, C2\n');
  assert.ok(existsSync(join(f.root, 'out/stock.json')));
  for (const [answer, shown] of [[`{"data":null}`, 'None'], [`{"data":{"componentPageInfo":{"list":[{"componentCode":"C1","stockCount":99},{"componentCode":"C1","stockCount":99}]}}}`, 'None'], [page('C1', 'true'), 'True']]) {
    const g = fixture(t, {C1: answer}, manifest({a: {references: {R1: 'C1'}}}));
    const s = g.run('candidate', 'out', '--boards', '3');
    assert.equal(s.status, 1);
    assert.match(s.stdout, new RegExp(`FAIL: C1 assembly stock=${shown} required=3`));
  }
});

test('a refused request stops with exit 2 and keeps the responses so far', t => {
  const f = fixture(t, {C1: page('C1', 99)});
  writeFileSync(join(f.root, 'C2.fail'), '');
  const r = f.run('candidate', 'out', '--boards', '1');
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'FAIL: assembly stock: C2: no response from JLC (curl: (22) The requested URL returned error: 503)\n');
  assert.deepEqual(readdirSync(join(f.root, 'out')), ['C1.json']);
});

test('a response that is not JSON stops with exit 2 and keeps that response', t => {
  const f = fixture(t, {C1: '<html>', C2: page('C2', 1)});
  const r = f.run('candidate', 'out', '--boards', '1');
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'FAIL: assembly stock: Expecting value: line 1 column 1 (char 0)\n');
  assert.equal(readFileSync(join(f.root, 'out/C1.json'), 'utf8'), '<html>');
});

test('bad input fails before any request, and existing output is refused', t => {
  const f = fixture(t, {C1: page('C1', 99), C2: page('C2', 99)});
  const refused = (args, status, text) => {
    const r = f.run(...args);
    assert.equal(r.status, status);
    assert.equal(r.stderr, text);
  };
  const usage = 'usage: release-stock.mjs [-h] --boards BOARDS candidate out\nrelease-stock.mjs: error: ';
  refused([], 2, usage + 'the following arguments are required: candidate, out, --boards\n');
  refused(['candidate', 'out'], 2, usage + 'the following arguments are required: --boards\n');
  refused(['candidate', 'out', '--boards', 'x'], 2, usage + "argument --boards: invalid int value: 'x'\n");
  refused(['candidate', 'out', '--boards', '0'], 2, 'FAIL: assembly stock: --boards must be positive\n');
  refused(['nothing', 'out', '--boards', '1'], 2, "FAIL: assembly stock: [Errno 2] No such file or directory: 'nothing/release-manifest.json'\n");
  mkdirSync(join(f.root, 'taken'));
  refused(['candidate', 'taken', '--boards', '1'], 2, "FAIL: assembly stock: [Errno 17] File exists: 'taken'\n");
  assert.equal(existsSync(join(f.root, 'curl.log')), false);
  for (const [text, message] of [
    ['{"schema_version":2,"scope":"cad_fabrication_candidate"}', 'verified fabrication candidate required'],
    ['{"schema_version":1,"scope":"other"}', 'verified fabrication candidate required'],
    ['[]', "'list' object has no attribute 'get'"],
    ['{"schema_version":1,"scope":"cad_fabrication_candidate"}', "'assembly'"],
    [manifest({a: {references: {R1: 'X1'}}}), 'invalid exact LCSC code'],
    [manifest({a: {references: {}}}), 'candidate contains no fitted parts'],
  ]) {
    const g = fixture(t, {}, text), r = g.run('candidate', 'out', '--boards', '1');
    assert.equal(r.status, 2);
    assert.equal(r.stderr, 'FAIL: assembly stock: ' + message + '\n');
    assert.equal(existsSync(join(g.root, 'curl.log')), false);
  }
});

test('schema_version 1.0 equals 1, as in Python', t => {
  const f = fixture(t, {C1: page('C1', 1)}, manifest({a: {references: {R1: 'C1'}}}).replace('"schema_version":1', '"schema_version":1.0'));
  assert.equal(f.run('candidate', 'out', '--boards', '1').status, 0);
});
