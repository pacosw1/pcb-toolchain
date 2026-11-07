// The order record: tools/lib/release-order.mjs. It records an order that a person placed. It never orders or uploads.
// Run: node --test tools/lib/release-order.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {approveRelease, releaseApprovalPath} from './release-approval.mjs';
import {recordOrder, releaseOrders, releaseOrdersPath} from './release-order.mjs';
import {gateInputs} from './gate-inputs.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('image')]);
const MANIFEST = '{"schema_version":1,"board":"X","g5_ready":false}\n';

function fixture(t, {approve = true} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'release-order-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(join(root, 'hardware-design/boards/X/cad'), {recursive: true});
  mkdirSync(join(root, 'candidate'));
  writeFileSync(join(root, 'hardware-design/boards/X/gate.json'), '{"project":"cad/X","checks":{}}');
  writeFileSync(join(root, 'candidate/release-manifest.json'), MANIFEST);
  writeFileSync(join(root, 'report.json'), JSON.stringify({board: 'X', status: 'ready_for_user_review', checks: {cad_fabrication: {candidate_sha256: sha(MANIFEST)}}}));
  writeFileSync(join(root, 'top.png'), PNG);
  const candidate = join(root, 'candidate');
  if (approve) approveRelease(root, 'X', candidate, {by: 'Ana', reason: 'checked', report: join(root, 'report.json'), image: join(root, 'top.png')});
  const order = (more = {}) => ({by: 'Ana', what: '5 assembled boards, JLC economic assembly', quantity: 5, reference: 'JLC-1001', ...more});
  return {root, candidate, order};
}

test('an order of an approved release is recorded with the release hash, the approval hash, the person, the quantity and the reference', t => {
  const f = fixture(t);
  const entry = recordOrder(f.root, 'X', f.candidate, f.order());
  assert.equal(entry.schema, 'iot-lab.release-order.v1');
  assert.equal(entry.board, 'X');
  assert.equal(entry.candidate_sha256, sha(MANIFEST));
  assert.equal(entry.approval_sha256, sha(readFileSync(releaseApprovalPath(f.root, 'X'))));
  assert.deepEqual([entry.by, entry.what, entry.quantity, entry.reference], ['Ana', '5 assembled boards, JLC economic assembly', 5, 'JLC-1001']);
  assert.deepEqual(releaseOrders(f.root, 'X'), [entry]);
});

test('orders are appended in order and each line is one record', t => {
  const f = fixture(t);
  recordOrder(f.root, 'X', f.candidate, f.order());
  recordOrder(f.root, 'X', f.candidate, f.order({reference: 'JLC-1002', quantity: 2}));
  assert.deepEqual(releaseOrders(f.root, 'X').map(entry => entry.reference), ['JLC-1001', 'JLC-1002']);
  assert.equal(readFileSync(releaseOrdersPath(f.root, 'X'), 'utf8').trim().split('\n').length, 2);
});

test('an order is refused when the release has no approval', t => {
  const f = fixture(t, {approve: false});
  assert.throws(() => recordOrder(f.root, 'X', f.candidate, f.order()), /no approved release.*missing/s);
  assert.equal(existsSync(releaseOrdersPath(f.root, 'X')), false);
});

test('an order is refused when the approval is stale', t => {
  const f = fixture(t);
  writeFileSync(join(f.candidate, 'release-manifest.json'), MANIFEST.replace('false', 'true'));
  assert.throws(() => recordOrder(f.root, 'X', f.candidate, f.order()), /stale.*candidate changed/s);
  assert.equal(existsSync(releaseOrdersPath(f.root, 'X')), false);
});

test('an order is refused without a person, a text, a positive whole quantity or a reference', t => {
  const f = fixture(t);
  for (const [key, value, pattern] of [['by', ' ', /--by/], ['what', '', /--what/], ['reference', ' ', /--reference/], ['quantity', 0, /--quantity/], ['quantity', 1.5, /--quantity/], ['quantity', -2, /--quantity/], ['quantity', '5', /--quantity/], ['quantity', undefined, /--quantity/]]) {
    assert.throws(() => recordOrder(f.root, 'X', f.candidate, f.order({[key]: value})), pattern, `${key}=${value}`);
  }
  assert.equal(existsSync(releaseOrdersPath(f.root, 'X')), false);
});

test('an order reference is recorded once for a board', t => {
  const f = fixture(t);
  recordOrder(f.root, 'X', f.candidate, f.order());
  assert.throws(() => recordOrder(f.root, 'X', f.candidate, f.order({quantity: 9})), /JLC-1001.*already recorded/s);
  assert.equal(releaseOrders(f.root, 'X').length, 1);
});

test('a damaged order log is an error, never an empty list', t => {
  const f = fixture(t);
  recordOrder(f.root, 'X', f.candidate, f.order());
  writeFileSync(releaseOrdersPath(f.root, 'X'), 'not json\n');
  assert.throws(() => releaseOrders(f.root, 'X'), /line 1/);
  assert.throws(() => recordOrder(f.root, 'X', f.candidate, f.order({reference: 'JLC-2'})), /line 1/);
  writeFileSync(releaseOrdersPath(f.root, 'X'), JSON.stringify({schema: 'iot-lab.release-order.v1', board: 'Y'}) + '\n');
  assert.throws(() => releaseOrders(f.root, 'X'), /line 1/);
});

test('no order log reads as no orders', t => {
  assert.deepEqual(releaseOrders(fixture(t).root, 'X'), []);
});

test('the approval and order files are no gate input, so an approval does not make the gate evidence stale', t => {
  const f = fixture(t);
  recordOrder(f.root, 'X', f.candidate, f.order());
  const files = gateInputs(f.root, 'X').files.map(path => path.slice(f.root.length + 1));
  assert.ok(files.includes('hardware-design/boards/X/gate.json'));
  assert.equal(files.filter(path => /release-(approval|order)/.test(path)).length, 0, files.join(', '));
});
