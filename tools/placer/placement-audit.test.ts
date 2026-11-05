// Placement audit records: what they reject, what they attribute, and the bytes behind their hashes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { parseTyped } from '../lib/json-file.ts';
import { Float, jsonDumps, number } from '../lib/py-compat.mjs';
import { withHalos, type Problem } from './compact.ts';
import { boundedFeedback, candidateKey, candidateReport, compareCandidates, digest, identity, movement, type AuditCandidate } from './placement-audit.ts';

type Row = Record<string, any>;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const problem = (): Problem => ({
  units: [{ name: 'LOCK', refs: ['J1'], fixed: true, x: 0, y: 0, rects: [] }, { name: 'MOVE', refs: ['R1'], fixed: false, x: 5, y: 5, rects: [] }],
  nets: [], board: { outline: [], fixed_copper: [1] }, decaps: [], domain_areas: [], dru_ignored: ['native required'],
});
const candidate = (values: Partial<AuditCandidate>): AuditCandidate => ({ pose: [], cost: 0, illegal: [], components: {}, ...values });
const report = (...args: Parameters<typeof candidateReport>) => candidateReport(...args) as Row;

function routeFolder(t: TestContext): string {
  const d = mkdtempSync(join(tmpdir(), 'placement-audit-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  writeFileSync(join(d, 'routed.kicad_pcb'), 'result');
  writeFileSync(join(d, 'input-manifest.json'), JSON.stringify({ board_sha256: 'source' }));
  writeFileSync(join(d, 'outcome.json'), JSON.stringify({ status: 'complete', errors: 0, board_sha256: digest(join(d, 'routed.kicad_pcb')) }));
  return d;
}

test('identity hashes the text of json.dumps(sort_keys=True)', () => {
  // The expected text is what CPython writes for these values: default separators, sorted keys, float repr, ensure_ascii.
  const text = '{"a": [1, 1.0, 2.5, 1e+16, 1e-05, -0.0, true, null, "\\u00e9"], "b": {"y": 0.1, "z": 100.0}}';
  const value = parseTyped('{"b": {"z": 100.0, "y": 0.1}, "a": [1, 1.0, 2.5, 1e16, 0.00001, -0.0, true, null, "é"]}');
  assert.equal(identity(value), sha256(text));
});

test('a whole float only hashes as Python does when it was read with its type', () => {
  const python = sha256('{"x": 1.0}');
  assert.equal(identity(parseTyped('{"x": 1.0}')), python);
  assert.notEqual(identity(JSON.parse('{"x": 1.0}')), python);
});

test('identity refuses what allow_nan=False refuses', () => {
  assert.throws(() => identity({ x: new Float(NaN) }), /Out of range float values/);
});

test('a problem with halos hashes the floats Python computes', () => {
  const read = parseTyped<Problem>('{"units": [{"name": "A", "fixed": false, "x": 1.0, "y": 2, "rects": [[0, 0, 1.0, 1.0, 0.25]]}, {"name": "B", "fixed": false, "x": 3.0, "y": 4.0, "rects": [[0, 0, 1, 1, 2]]}], "nets": [{"name": "N", "pins": [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0]]}], "board": {"outline": []}}');
  assert.equal(identity(withHalos(read, 2.5)), sha256('{"board": {"outline": []}, "nets": [{"name": "N", "pins": [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0]]}], "units": [{"fixed": false, "name": "A", "rects": [[0, 0, 1.0, 1.0, 1.0]], "x": 1.0, "y": 2}, {"fixed": false, "name": "B", "rects": [[0, 0, 1, 1, 2]], "x": 3.0, "y": 4.0}]}'));
});

test('movement records keep the types of json.dump', () => {
  const rows = movement(problem(), [[0, 0, 0], [8, 9, 1]]);
  assert.equal(jsonDumps(rows.map(row => [row.displacement_mm, row.turn_delta])), '[[0.0, 0], [5.0, 1]]');
  assert.equal(number(movement(problem(), [[0, 0, 3], [5, 5, 0]], [[0, 0, 0], [5, 5, 1]])[1].turn_delta), 3);   // a turn back is modulo 4
});

test('a pose of the wrong size or with a nonfinite value is refused', () => {
  assert.throws(() => movement(problem(), [[0, 0, 0]]), /cardinality/);
  assert.throws(() => movement(problem(), [[0, 0, 0], [5, 5]]), /malformed/);
  assert.throws(() => movement(problem(), [[0, 0, 0], [NaN, 5, 0]]), /nonfinite/);
});

test('an illegal alternative of lower cost cannot win', () => {
  const candidates = [candidate({ illegal: ['keepout'], cost: -100 }), candidate({ cost: 10 }), candidate({ cost: 0, timeout: true })];
  assert.equal(candidates.sort(compareCandidates)[0].cost, 10);
  assert.deepEqual(candidateKey(candidate({ cost: new Float(1.5), illegal: ['a'], mains: ['m', 'n'], timeout: true })), [1, 1, 2, 1.5]);
});

test('a seeded exchange is rejected even without rotation', () => {
  const pr = problem();
  pr.units[0].fixed = false;
  const faults = report(pr, candidate({ pose: [[5, 5, 0], [0, 0, 0]] }), { legal_rotate: 0 }, true).illegal as string[];
  assert.ok(faults.some(fault => fault.includes('swapped')));
});

test('a fixed unit, a rotation, a displacement and a timeout reject', () => {
  const c = candidate({ pose: [[1, 0, 0], [7, 5, 1]], prelegal_pose: [[0, 0, 0], [6, 5, 0]], timeout: true });
  const r = report(problem(), c, { p_swap: 0, p_rot: 0, legal_rotate: 0 }, true, 1);
  const faults = r.illegal as string[];
  assert.ok(faults.some(fault => fault.includes('fixed')));
  assert.ok(faults.some(fault => fault.includes('turn')));
  assert.ok(faults.some(fault => fault.includes('cap')));
  assert.ok(faults.includes('incomplete placement'));
  assert.equal(number(r.legalizer_movement[1].displacement_mm), 1);
  assert.equal(r.qualified, false);
});

test('a search that may rotate is not a seeded one', () => {
  const clean = { pose: [[0, 0, 0], [5, 5, 0]] };
  assert.deepEqual(report(problem(), candidate(clean), { p_rot: new Float(0) }, true).illegal, []);
  assert.deepEqual(report(problem(), candidate(clean), { p_rot: new Float(0.1) }, true).illegal, ['seeded policy incompatible with actual search parameters']);
});

test('a clean pose keeps every constraint attribution', () => {
  const c = candidate({ pose: [[0, 0, 0], [5.5, 5, 0]], components: { hpwl: 10 } });
  const r = report(problem(), c, { p_swap: 0, p_rot: 0, legal_rotate: 0 }, true, 1);
  assert.deepEqual(r.illegal, []);
  assert.equal(r.constraints.fixed_copper_items, 1);
  assert.deepEqual(r.constraints.unsupported, ['native required']);
  assert.equal(r.legalizer_movement, null);
  assert.notEqual(r.candidate_sha256, report(problem(), { ...c, pose: [[0, 0, 0], [6, 5, 0]] }, {}, false).candidate_sha256);
});

test('feedback is scoped, bounded and never teaches fixed units', t => {
  const d = routeFolder(t);
  writeFileSync(join(d, 'pin-escape.json'), JSON.stringify({ halo_hint: { J1: 10, R1: 10, UNKNOWN: 10 } }));
  let hints: Record<string, number> = {};
  let evidence: Row = {};
  for (let i = 0; i < 10; i++) [hints, evidence] = boundedFeedback(problem(), d, 'source', hints, 1);
  assert.deepEqual(hints, { R1: 1 });
  assert.equal(evidence.accepted, true);
  assert.equal(jsonDumps(evidence.hints), '{"R1": 1.0}');
  assert.deepEqual(Object.keys(evidence.sources), [join(d, 'pin-escape.json')]);
  const [unchanged, refused] = boundedFeedback(problem(), d, 'other', hints, 1);
  assert.deepEqual(unchanged, hints);
  assert.equal(refused.accepted, false);
  writeFileSync(join(d, 'routed.kicad_pcb'), 'stale');
  assert.equal(boundedFeedback(problem(), d, 'source', {}, 1)[1].accepted, false);
});

test('missing evidence teaches nothing', t => {
  const d = routeFolder(t);
  rmSync(join(d, 'outcome.json'));
  const [hints, evidence] = boundedFeedback(problem(), d, 'source', { R1: 0.5 }, 1);
  assert.deepEqual(hints, { R1: 0.5 });
  assert.deepEqual(evidence, { accepted: false, reason: 'missing complete attributed evidence' });
});

test('one update teaches at most eight refs, in sorted order', t => {
  const d = routeFolder(t);
  const refs = ['R9', 'R10', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'];
  writeFileSync(join(d, 'pin-escape.json'), JSON.stringify({ halo_hint: Object.fromEntries(refs.map(ref => [ref, 0.25])) }));
  const pr = { ...problem(), units: refs.map(ref => ({ name: ref, fixed: false, x: 0, y: 0, rects: [] })) };
  assert.deepEqual(Object.keys(boundedFeedback(pr, d, 'source', {}, 1)[0]).sort(), ['R1', 'R10', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7']);
});

test('congestion is opt-in, and only enclosed parts teach, not router misses', t => {
  const d = routeFolder(t);
  writeFileSync(join(d, 'open-triage.json'), JSON.stringify({ connections: [{ class_: 'ROUTER_MISS' }, { class: 'ENCLOSED', blocking_parts: ['R1', 'J1'] }] }));
  assert.deepEqual(boundedFeedback(problem(), d, 'source', {}, 1)[0], {});
  assert.deepEqual(boundedFeedback(problem(), d, 'source', {}, 1, true)[0], { R1: 0.25 });
});
