// What place.ts refuses before a search or a write. The fixture board is the one of tools/lib/engineering-constraints.test.ts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { SCHEMA, type ReviewServices } from '../lib/engineering-constraints.ts';
import { parseTyped, sha256File } from '../lib/json-file.ts';
import { jsonDumps } from '../lib/py-compat.mjs';
import { prepareProblem, type ReviewedProblem } from './engineering-problem.ts';
import { cmdRun, cmdWrite } from './place.ts';

const fp = (ref: string, x: number, y: number) => `(footprint "Test:Exact" (layer "F.Cu") (at ${x} ${y}) (uuid "${ref}")
  (property "Reference" "${ref}" (at 0 0)) (property "Value" "fixture")
  (fp_rect (start -0.5 -0.5) (end 0.5 0.5) (layer "F.CrtYd"))
  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask") (net "N") (uuid "${ref}-pad")))`;

let root: string, native: string, manifest: string, document: string, prob: string, review: Record<string, unknown>;

const services: ReviewServices = { verifyManifest: () => parseTyped(jsonDumps(review)), verifyEscapeEvidence: () => [] };

const hashes = () => Object.fromEntries(['.kicad_pcb', '.kicad_sch', '.kicad_pro', '.kicad_dru'].map(extension => {
  const path = native.replace(/\.kicad_pcb$/, extension);
  return [path, sha256File(path)];
}));

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'place-')));
  const folder = join(root, 'hardware-design/boards/X');
  mkdirSync(join(folder, 'cad'), { recursive: true });
  writeFileSync(join(folder, 'gate.json'), JSON.stringify({ project: 'cad/X', checks: { erc: true, drc: true } }));
  native = join(folder, 'cad/X.kicad_pcb');
  writeFileSync(native, `(kicad_pcb (version 20260101) ${fp('U1', 10, 10)}(gr_rect (start 0 0) (end 20 20) (layer "Edge.Cuts")))`);
  for (const extension of ['.kicad_pro', '.kicad_dru', '.kicad_sch']) writeFileSync(native.replace(/\.kicad_pcb$/, extension), 'fixture');
  document = join(root, 'reviewed.pdf');
  writeFileSync(document, '%PDF-1.4 fixture-source-only\n');
  manifest = join(root, 'parts.json');
  writeFileSync(manifest, '{"fixture":true}\n');
  const source = { path: 'reviewed.pdf', sha256: sha256File(document), page: 1 };
  review = { status: 'passed', constraints: { schema: SCHEMA, rules: [{ id: 'f', kind: 'fixed', refs: ['U1'], source }] }, native_inputs: hashes() };
  const problem = { board_file: native, units: [{ name: 'U1', refs: ['U1'], x: 10, y: 10, fixed: false, rects: [] }], nets: [], board: { outline: [[0, 0], [20, 0], [20, 20], [0, 20]] } } as unknown as ReviewedProblem;
  prob = join(root, 'problem.json');
  writeFileSync(prob, jsonDumps(prepareProblem(root, 'X', manifest, problem, services)));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const candidate = () => ({ cost: 0, components: {}, illegal: [] as string[], mains: [], worker: 0, pose: [[10, 10, 0]], timeout: false });

function fakeSearch(result: string, calls: string[][] = []) {
  return async (_prob: string, output: string, _workers: number, flags: readonly string[]) => {
    calls.push([...flags]);
    writeFileSync(output, result);
    return 0;
  };
}

const output = () => join(root, 'result.json');
const run = (...flags: string[]) => [prob, '-o', output(), '--workers', '1', ...flags];

test('a stale review stops a run before admission', async () => {
  writeFileSync(document, 'changed source PDF');
  const calls: string[][] = [];
  await assert.rejects(cmdRun(run(), { review: services, search: fakeSearch('{}', calls) }), /input changed/);
  assert.equal(calls.length, 0);
});

test('a wrong frozen digest stops a run before admission', async () => {
  const calls: string[][] = [];
  await assert.rejects(cmdRun(run('--engineering-frozen-model-sha256', 'wrong'), { review: services, search: fakeSearch('{}', calls) }), /fingerprint differs/);
  assert.equal(calls.length, 0);
});

test('a frozen digest needs a reviewed problem', async () => {
  writeFileSync(prob, jsonDumps({ units: [], nets: [], board: { outline: [] } }));
  await assert.rejects(cmdRun(run('--engineering-frozen-model-sha256', digest(prob)), { review: services, search: fakeSearch('{}') }), /fingerprint differs/);
});

test('a frozen model runs on its digest and says the producer must recheck', async () => {
  const calls: string[][] = [];
  const expected = digest(prob);
  writeFileSync(document, 'producer input changed while remote work was running');
  const code = await cmdRun(run('--engineering-frozen-model-sha256', expected), { review: services, search: fakeSearch(JSON.stringify({ candidates: [candidate()] }), calls) });
  assert.equal(code, 0);
  assert.ok(calls[0]!.join(' ').includes(`--engineering-frozen-model-sha256 ${expected}`));
  const shown = JSON.parse(readFileSync(output(), 'utf8')) as { engineering_source_verification: string; candidates: { engineering: { qualified: boolean } }[] };
  assert.match(shown.engineering_source_verification, /producer must recheck/);
  assert.equal(shown.candidates[0]!.engineering.qualified, false);
});

test('a reviewed run hands the search the digest of the verified file', async () => {
  const calls: string[][] = [];
  await cmdRun(run(), { review: services, search: fakeSearch(JSON.stringify({ candidates: [candidate()] }), calls) });
  assert.ok(calls[0]!.join(' ').includes(`--engineering-frozen-model-sha256 ${digest(prob)}`));
  assert.match(readFileSync(output(), 'utf8'), /current_source_inputs_verified/);
});

test('a candidate that breaks the contract is illegal and ranks last', async () => {
  const moved = { ...candidate(), pose: [[11, 10, 0]], cost: -5 };
  const code = await cmdRun(run(), { review: services, search: fakeSearch(JSON.stringify({ candidates: [moved, candidate()] })) });
  assert.equal(code, 0);
  const shown = JSON.parse(readFileSync(output(), 'utf8')) as { candidates: { illegal: string[]; cost: number }[] };
  assert.deepEqual(shown.candidates.map(row => row.illegal), [[], ['engineering:f']]);
  const all = await cmdRun(run(), { review: services, search: fakeSearch(JSON.stringify({ candidates: [moved] })) });
  assert.equal(all, 3);
});

test('engineering screening preserves the native sparse-map pressure ranking', async () => {
  const high = { ...candidate(), worker: 0, cost: 1, route_score: 0, route_pressure: 0.1 };
  const low = { ...candidate(), worker: 1, cost: 2, route_score: 0, route_pressure: 0.05 };
  await cmdRun(run(), { review: services, search: fakeSearch(JSON.stringify({ candidates: [high, low] })) });
  const shown = JSON.parse(readFileSync(output(), 'utf8'));
  assert.deepEqual(shown.candidates.map((c: { worker: number }) => c.worker), [1, 0]);
});

test('the writer refuses another source before it replaces any output', () => {
  const other = join(root, 'other.kicad_pcb');
  writeFileSync(other, 'other');
  const result = join(root, 'res.json');
  writeFileSync(result, JSON.stringify({ candidates: [candidate()] }));
  const outdir = join(root, 'output'), marker = join(outdir, 'cand0/keep.txt');
  mkdirSync(join(outdir, 'cand0'), { recursive: true });
  writeFileSync(marker, 'existing result');
  assert.throws(() => cmdWrite([other, prob, result, '--outdir', outdir], services), /writer source differs/);
  assert.equal(readFileSync(marker, 'utf8'), 'existing result');
});

test('the writer refuses a pose that breaks the contract before it replaces any output', () => {
  const result = join(root, 'res.json');
  writeFileSync(result, JSON.stringify({ candidates: [{ ...candidate(), pose: [[11, 10, 0]] }] }));
  const outdir = join(root, 'output'), marker = join(outdir, 'cand0/keep.txt');
  mkdirSync(join(outdir, 'cand0'), { recursive: true });
  writeFileSync(marker, 'existing result');
  assert.throws(() => cmdWrite([native, prob, result, '--outdir', outdir], services), /rejected before writing/);
  assert.equal(readFileSync(marker, 'utf8'), 'existing result');
});
