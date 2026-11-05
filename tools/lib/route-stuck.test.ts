import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { keepStuck, previousStuck, STUCK_FILE } from './route-stuck.ts';

function run(base: string, name: string, board: string, minute: number, stuck: boolean): string {
  const folder = join(base, name);
  mkdirSync(join(folder, 'operation'), { recursive: true });
  writeFileSync(join(folder, 'run.json'), JSON.stringify({ board, created_at: `2026-11-05T15:${String(minute).padStart(2, '0')}:00.000+00:00` }));
  if (stuck) writeFileSync(join(folder, STUCK_FILE), '{}');
  return folder;
}

test('a stuck route is kept with its run and compared with the last report of the same board', t => {
  const base = mkdtempSync(join(tmpdir(), 'route-stuck-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const newer = run(base, 'run-a', 'ENV-SENSE', 12, true), older = run(base, 'run-b', 'ENV-SENSE', 2, true);
  run(base, 'run-c', 'OTHER', 13, true);
  run(base, 'run-d', 'ENV-SENSE', 14, false);
  const current = run(base, 'run-e', 'ENV-SENSE', 15, false);
  assert.equal(previousStuck(current, 'ENV-SENSE'), join(newer, STUCK_FILE));
  assert.equal(previousStuck(older, 'NOTHING'), null);

  const work = join(base, 'work'), file = join(work, 'stuck.json');
  mkdirSync(work);
  assert.equal(keepStuck(current, 'ENV-SENSE', file), null);
  writeFileSync(file, JSON.stringify({ work, summary: ['first'] }));
  const compared: string[] = [];
  const kept = keepStuck(current, 'ENV-SENSE', file, (folder, _board, previous) => {
    compared.push(previous);
    writeFileSync(join(folder, 'stuck.json'), JSON.stringify({ work, summary: ['compared'] }));
  });
  assert.deepEqual(compared, [join(newer, STUCK_FILE)]);
  assert.deepEqual(kept?.summary, ['compared']);
});
