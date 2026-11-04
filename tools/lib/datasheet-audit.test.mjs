// tools/datasheet_audit.mjs with a stand-in pdftext. Run: node --test tools/lib/datasheet-audit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

const tool = new URL('../datasheet_audit.mjs', import.meta.url).pathname;
const pad = ' filler for the length rule '.repeat(12);
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'audit-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const put = (name, text, mode) => { mkdirSync(dirname(join(root, name)), {recursive: true}); writeFileSync(join(root, name), text, {mode}); };
  const D = 'hardware-design/registry/datasheets', part = (code, mpn, pkg) => put(`hardware-design/registry/cad-assets/${code}/easyeda-bridge-source.json`,
    JSON.stringify({result: {dataStr: {head: {c_para: {'Manufacturer Part': mpn, package: pkg}}}}}));
  put('hardware-design/boards/B/gate.json', '{"project":"cad/B/X"}');
  put('hardware-design/boards/B/cad/fab/X-BOM-JLC.csv', 'Comment,Designator,Footprint,LCSC Part #\na,U1,fp,C1\nb,U2,fp,C2\nc,"Q1,R9",fp,C3\nd,D1,fp,C4\ne,Y1,fp,C5\nf,K1,fp,C6\ng,R1,fp,C7\n');
  put(`${D}/a_C1.pdf`, 'LM358DR SOIC-8' + pad); part('C1', 'LM358DR', 'SOIC-8_L5.0');
  put(`${D}/b_C2.pdf`, 'LM2596 in TO-263' + pad); part('C2', 'LM2596S-5.0', 'TO-263-5');
  put(`${D}/c_C3.pdf`, 'AO3400A only' + pad); part('C3', 'AO3400A', 'SOT-23-3');
  put(`${D}/d_C4.pdf`, 'other part' + pad); part('C4', 'SS34', 'SMA');
  put(`${D}/e_C5.pdf`, 'short'); part('C5', 'ABM8', 'SMD3225');
  part('C6', 'NOFILE12', 'SOP-4');
  put('home/.cache/iot-lab/pdftext', '#!/bin/sh\ncat "$1"\n', 0o755);
  const run = (...args) => spawnSync(process.execPath, [tool, ...args], {encoding: 'utf8', env: {...process.env, IOT_LAB: root, HOME: join(root, 'home')}});
  return {root, run};
}

test('each status, the summary line and the exit code', t => {
  const f = fixture(t), r = f.run('B');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, [
    'datasheet_audit B: 6 active part types; CORE 1, IMAGE 1, MISSING 1, NO_PACKAGE 1, OK 1, WRONG 1',
    '  CORE       U2                 C2         LM2596S-5.0              prefix LM2596 of LM2596S-5.0; package TO-263 [b_C2.pdf]',
    '  NO_PACKAGE Q1                 C3         AO3400A                  MPN; package SOT-23 not in text [c_C3.pdf]',
    '  WRONG      D1                 C4         SS34                      [d_C4.pdf]',   // a lone WRONG keeps the empty first note
    '  IMAGE      Y1                 C5         ABM8                     no text layer [e_C5.pdf]',
    '  MISSING    K1                 C6         NOFILE12                  []', ''].join('\n'));
});
test('--json holds the rows with indent 1, --prefixes selects the parts', t => {
  const f = fixture(t), out = join(f.root, 'o.json'), r = f.run('B', '--json', out, '--prefixes', 'U');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.split('\n')[0], 'datasheet_audit B: 2 active part types; CORE 1, OK 1');
  const text = readFileSync(out, 'utf8');
  assert.ok(text.startsWith('[\n {\n  "refs": "U1",\n  "code": "C1",\n  "mpn": "LM358DR",\n  "package": "SOIC-8_L5.0",\n  "status": "OK",\n  "note": "LM358DR; package SOIC",\n  "file": "a_C1.pdf"\n },'));
});
test('a .source.json can link a file to a C-number', t => {
  const f = fixture(t), D = join(f.root, 'hardware-design/registry/datasheets');
  writeFileSync(join(D, 'linked.pdf'), 'NOFILE12 SOP' + pad);
  writeFileSync(join(D, 'linked.pdf.source.json'), '{"catalog_url":"https://x/y/C6///"}');
  writeFileSync(join(D, 'broken.pdf.source.json'), '{not json');
  assert.doesNotMatch(f.run('B').stdout, /MISSING/);
});
test('usage and missing input', t => {
  const f = fixture(t), usage = f.run();
  assert.equal(usage.status, 2);
  assert.equal(usage.stderr, 'usage: datasheet_audit.mjs [-h] [--json JSON] [--prefixes PREFIXES] board\ndatasheet_audit.mjs: error: the following arguments are required: board\n');
  const missing = f.run('NOPE');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^FileNotFoundError: \[Errno 2\] No such file or directory: '.*gate\.json'\n$/);
});
