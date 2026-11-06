import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { designExemption } from './design-exemption.ts';
import { exemptBoard } from './design-exempt-fixture.ts';

function project(t: { after(fn: () => void): void }, registry?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'design-exemption-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (registry !== undefined) {
    const path = join(root, 'hardware-design/registry/boards.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof registry === 'string' ? registry : JSON.stringify(registry));
  }
  return root;
}
const registry = (...boards: unknown[]) => ({ schema_version: 1, boards });

test('a board with no registry or no row has no exemption', t => {
  assert.equal(designExemption(project(t), 'X'), null);
  assert.equal(designExemption(project(t, registry({ id: 'Y' })), 'X'), null);
  assert.equal(designExemption(project(t, registry({ id: 'X' })), 'X'), null);
});

test('the reason of the board row is the exemption', t => {
  const root = project(t, registry({ id: 'X', design_contract_exempt: { reason: 'legacy board' } }, { id: 'Y' }));
  assert.equal(designExemption(root, 'X'), 'legacy board');
  assert.equal(designExemption(root, 'Y'), null);
});

test('a gate of a revision resolves to its owner row', t => {
  const root = project(t, registry({ id: 'OWNER', revisions: [{ revision: 'A', gate: 'X' }], design_contract_exempt: { reason: 'owner reason' } }));
  assert.equal(designExemption(root, 'X'), 'owner reason');
});

test('an unreadable registry or a malformed exemption is an error, not an exemption', t => {
  assert.throws(() => designExemption(project(t, '{not json'), 'X'));
  assert.throws(() => designExemption(project(t, '[]'), 'X'), /JSON object/);
  assert.throws(() => designExemption(project(t, {}), 'X'), /boards list/);
  for (const bad of [true, 'reason', [], null, {}, { reason: '' }, { reason: '  ' }, { reason: 3 }]) {
    assert.throws(() => designExemption(project(t, registry({ id: 'X', design_contract_exempt: bad })), 'X'), /design_contract_exempt/, JSON.stringify(bad));
  }
});

test('the fixture helper adds a row, updates a row and finds the owner of a gate', t => {
  const fresh = project(t);
  exemptBoard(fresh, 'X');
  assert.ok(designExemption(fresh, 'X'));
  const known = project(t, registry({ id: 'X' }));
  exemptBoard(known, 'X', 'why');
  assert.equal(designExemption(known, 'X'), 'why');
  const owner = project(t, registry({ id: 'OWNER', revisions: [{ revision: 'A', gate: 'X' }] }));
  exemptBoard(owner, 'X', 'why');
  assert.equal(designExemption(owner, 'X'), 'why');
});
