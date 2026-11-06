import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { admitAction, verifyAction, type ActionRequest } from './pcb-action.ts';
import { sourceState } from './pcb-sources.ts';
import { runOperation } from './pcb-candidate-run.ts';
import { fingerprint } from './fingerprint.ts';
import { sha256File } from './json-file.ts';

function fixture(t: TestContext): { root: string; pcb: string; request: ActionRequest } {
  const root = mkdtempSync(join(tmpdir(), 'pcb-action-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'tools'));
  writeFileSync(join(root, 'tools/pcb_snapshot_inputs.mjs'), 'console.log("[]")');
  const board = join(root, 'hardware-design/boards/X'); mkdirSync(board, { recursive: true });
  writeFileSync(join(board, 'gate.json'), JSON.stringify({ project: 'X', stage: 'G3', checks: { erc: true } }));
  const pcb = join(board, 'X.kicad_pcb'); writeFileSync(pcb, '(kicad_pcb (version 20260101))');
  return { root, pcb, request: { root, board: 'X', operation: 'route', router: 'explicit', spec: {
    routes: [{ net: 'N', layer: 'F.Cu', width: 0.2, path: [[0, 0], [1, 0]] }],
  } } };
}

test('one action record binds explicit placement, routing and diagnosed repair', t => {
  const { root, request } = fixture(t);
  const plan = join(root, 'plan.json'), content = { choice: { strategy: 'straight_gap_bridge', net: 'N', layer: 'F.Cu', endpoint_ids: ['a', 'b'] } };
  writeFileSync(plan, JSON.stringify(content));
  for (const current of [request,
    { ...request, operation: 'edit', kind: 'route', router: undefined },
    { root, board: 'X', operation: 'edit', kind: 'place', spec: { place: { U1: [0, 0, 90] } } },
    { root, board: 'X', operation: 'repair', plan: { path: plan, sha256: sha256File(plan), content } },
  ] as ActionRequest[]) {
    const action = admitAction(current)!;
    assert.equal(action.prerequisite_stage, current.kind === 'place' ? 'schematic' : 'placement');
    verifyAction(current, action);
    assert.match(action.source_revision, /^[a-f0-9]{64}$/);
    assert.equal(action.action_id, admitAction(current)!.action_id);
  }
  assert.equal(admitAction({ root, board: 'X', operation: 'build' }), undefined);
});

test('unknown envelope fields, changed parameters and unauthorized net/layer scope fail closed', t => {
  const { request } = fixture(t), action = admitAction(request)!;
  assert.throws(() => verifyAction(request, { ...action, unexpected_policy: {} }), /unknown fields/);
  assert.throws(() => verifyAction(request, { ...action, scope: { ...action.scope, region: [] } }), /unknown fields/);
  const original = request.spec!.routes as Record<string, unknown>[];
  for (const [key, value, message] of [['net', 'OTHER', /nets scope/], ['layer', 'B.Cu', /layers scope/]] as const) {
    assert.throws(() => verifyAction({ ...request, spec: { routes: [{ ...original[0], [key]: value }] } }, action), message);
  }
  assert.throws(() => verifyAction({ ...request, spec: { routes: [{ ...original[0], width: 0.3 }] } }, action), /parameters changed/);
  assert.throws(() => verifyAction({ ...request, timeout_s: 9999 }, action), /parameters changed/);
  assert.throws(() => verifyAction({ ...request, operation: 'build' }, action), /identity mismatch/);
  assert.throws(() => verifyAction(request, undefined), /candidate action: expected an object/);
});

test('out-of-order stage is rejected even with a recomputed non-secret action ID', t => {
  const { request } = fixture(t), action = admitAction(request)!;
  const { action_id, ...body } = { ...action, prerequisite_stage: 'schematic' };
  assert.throws(() => verifyAction(request, { ...body, action_id: fingerprint(body) }), /out of order/);
});

test('source changes after admission stop the owned operation before design/native work or snapshot', async t => {
  const { root, pcb, request } = fixture(t), contract = join(root, 'contract.json');
  // If action admission fails to stop first, the design verifier cannot load this deliberately invalid contract.
  writeFileSync(contract, '{}');
  request.design_contract = { path: contract, sha256: sha256File(contract), content: {} };
  const action = admitAction(request)!;
  writeFileSync(pcb, readFileSync(pcb, 'utf8') + '\n');
  writeFileSync(join(root, 'run.json'), JSON.stringify({ ...request, action }));
  await assert.rejects(runOperation(root), /source revision is stale/);
  assert.equal(existsSync(join(root, 'workspace')), false);
  assert.equal(existsSync(join(root, 'operation/design-preflight.json')), false);
});

test('through-via and clear scopes cover copper across the stack, and cannot be added later', t => {
  const { request } = fixture(t), action = admitAction(request)!;
  const changed = { ...request, spec: { routes: [], clear: ['N'] } };
  assert.throws(() => verifyAction(changed, action), /copper scope/);
  assert.equal(admitAction(changed)!.scope.all_layers, true);
  const via = { ...request, spec: { routes: [{ net: 'N', layer: 'F.Cu', width: 0.2, path: [[0, 0], { via: [1, 0] }, [2, 0]] }] } };
  assert.equal(admitAction(via)!.scope.all_layers, true);
});

test('a snapshot of another revision is refused even if canonical source was restored', t => {
  const { request } = fixture(t), action = admitAction(request)!, snapshot = sourceState(request.root, request.board);
  snapshot.files['hardware-design/boards/X/X.kicad_pcb'] = '0'.repeat(64);
  assert.throws(() => verifyAction(request, action, snapshot), /snapshot differs/);
});

test('review and parent changes are rejected before source/native work', t => {
  const { root, request } = fixture(t), review = join(root, 'review.json');
  writeFileSync(review, '{}');
  request.engineering_manifest = { path: review, sha256: sha256File(review), content: {} };
  const action = admitAction(request)!;
  writeFileSync(review, '{"changed":true}');
  assert.throws(() => verifyAction(request, action), /reviewed input changed/);
  delete request.engineering_manifest;
  const parent = join(root, 'parent'); mkdirSync(parent); writeFileSync(join(parent, 'result.json'), '{}');
  request.from_run = { folder: parent, result_sha256: sha256File(join(parent, 'result.json')) };
  const next = admitAction(request)!;
  writeFileSync(join(parent, 'result.json'), '{"changed":true}');
  assert.throws(() => verifyAction(request, next), /parent revision is stale/);
});
