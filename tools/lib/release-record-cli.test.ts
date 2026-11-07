import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sealFixtureBoard } from './cad-seal-fixture.ts';

const cli = fileURLToPath(new URL('../pcb-release-record.ts', import.meta.url));
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const MANIFEST = '{"schema_version":1,"board":"X","g5_ready":false}\n';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('image')]);

function fixture(t: { after(fn: () => void): void }, where = '') {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'release-record-cli-')));
  const root = where ? join(top, where) : top;
  t.after(() => rmSync(top, { recursive: true, force: true }));
  const board = join(root, 'hardware-design/boards/X');
  mkdirSync(join(board, 'cad'), { recursive: true });
  mkdirSync(join(root, 'candidate'));
  writeFileSync(join(board, 'gate.json'), '{"project":"cad/X","checks":{}}');
  for (const ext of ['kicad_pcb', 'kicad_sch', 'kicad_pro']) writeFileSync(join(board, `cad/X.${ext}`), `fixture ${ext}`);
  writeFileSync(join(root, 'candidate/release-manifest.json'), MANIFEST);
  writeFileSync(join(root, 'report.json'), JSON.stringify({ board: 'X', status: 'ready_for_user_review', checks: { cad_fabrication: { candidate_sha256: sha(MANIFEST) } } }));
  writeFileSync(join(root, 'top.png'), PNG);
  sealFixtureBoard(root, 'X');
  const call = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, '--project', root, ...args], { encoding: 'utf8' });
  const approve = (...more: string[]) => call('release-approval', 'X', '--candidate', join(root, 'candidate'), '--approve', '--by', 'Ana', '--reason', 'checked', '--report', join(root, 'report.json'), '--image', join(root, 'top.png'), ...more);
  const order = (...more: string[]) => call('release-order', 'X', '--record', '--candidate', join(root, 'candidate'), '--by', 'Ana', '--what', '5 boards', '--quantity', '5', '--reference', 'JLC-1', ...more);
  return { root, board, call, approve, order, pcb: join(board, 'cad/X.kicad_pcb') };
}

test('without a record the release is not approved and the command exits 1', t => {
  const f = fixture(t);
  const status = f.call('release-approval', 'X', '--candidate', join(f.root, 'candidate'), '--json');
  assert.equal(status.status, 1);
  assert.equal(JSON.parse(status.stdout).state, 'missing');
});

test('approve records the person and the hashes, writes one log line, and then the status passes', t => {
  const f = fixture(t);
  const done = f.approve('--json');
  assert.equal(done.status, 0, done.stderr);
  const status = JSON.parse(done.stdout);
  assert.equal(status.state, 'approved');
  assert.equal(status.approval.by, 'Ana');
  assert.equal(status.approval.candidate_sha256, sha(MANIFEST));
  assert.equal(f.call('release-approval', 'X', '--candidate', join(f.root, 'candidate')).status, 0);
  const log = readFileSync(join(f.root, '.gate/release-approval/X.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(log.map(row => row.type), ['release_approval.approved']);
  assert.equal(readFileSync(join(f.board, 'release-approval.png')).equals(PNG), true);
});

test('a changed candidate makes the status stale and exit 1', t => {
  const f = fixture(t);
  assert.equal(f.approve().status, 0);
  writeFileSync(join(f.root, 'candidate/release-manifest.json'), MANIFEST.replace('false', 'true'));
  const status = f.call('release-approval', 'X', '--candidate', join(f.root, 'candidate'), '--json');
  assert.equal(status.status, 1);
  assert.equal(JSON.parse(status.stdout).state, 'stale');
});

test('approve stops on a broken CAD seal and writes nothing', t => {
  const f = fixture(t);
  writeFileSync(f.pcb, 'plain file write');
  const done = f.approve();
  assert.notEqual(done.status, 0);
  assert.match(done.stderr, /changed outside our tools/);
  assert.equal(existsSync(join(f.board, 'release-approval.json')), false);
});

test('approve needs all four values, and the other values need approve', t => {
  const f = fixture(t);
  assert.equal(f.call('release-approval', 'X', '--candidate', join(f.root, 'candidate'), '--approve', '--by', 'Ana').status, 2);
  assert.equal(f.call('release-approval', 'X', '--candidate', join(f.root, 'candidate'), '--by', 'Ana').status, 2);
  assert.equal(f.call('release-approval', 'X').status, 2);
  assert.notEqual(f.call('release-approval', 'NOPE', '--candidate', join(f.root, 'candidate')).status, 0);
});

test('an order is recorded for an approved release and listed; it places no order', t => {
  const f = fixture(t);
  assert.equal(f.approve().status, 0);
  const done = f.order('--json');
  assert.equal(done.status, 0, done.stderr);
  assert.equal(JSON.parse(done.stdout).reference, 'JLC-1');
  const text = f.order('--reference', 'JLC-2');
  assert.match(text.stdout, /placed no order/);
  const list = f.call('release-order', 'X', '--json');
  assert.deepEqual(JSON.parse(list.stdout).orders.map((entry: { reference: string }) => entry.reference), ['JLC-1', 'JLC-2']);
});

test('an order is refused with no approval, with a stale approval, and with a bad quantity', t => {
  const f = fixture(t);
  const none = f.order();
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /no approved release/);
  assert.equal(f.approve().status, 0);
  assert.equal(f.order('--quantity', '0').status, 2);
  assert.equal(f.order('--quantity', 'many').status, 2);
  writeFileSync(join(f.root, 'candidate/release-manifest.json'), MANIFEST.replace('false', 'true'));
  const stale = f.order();
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /stale/);
  assert.equal(existsSync(join(f.board, 'release-orders.jsonl')), false);
});

test('approve is refused in a run workspace and writes nothing', t => {
  const f = fixture(t, '.gate/workspace');
  const done = f.approve();
  assert.notEqual(done.status, 0);
  assert.match(done.stderr, /not canonical/);
  assert.equal(existsSync(join(f.board, 'release-approval.json')), false);
});

test('an order writes one log line, and its flags need --record', t => {
  const f = fixture(t);
  assert.equal(f.approve().status, 0);
  assert.equal(f.order().status, 0);
  const log = readFileSync(join(f.root, '.gate/release-approval/X.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(log.map(row => row.type), ['release_approval.approved', 'release_order.recorded']);
  assert.equal(log[1].reference, 'JLC-1');
  assert.equal(f.call('release-order', 'X', '--by', 'Ana').status, 2);
  assert.equal(f.call('release-order', 'X', '--record', '--candidate', join(f.root, 'candidate'), '--by', 'Ana').status, 2);
});
