import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../pcb-unfreeze.ts', import.meta.url));

function fixture(t: { after(fn: () => void): void }, frozen: boolean, where = '') {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'unfreeze-cli-')));
  const root = where ? join(top, where) : top;
  t.after(() => rmSync(top, { recursive: true, force: true }));
  mkdirSync(join(root, 'hardware-design/boards/X'), { recursive: true });
  mkdirSync(join(root, 'hardware-design/registry'), { recursive: true });
  writeFileSync(join(root, 'hardware-design/registry/boards.json'), JSON.stringify({ schema_version: 1, boards: [{ id: 'X', directory: 'X', ...(frozen ? { frozen: { reason: 'sent to the fab' } } : {}) }] }));
  const call = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, '--project', root, 'unfreeze', ...args], { encoding: 'utf8' });
  return { root, call };
}

test('a frozen board exits 1 and names the command; a free board exits 0', t => {
  const frozen = fixture(t, true).call('X');
  assert.equal(frozen.status, 1);
  assert.match(frozen.stdout, /X is frozen: sent to the fab[\s\S]*tools\/pcb unfreeze X --record/);
  const free = fixture(t, false).call('X', '--json');
  assert.equal(free.status, 0);
  assert.equal(JSON.parse(free.stdout).state, 'not_frozen');
});

test('record writes the unfreeze record and then the state is unfrozen', t => {
  const f = fixture(t, true);
  const done = f.call('X', '--record', '--by', 'Ana', '--reason', 'fix a short', '--json');
  assert.equal(done.status, 0, done.stderr);
  assert.equal(JSON.parse(done.stdout).state, 'unfrozen');
  const record = JSON.parse(readFileSync(join(f.root, 'hardware-design/boards/X/unfreeze.json'), 'utf8'));
  assert.deepEqual([record.schema, record.board, record.by, record.reason, record.frozen_reason], ['iot-lab.unfreeze.v1', 'X', 'Ana', 'fix a short', 'sent to the fab']);
  assert.equal(f.call('X').status, 0);
});

test('record is refused in a run workspace and writes nothing', t => {
  const f = fixture(t, true, '.gate/workspace');
  const done = f.call('X', '--record', '--by', 'Ana', '--reason', 'fix');
  assert.notEqual(done.status, 0);
  assert.match(done.stderr, /not canonical/);
  assert.equal(existsSync(join(f.root, 'hardware-design/boards/X/unfreeze.json')), false);
});

test('record needs both values, a frozen board and a known board', t => {
  const f = fixture(t, true);
  assert.equal(f.call('X', '--record', '--by', 'Ana').status, 2);
  assert.equal(f.call('X', '--by', 'Ana').status, 2);
  assert.notEqual(f.call('NOPE').status, 0);
  const free = fixture(t, false).call('X', '--record', '--by', 'Ana', '--reason', 'x');
  assert.notEqual(free.status, 0);
  assert.match(free.stderr, /X is not frozen/);
});
