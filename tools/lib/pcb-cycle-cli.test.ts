// tools/pcb cycle through the real dispatcher, with owned runs linked to it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { iotrouteMissing } from './iotroute-bin.ts';

type Row = Record<string, any>;
const tools = fileURLToPath(new URL('..', import.meta.url));
const needsBinary = { skip: iotrouteMissing() };

function project(t: { after(fn: () => void): void }): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pcb-cycle-cli-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'hardware-design/boards/X'), { recursive: true });
  writeFileSync(join(root, 'hardware-design/boards/X/gate.json'), '{"project":"cad/X"}');
  return root;
}
const pcb = (root: string, ...args: string[]) => spawnSync(join(tools, 'pcb'), ['--project', root, ...args], { encoding: 'utf8' });
const json = (root: string, ...args: string[]): Row => {
  const call = pcb(root, ...args, '--json');
  assert.equal(call.status, 0, call.stdout + call.stderr);
  return JSON.parse(call.stdout.trim().split('\n').at(-1)!) as Row;
};

test('a cycle records review intervals and needs one integration owner', needsBinary, t => {
  const root = project(t);
  const denied = pcb(root, 'cycle', 'start', 'X', '--json');
  assert.equal(denied.status, 2);
  assert.match(denied.stdout, /requires --owner/);
  const cycle = json(root, 'cycle', 'start', 'X', '--owner', 'integrator').cycle_id as string;
  const activity = json(root, 'cycle', 'begin', cycle, '--stage', 'schematic', '--owner', 'reviewer', '--description', 'Review exact pin mappings').activity_id as string;
  const review = join(root, 'review.json');
  writeFileSync(review, '{"unresolved":["pin mapping"]}');
  json(root, 'cycle', 'end', cycle, '--activity', activity, '--outcome', 'blocked', '--evidence', review, '--decision', 'Pin mapping remains unresolved');
  const closed = json(root, 'cycle', 'finish', cycle);
  assert.equal(closed.stages.schematic.blocked, 1);
  assert.equal(closed.status, 'recorded');
  assert.equal(pcb(root, 'cycle', 'begin', cycle, '--stage', 'nonsense', '--json').status, 2);
  assert.equal(pcb(root, 'cycle', 'nonsense', cycle, '--json').status, 2);
});

test('an owned run links itself to the cycle of its board, in the right stage', needsBinary, t => {
  const root = project(t);
  symlinkSync(tools, join(root, 'tools'));
  const cycle = json(root, 'cycle', 'start', 'X', '--owner', 'integrator').cycle_id as string;
  const train = pcb(root, 'ml', '--json', '--cycle', cycle, 'dataset', 'OTHER-ID', '--manifest', join(root, 'missing.json'));
  assert.equal(train.status, 1, train.stdout + train.stderr);
  const state = json(root, 'cycle', 'status', cycle);
  assert.equal(state.runs[0].stage, 'verification');
  assert.equal(state.runs[0].evidence_verified, true);
  assert.notEqual(state.covered_elapsed_s, null);
  const other = pcb(root, 'check', 'X-OTHER', '--cycle', cycle, '--json');
  assert.equal(other.status, 2);
});
