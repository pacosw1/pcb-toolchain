// A failed step ends the run only with proof that locked input copper cannot pass. Every case but the first must not stop it.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sha256File } from '../lib/json-file.ts';
import { copperRows, lockedFaults, mandatoryBoard, stepFaults, type Row } from './mandatory-proof.ts';

const FIXTURE = fileURLToPath(new URL('../test-fixtures/mandatory-cc-774.json', import.meta.url));

type Any = Record<string, any>;
let rows: Row[], fault: Any, seed: Any, child: Any;
const clone = <T>(value: T): T => structuredClone(value);

beforeEach(() => {
  rows = [{ uuid: 'owned', net: '/J1_CC1', layer: 'In2.Cu', via: false, kind: 'PCB_TRACK', locked: true, geometry: [[1, 2], [3, 4]], width: 150000 }];
  fault = { uuid: 'owned', net: '/J1_CC1', layer: 'In2.Cu', source_locked: true, reason: 'not explicitly eligible for mixed layer', preservation: 'locked or retained by this invocation' };
  seed = {
    board_sha256: 'seed', qualified: false, source_records: rows, faults: [fault], policy_sources: { '/seed/BASE-PWR-B.kicad_pro': 'project', '/rules': 'rules' },
    board_identity: { board: 'BASE-PWR-B', source_project: '/seed/BASE-PWR-B.kicad_pro' }, preserved_pair_profile: { board: 'BASE-PWR-B', p: '/USB_DP', n: '/USB_DN', expected_vias: { p: 0, n: 1 } },
    routed_nets: ['/J1_CC1'], unlock_nets: '',
  };
  child = clone(seed);
  child.board_sha256 = 'actual-child';
  child.board_identity.source_project = '/child/BASE-PWR-B.kicad_pro';
  child.policy_sources = { '/child/BASE-PWR-B.kicad_pro': 'project', '/rules': 'rules' };
});

const validate = ({ receipt = child, given = rows, source = seed, policies = undefined as Any | undefined } = {}) =>
  lockedFaults(receipt, 'actual-child', given, source, policies ?? receipt.policy_sources);

test('the captured four-fault receipt is valid locked evidence', () => {
  const captured = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Any;
  assert.equal(captured.faults.length, 4);
  assert.deepEqual(captured.preserved_pair_profile.expected_vias, { p: 0, n: 1 });
  assert.deepEqual(lockedFaults(captured, captured.board_sha256, captured.source_records, captured, captured.policy_sources), captured.faults);
  const changed = clone(captured);
  changed.policy_sources.changed = 'new';
  assert.deepEqual(lockedFaults(changed, captured.board_sha256, captured.source_records, captured, changed.policy_sources), []);
});

test('an exact candidate with its owned source unchanged is fatal', () => assert.deepEqual(validate(), [fault]));

test('a stale digest or changed policy cannot stop the run', () => {
  child.board_sha256 = 'stale';
  assert.deepEqual(validate(), []);
  child.board_sha256 = 'actual-child';
  assert.deepEqual(validate({ policies: { '/rules': 'different' } }), []);
  child.policy_sources['/rules'] = 'different';
  assert.deepEqual(validate(), []);
});

test('changed lock or geometry cannot stop the run', () => {
  const unlockedSource = clone(seed);
  unlockedSource.source_records[0].locked = false;
  assert.deepEqual(validate({ source: unlockedSource }), []);
  const unlocked = clone(rows);
  unlocked[0]!.locked = false;
  assert.deepEqual(validate({ given: unlocked }), []);
  const moved = clone(rows) as Any[];
  moved[0]!.geometry[0][0] += 1;
  assert.deepEqual(validate({ given: moved }), []);
  child.source_records[0].width += 1;
  assert.deepEqual(validate(), []);
});

test('a changed fault identity cannot mint a stop', () => {
  for (const [key, value] of [['uuid', 'unowned'], ['net', 'different'], ['reason', 'invented'], ['source_locked', false], ['preservation', 'invented']] as const) {
    const receipt = clone(child);
    receipt.faults[0][key] = value;
    assert.deepEqual(validate({ receipt }), [], key);
  }
});

test('selection and pair profile identity are bound', () => {
  for (const [key, value] of [['unlock_nets', '/J1_CC1'], ['routed_nets', []], ['preserved_pair_profile', { expected_vias: { p: 1, n: 1 } }]] as const) {
    const receipt = clone(child);
    receipt[key] = value;
    assert.deepEqual(validate({ receipt }), [], key);
  }
});

test('a pair fault without a protected uuid is not global', () => {
  child.faults = [{ pair: 'USB', reason: 'accepted preserved USB via profile mismatch', p: 1, n: 1, via_uuids: { '/USB_DP': ['v'] }, preservation: 'both pair nets excluded from routing' }];
  assert.deepEqual(validate(), []);
});

test('missing, malformed and duplicate records mint no stop', () => {
  for (const [field, value] of [['faults', null], ['faults', ['invalid']], ['source_records', [rows[0], rows[0]]], ['board_identity', {}]] as const) {
    const receipt = clone(child);
    receipt[field] = value;
    assert.deepEqual(validate({ receipt }), [], field);
  }
});

test('a changed owner project identity never stops the run', () => {
  child.board_identity.owner_project_sha256 = 'different';
  assert.deepEqual(validate(), []);
});

test('an arc cannot claim complete geometry from its end points', () => {
  rows[0]!.kind = 'PCB_ARC';
  assert.deepEqual(validate(), []);
});

test('board copper reads as receipt rows and an arc stays an arc', () => {
  const copper = [
    { Track: { id: 'a', start: { x: 1, y: 2 }, end: { x: 3, y: 4 }, mid: null, width: 150000, layer: 'In2.Cu', net: '/N', locked: true } },
    { Track: { id: 'b', start: { x: 1, y: 2 }, end: { x: 3, y: 4 }, mid: { x: 2, y: 9 }, width: 150000, layer: 'F.Cu', net: '/N', locked: false } },
    { Via: { id: 'c', at: { x: 5, y: 6 }, size: 600000, drill: 300000, net: '/N', locked: true, layers: ['F.Cu', 'B.Cu'] } },
  ];
  const [track, arc, via] = copperRows({ copper } as never);
  assert.deepEqual(track, { uuid: 'a', net: '/N', layer: 'In2.Cu', via: false, kind: 'PCB_TRACK', locked: true, geometry: [[1, 2], [3, 4]], width: 150000 });
  assert.equal(arc!.kind, 'PCB_ARC');
  assert.equal(via!.via, true);
});

const tempRoot = { path: '' };
beforeEach(() => { tempRoot.path = mkdtempSync(join(tmpdir(), 'mandatory-proof-')); });
afterEach(() => rmSync(tempRoot.path, { recursive: true, force: true }));

test('a step receipt is read against the input board and the current policy', () => {
  const board = join(tempRoot.path, 'step.kicad_pcb'), rules = join(tempRoot.path, 'rules.py');
  writeFileSync(board, 'step board');
  writeFileSync(rules, 'rules');
  const receipt = { ...clone(child), board_sha256: sha256File(board), policy_sources: { [rules]: sha256File(rules) } };
  assert.deepEqual(stepFaults(receipt, board, rows, () => rows), [fault]);
  const elsewhere = [{ ...rows[0], width: 1 }];
  assert.deepEqual(stepFaults(receipt, board, elsewhere, () => rows), [], 'the track is not the one on the input board');
  writeFileSync(rules, 'other rules');
  assert.deepEqual(stepFaults(receipt, board, rows, () => rows), []);
});

test('a board has mandatory rules only when its plugin defines them', () => {
  const root = tempRoot.path;
  const board = (name: string, gate: object) => {
    mkdirSync(join(root, 'hardware-design/boards', name), { recursive: true });
    writeFileSync(join(root, 'hardware-design/boards', name, 'gate.json'), JSON.stringify(gate));
  };
  mkdirSync(join(root, 'tools'));
  writeFileSync(join(root, 'tools/with.py'), 'import os\n\ndef preserved_input_faults(rows):\n    return []\n');
  writeFileSync(join(root, 'tools/without.py'), 'def other():\n    pass\n');
  board('A-1', { route_rules: 'tools/without.py' });
  board('B-1', { route_rules: 'tools/with.py' });
  board('C-1', {});
  assert.equal(mandatoryBoard(root, ['', 'bad name', 'A-1', 'C-1']), null);
  assert.equal(mandatoryBoard(root, ['A-1', 'B-1']), 'B-1');
});
