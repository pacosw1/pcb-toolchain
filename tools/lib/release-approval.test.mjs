// The G5 release approval record: tools/lib/release-approval.mjs. Run: node --test tools/lib/release-approval.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {releaseFixtureBoard} from './cad-seal-fixture.ts';
import {approveRelease, g5Decision, releaseApprovalPath, releaseApprovalStatus} from './release-approval.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('image')]);
const MANIFEST = '{"schema_version":1,"board":"X","g5_ready":false}\n';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'release-approval-')));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(join(root, 'hardware-design/boards/X'), {recursive: true});
  mkdirSync(join(root, 'candidate'));
  writeFileSync(join(root, 'candidate/release-manifest.json'), MANIFEST);
  writeFileSync(join(root, 'hardware-design/boards/X/gate.json'), '{"project":"cad/X","checks":{}}');
  releaseFixtureBoard(root, 'X');
  const report = (more = {}) => ({schema_version: 1, board: 'X', status: 'ready_for_user_review', checks: {cad_fabrication: {status: 'passed', candidate_sha256: sha(MANIFEST)}}, g5_release_approved: false, ...more});
  const put = (name, data) => { writeFileSync(join(root, name), typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data)); return join(root, name); };
  const args = (more = {}) => ({by: 'Ana', reason: 'checked the renders and the stock', report: put('report.json', report()), image: put('top.png', PNG), ...more});
  return {root, candidate: join(root, 'candidate'), put, report, args, record: releaseApprovalPath(root, 'X')};
}

test('a ready report and an image make an approval that names the person, the reason and the hashes', t => {
  const f = fixture(t);
  const status = approveRelease(f.root, 'X', f.candidate, f.args());
  assert.equal(status.state, 'approved');
  const record = JSON.parse(readFileSync(f.record, 'utf8'));
  assert.equal(record.schema, 'iot-lab.release-approval.v1');
  assert.equal(record.board, 'X');
  assert.equal(record.by, 'Ana');
  assert.equal(record.reason, 'checked the renders and the stock');
  assert.equal(record.candidate_sha256, sha(MANIFEST));
  assert.equal(record.report_sha256, sha(readFileSync(join(f.root, record.report))));
  assert.equal(record.image_sha256, sha(PNG));
  assert.deepEqual(releaseApprovalStatus(f.root, 'X', f.candidate).state, 'approved');
});

test('no record reads as missing, and g5 is not approved', t => {
  const f = fixture(t);
  assert.equal(releaseApprovalStatus(f.root, 'X', f.candidate).state, 'missing');
  assert.deepEqual(g5Decision(f.root, 'X', f.candidate, []), {g5_release_approved: false, g5_approval: {state: 'missing', problems: [], stale: []}});
});

test('g5 is approved only with an approved record and no readiness finding', t => {
  const f = fixture(t);
  approveRelease(f.root, 'X', f.candidate, f.args());
  assert.equal(g5Decision(f.root, 'X', f.candidate, []).g5_release_approved, true);
  const blocked = g5Decision(f.root, 'X', f.candidate, [{check: 'assembly_stock', cause: 'stock is old'}]);
  assert.equal(blocked.g5_release_approved, false);
  assert.equal(blocked.g5_approval.state, 'approved');
});

test('a changed candidate manifest makes the approval stale', t => {
  const f = fixture(t);
  approveRelease(f.root, 'X', f.candidate, f.args());
  writeFileSync(join(f.candidate, 'release-manifest.json'), MANIFEST.replace('false', 'true'));
  const status = releaseApprovalStatus(f.root, 'X', f.candidate);
  assert.equal(status.state, 'stale');
  assert.match(status.stale.join(' '), /candidate/);
  assert.equal(g5Decision(f.root, 'X', f.candidate, []).g5_release_approved, false);
});

test('a changed or missing kept report or image makes the approval stale', t => {
  const f = fixture(t);
  approveRelease(f.root, 'X', f.candidate, f.args());
  const record = JSON.parse(readFileSync(f.record, 'utf8'));
  writeFileSync(join(f.root, record.report), '{"status":"ready_for_user_review"}');
  assert.match(releaseApprovalStatus(f.root, 'X', f.candidate).stale.join(' '), /report changed/);
  rmSync(join(f.root, record.image));
  assert.match(releaseApprovalStatus(f.root, 'X', f.candidate).stale.join(' '), /image is missing/);
});

test('a missing candidate manifest is stale, never approved, and approval of it is refused', t => {
  const f = fixture(t);
  approveRelease(f.root, 'X', f.candidate, f.args());
  rmSync(join(f.candidate, 'release-manifest.json'));
  const status = releaseApprovalStatus(f.root, 'X', f.candidate);
  assert.equal(status.state, 'stale');
  assert.match(status.stale.join(' '), /release-manifest\.json/);
  assert.throws(() => approveRelease(f.root, 'X', f.candidate, f.args()), /release-manifest\.json/);
});

test('a malformed record is invalid and never approved', t => {
  const f = fixture(t);
  approveRelease(f.root, 'X', f.candidate, f.args());
  const record = JSON.parse(readFileSync(f.record, 'utf8'));
  for (const bad of [{...record, extra: 1}, {...record, schema: 'other'}, {...record, board: 'Y'}, {...record, by: ' '}, {...record, report_sha256: 'nothex'}]) {
    writeFileSync(f.record, JSON.stringify(bad));
    assert.equal(releaseApprovalStatus(f.root, 'X', f.candidate).state, 'invalid', JSON.stringify(bad).slice(0, 60));
  }
  for (const path of ['/etc/passwd', '../outside.json', 'a/../../outside.json']) {
    for (const key of ['report', 'image']) {
      writeFileSync(f.record, JSON.stringify({...record, [key]: path}));
      const status = releaseApprovalStatus(f.root, 'X', f.candidate);
      assert.equal(status.state, 'invalid', `${key} ${path}`);
      assert.match(status.problems.join(' '), /inside the project/);
    }
  }
  writeFileSync(f.record, 'not json');
  const unreadable = releaseApprovalStatus(f.root, 'X', f.candidate);
  assert.equal(unreadable.state, 'invalid');
  assert.match(unreadable.problems.join(' '), /not JSON/);
});

test('approval is refused without a person, a reason, a report or an image', t => {
  const f = fixture(t);
  for (const [key, pattern] of [['by', /by/], ['reason', /reason/], ['report', /report/], ['image', /image/]]) {
    assert.throws(() => approveRelease(f.root, 'X', f.candidate, f.args({[key]: ' '})), pattern, key);
  }
  assert.equal(existsSync(f.record), false);
});

test('approval is refused for a report that is blocked, belongs to another board or candidate, or is not JSON', t => {
  const f = fixture(t);
  const cases = [
    [f.report({status: 'blocked'}), /ready_for_user_review/],
    [f.report({board: 'Y'}), /another board/],
    [f.report({checks: {cad_fabrication: {status: 'passed', candidate_sha256: sha('other')}}}), /another candidate/],
    [f.report({checks: {}}), /another candidate/],
  ];
  for (const [report, pattern] of cases) assert.throws(() => approveRelease(f.root, 'X', f.candidate, f.args({report: f.put('r.json', report)})), pattern);
  assert.throws(() => approveRelease(f.root, 'X', f.candidate, f.args({report: f.put('r.json', 'not json')})), /report/);
  assert.equal(existsSync(f.record), false);
});

test('approval is refused for an image that is neither PNG nor SVG', t => {
  const f = fixture(t);
  assert.throws(() => approveRelease(f.root, 'X', f.candidate, f.args({image: f.put('bad.png', 'plain text')})), /PNG or SVG/);
  approveRelease(f.root, 'X', f.candidate, f.args({image: f.put('top.svg', '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')}));
  const record = JSON.parse(readFileSync(f.record, 'utf8'));
  assert.match(record.image, /\.svg$/);
});

test('a new approval replaces the kept image of the other type', t => {
  const f = fixture(t);
  approveRelease(f.root, 'X', f.candidate, f.args());
  const png = JSON.parse(readFileSync(f.record, 'utf8')).image;
  approveRelease(f.root, 'X', f.candidate, f.args({image: f.put('top.svg', '<svg/>')}));
  assert.equal(existsSync(join(f.root, png)), false);
});
