import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { assertWritable, freezeStatus, recordUnfreeze } from './board-freeze.ts';
import { acceptSeal, sealedWrite } from './cad-seal.ts';
import { sealFixtureBoard } from './cad-seal-fixture.ts';
import { gateInputs } from './gate-inputs.mjs';
import { iotrouteMissing } from './iotroute-bin.ts';
import { changeRules } from '../pcb-constraints.ts';

const needsBinary = { skip: iotrouteMissing() };   // the rule command holds a lock through the binary
const writer = { tool: 'unit', run_id: null };
const NONE = Symbol('no frozen field');

function project(t: { after(fn: () => void): void }, frozen: unknown = { reason: 'sent to the fab' }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'board-freeze-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (relative: string, content: string) => { const path = join(root, relative); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); return path; };
  put('hardware-design/boards/X/gate.json', JSON.stringify({ project: 'cad/X', checks: {} }));
  for (const ext of ['kicad_pcb', 'kicad_sch', 'kicad_pro']) put(`hardware-design/boards/X/cad/X.${ext}`, `fixture ${ext}`);
  put('hardware-design/boards/Y/gate.json', JSON.stringify({ project: 'cad/Y', checks: {} }));
  const registry = (row: Record<string, unknown>) => put('hardware-design/registry/boards.json', JSON.stringify({ schema_version: 1, boards: [{ id: 'X', directory: 'X', ...row }, { id: 'Y', directory: 'Y' }] }));
  registry(frozen === NONE ? {} : { frozen });
  sealFixtureBoard(root, 'X');
  return { root, put, registry, pcb: join(root, 'hardware-design/boards/X/cad/X.kicad_pcb'), record: join(root, 'hardware-design/boards/X/unfreeze.json') };
}

test('a board with no frozen field is writable and a frozen board without a record is not', t => {
  const open = project(t, NONE);
  assert.equal(freezeStatus(open.root, 'X').state, 'not_frozen');
  assert.doesNotThrow(() => assertWritable(open.root, 'X'));
  const frozen = project(t);
  assert.equal(freezeStatus(frozen.root, 'X').state, 'frozen');
  assert.throws(() => assertWritable(frozen.root, 'X'), /X is frozen: sent to the fab[\s\S]*tools\/pcb unfreeze X --record/);
  assert.doesNotThrow(() => assertWritable(frozen.root, 'Y'));
});

test('a frozen field without a reason is an error, never a free board', t => {
  for (const bad of [true, 'yes', [], null, {}, { reason: '' }, { reason: ' ' }, { reason: 1 }]) {
    const p = project(t, bad);
    assert.throws(() => freezeStatus(p.root, 'X'), /frozen of X must be an object with a non-empty reason/, JSON.stringify(bad));
  }
});

test('an unfreeze record lets a frozen board be written, and a bad record does not', t => {
  const p = project(t);
  const done = recordUnfreeze(p.root, 'X', { by: 'Ana', reason: 'fix a short found after the fab check' });
  assert.deepEqual(Object.keys(done), ['schema', 'board', 'by', 'reason', 'frozen_reason']);
  assert.equal(done.frozen_reason, 'sent to the fab');
  assert.equal(freezeStatus(p.root, 'X').state, 'unfrozen');
  assert.doesNotThrow(() => assertWritable(p.root, 'X'));
  for (const bad of ['not json', '{}', JSON.stringify({ ...done, board: 'Y' }), JSON.stringify({ ...done, by: ' ' }), JSON.stringify({ ...done, reason: '' }), JSON.stringify({ ...done, schema: 'other' })]) {
    writeFileSync(p.record, bad);
    assert.equal(freezeStatus(p.root, 'X').state, 'invalid', bad);
    assert.throws(() => assertWritable(p.root, 'X'), /unfreeze record/, bad);
  }
});

test('a record of the unfreeze is refused for a board that is not frozen and without a person or a reason', t => {
  const open = project(t, NONE);
  assert.throws(() => recordUnfreeze(open.root, 'X', { by: 'Ana', reason: 'x' }), /X is not frozen/);
  const p = project(t);
  assert.throws(() => recordUnfreeze(p.root, 'X', { by: ' ', reason: 'x' }), /--by/);
  assert.throws(() => recordUnfreeze(p.root, 'X', { by: 'Ana', reason: '' }), /--reason/);
  assert.equal(existsSync(p.record), false);
});

test('a rule change on a frozen board is refused before it reads anything', needsBinary, async t => {
  const p = project(t);
  await assert.rejects(changeRules(p.root, 'X', { remove: 'any-rule', reason: 'fix' }), /X is frozen/);
  recordUnfreeze(p.root, 'X', { by: 'Ana', reason: 'fix' });
  await assert.rejects(changeRules(p.root, 'X', { remove: 'any-rule', reason: 'fix' }), /unknown rule: any-rule/);
});

test('the unfreeze record is no gate input', t => {
  const p = project(t);
  recordUnfreeze(p.root, 'X', { by: 'Ana', reason: 'fix' });
  const inputs = gateInputs(p.root, 'X').files as string[];
  assert.equal(inputs.some(path => path.endsWith('unfreeze.json')), false);
  assert.equal(inputs.some(path => path.endsWith('gate.json')), true);
});

test('a sealed write and an accepted seal on a frozen board are refused and change nothing', async t => {
  const p = project(t);
  let ran = false;
  const before = readFileSync(p.pcb, 'utf8');
  assert.throws(() => sealedWrite(p.pcb, writer, () => { ran = true; writeFileSync(p.pcb, 'changed'); }), /X is frozen/);
  assert.equal(ran, false);
  assert.equal(readFileSync(p.pcb, 'utf8'), before);
  await assert.rejects(acceptSeal(p.root, 'X', 'first seal'), /X is frozen/);
  recordUnfreeze(p.root, 'X', { by: 'Ana', reason: 'fix' });
  sealedWrite(p.pcb, writer, () => { ran = true; writeFileSync(p.pcb, 'changed'); });
  assert.equal(ran, true);
});
