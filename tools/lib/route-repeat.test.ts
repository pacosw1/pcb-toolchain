import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sealFixtureBoard } from './cad-seal-fixture.ts';
import { exemptBoard } from './design-exempt-fixture.ts';
import { admitAction } from './pcb-action.ts';
import { candidateFields } from './pcb-candidate-admission.ts';
import { startCheck } from './pcb-check-start.ts';
import { MOVE_SCHEMA } from './route-moves.ts';
import { assertRouteNotRepeated } from './route-repeat.ts';

const ROOT = '/work/pcb';
const action = (source_revision: string, parameters_sha256: string) => ({ source_revision, parameters_sha256 });
const same = action('src-1', 'params-1');

function fixture(t: { after(fn: () => void): void }) {
  const base = mkdtempSync(join(tmpdir(), 'route-repeat-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const run = (id: string, manifest: Record<string, unknown>, files: Record<string, unknown> = {}) => {
    const folder = join(base, id);
    mkdirSync(join(folder, 'operation'), { recursive: true });
    writeFileSync(join(folder, 'run.json'), JSON.stringify({ root: ROOT, board: 'X', ...manifest }));
    for (const [name, value] of Object.entries(files)) writeFileSync(join(folder, name), JSON.stringify(value));
    return folder;
  };
  const stuck = (id: string, created_at: string, extra: Record<string, unknown> = {}) =>
    run(id, { operation: 'route', created_at, action: same, ...extra }, { 'operation/stuck.json': { board: 'X' } });
  const decide = (id: string, evidence: string, status = 'accepted') =>
    run(id, { operation: 'routing', created_at: '2026-11-06T10:05:00Z' }, { 'operation/report.json': { schema: MOVE_SCHEMA, status, evidence_sha256: { [evidence]: 'x' } } });
  return { base, run, stuck, decide };
}

test('a route is refused when the latest route ended stuck, no decision is recorded and the inputs are the same', t => {
  const f = fixture(t), folder = f.stuck('run-a', '2026-11-06T10:00:00Z');
  assert.throws(() => assertRouteNotRepeated(f.base, ROOT, 'X', same), (error: Error) => {
    assert.match(error.message, /run-a/);
    assert.match(error.message, new RegExp(`tools/pcb routing --json --follow move X --evidence ${join(folder, 'operation/stuck.json')}`));
    return true;
  });
});

test('a changed source revision or changed parameters allow the route', t => {
  const f = fixture(t); f.stuck('run-a', '2026-11-06T10:00:00Z');
  assertRouteNotRepeated(f.base, ROOT, 'X', action('src-2', 'params-1'));
  assertRouteNotRepeated(f.base, ROOT, 'X', action('src-1', 'params-2'));
});

test('an accepted route decision for that run allows the route; a rejected one or one for another run does not', t => {
  const f = fixture(t), folder = f.stuck('run-a', '2026-11-06T10:00:00Z'), evidence = join(folder, 'operation/stuck.json');
  f.decide('run-d1', evidence, 'rejected');
  f.decide('run-d2', join(f.base, 'run-other/operation/stuck.json'));
  assert.throws(() => assertRouteNotRepeated(f.base, ROOT, 'X', same), /run-a/);
  f.decide('run-d3', evidence);
  assertRouteNotRepeated(f.base, ROOT, 'X', same);
});

test('only the latest route counts: a later clean route clears an earlier stuck one', t => {
  const f = fixture(t); f.stuck('run-a', '2026-11-06T10:00:00Z');
  f.run('run-b', { operation: 'route', created_at: '2026-11-06T11:00:00Z', action: same });
  assertRouteNotRepeated(f.base, ROOT, 'X', same);
});

test('other boards, other checkouts and other operations are not the latest route of this board', t => {
  const f = fixture(t);
  f.stuck('run-a', '2026-11-06T10:00:00Z', { board: 'Y' });
  f.stuck('run-b', '2026-11-06T10:00:00Z', { root: '/work/other' });
  f.stuck('run-c', '2026-11-06T10:00:00Z', { operation: 'edit' });
  assertRouteNotRepeated(f.base, ROOT, 'X', same);
});

test('a stuck run without an admitted action record is not shown to differ, so the route is refused', t => {
  const f = fixture(t); f.run('run-a', { operation: 'route', created_at: '2026-11-06T10:00:00Z' }, { 'operation/stuck.json': { board: 'X' } });
  assert.throws(() => assertRouteNotRepeated(f.base, ROOT, 'X', same), /run-a/);
});

test('a missing runs folder has no stuck route', () => {
  assertRouteNotRepeated(join(tmpdir(), 'route-repeat-missing-folder'), ROOT, 'X', same);
});

function stuckStart(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'route-repeat-start-'))), base = join(root, '.gate/cli');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const board = join(root, 'hardware-design/boards/X');
  mkdirSync(join(board, 'cad'), { recursive: true });
  symlinkSync(fileURLToPath(new URL('..', import.meta.url)), join(root, 'tools'));
  writeFileSync(join(board, 'gate.json'), '{"project":"cad/X","checks":{}}');
  writeFileSync(join(board, 'cad/X.kicad_pcb'), '(kicad_pcb (version 20240108))');
  exemptBoard(root, 'X');
  sealFixtureBoard(root, 'X');
  const spec = join(root, 'spec.json');
  writeFileSync(spec, JSON.stringify({ routes: [] }));
  const request = { root, base, board: 'X', operation: 'route', spec, timeout: 20, heartbeat: 1 };
  const candidate = candidateFields(root, 'route', 'X', request);
  const admitted = admitAction({ root, board: 'X', operation: 'route', timeout_s: 20, ...candidate } as never);
  mkdirSync(join(base, 'run-a/operation'), { recursive: true });
  writeFileSync(join(base, 'run-a/run.json'), JSON.stringify({ root, board: 'X', operation: 'route', created_at: '2026-11-06T10:00:00Z', action: admitted }));
  writeFileSync(join(base, 'run-a/operation/stuck.json'), '{}');
  return { base, request, revision: (admitted as { source_revision: string }).source_revision };
}

const loop = (source_sha256: string, deadline_ms: number) => ({ id: 'loop-0123456789abcdef', round: 2, launch_id: 'a'.repeat(24), source_sha256, deadline_ms });

test('route admission stops a repeat of a stuck route before a run folder or a worker exists', async t => {
  const f = stuckStart(t);
  await assert.rejects(startCheck(f.request), /route stopped.*run-a.*routing --json --follow move X --evidence/s);
  assert.deepEqual(readdirSync(f.base), ['run-a']);
});

test('B10: a valid loop context does not skip the stop of a repeated route', async t => {
  const f = stuckStart(t);
  await assert.rejects(startCheck({ ...f.request, loopContext: loop(f.revision, Date.now() + 60_000) }), /route stopped.*run-a/s);
  assert.deepEqual(readdirSync(f.base), ['run-a']);
});

test('B10: a loop context with another source, an old deadline or a bad id stops the start', async t => {
  const f = stuckStart(t), now = Date.now();
  for (const loopContext of [loop('other', now + 60_000), loop(f.revision, now - 1), { ...loop(f.revision, now + 60_000), id: 'loop-x' }, { ...loop(f.revision, now + 60_000), round: 9 }])
    await assert.rejects(startCheck({ ...f.request, loopContext }), /invalid or expired loop context/);
});
