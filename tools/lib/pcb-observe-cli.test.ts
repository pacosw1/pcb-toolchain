import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { holdLock } from './file-lock.ts';
import { iotrouteBin, iotrouteMissing } from './iotroute-bin.ts';

test('installed launcher reads run status and byte-cursored events without Python', () => {
  const root = mkdtempSync(join(tmpdir(), 'pcb-observe-'));
  try {
    const folder = join(root, '.gate/cli/run-test');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'run.json'), '{}');
    writeFileSync(join(folder, 'state.json'), '{"status":"passed","updated_unix":1000,"elapsed_s":1}');
    const first = '{"run_id":"run-test","elapsed_s":1,"type":"tool.output","text":"é"}\n';
    writeFileSync(join(folder, 'events.jsonl'), first + '{"type":"unfinished"');
    const shim = join(root, 'bin');
    mkdirSync(shim);
    writeFileSync(join(shim, 'python3'), '#!/bin/sh\nexit 72\n', { mode: 0o755 });
    const bin = fileURLToPath(new URL('../../bin/pcb', import.meta.url));
    const args = ['--project', root];
    const options = { encoding: 'utf8' as const, env: { ...process.env, PATH: `${shim}:${process.env.PATH}` } };
    const boardFolder = join(root, 'hardware-design/boards/X');
    mkdirSync(boardFolder, { recursive: true });
    writeFileSync(join(boardFolder, 'gate.json'), '{"project":"cad/X","stage":"G3","checks":{"erc":true}}');
    const board = JSON.parse(execFileSync(bin, [...args, 'status', 'X', '--json'], options));
    assert.equal(board.board, 'X');
    assert.equal(board.stage, 'G3');
    assert.deepEqual(JSON.parse(execFileSync(bin, [...args, 'context', 'X', '--json'], options)), board);
    const next = JSON.parse(execFileSync(bin, [...args, 'next', 'X', '--json'], options));
    assert.equal(next.state, 'blocked');
    assert.equal(next.blocker.code, 'missing_native_input');
    assert.equal(next.readiness_verified, false);
    const list = JSON.parse(execFileSync(bin, [...args, 'list', '--json'], options));
    assert.deepEqual(list.boards.map((item: { board: string }) => item.board), ['X']);
    assert.equal(execFileSync(bin, [...args, 'list'], options), 'X\n');
    const status = JSON.parse(execFileSync(bin, [...args, 'status', 'run-test', '--json'], options));
    assert.equal(status.status, 'passed');
    assert.equal(status.evidence_dir, realpathSync(folder));
    const terminalCancel = JSON.parse(execFileSync(bin, [...args, 'cancel', 'run-test', '--json'], options));
    assert.equal(terminalCancel.status, 'passed');
    assert.equal(existsSync(join(folder, 'cancel.request')), false);
    writeFileSync(join(folder, 'state.json'), '{"status":"passed","updated_unix":9999999999,"elapsed_s":null,"cause":null}');
    assert.match(execFileSync(bin, [...args, 'status', 'run-test'], options), /passed/i);
    assert.match(execFileSync(bin, [...args, 'status', 'run-test'], options), /None; elapsed=None/);
    const gate = join(folder, 'gate');
    mkdirSync(gate);
    writeFileSync(join(gate, 'drc.json'), '{"violations":[{"description":"a"},{"description":"b"}]}');
    const explanation = JSON.parse(execFileSync(bin, [...args, 'explain', 'run-test', '--limit', '1', '--json'], options));
    assert.equal(explanation.details.length, 1);
    assert.equal(explanation.omitted, 1);
    assert.match(execFileSync(bin, [...args, 'explain', 'run-test', '--limit', '1'], options), /Evidence:/);
    const badExplain = spawnSync(bin, [...args, 'explain', 'run-test', '--limit', '0', '--json'], options);
    assert.equal(badExplain.status, 2);
    assert.equal(JSON.parse(badExplain.stdout).cause, '--limit must be between 1 and 1000');
    const lines = execFileSync(bin, [...args, 'events', 'run-test', '--json'], options).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].cursor, Buffer.byteLength(first));
    assert.equal(execFileSync(bin, [...args, 'events', 'run-test', '--after', String(lines[0].cursor), '--json'], options), '');
    const bad = spawnSync(bin, [...args, 'events', 'run-test', '--after', '1', '--json'], options);
    assert.equal(bad.status, 2);
    assert.match(JSON.parse(bad.stdout).cause, /line boundary/);
    const badLimit = spawnSync(bin, [...args, 'events', 'run-test', '--limit', '0', '--json'], options);
    assert.equal(badLimit.status, 2);
    assert.equal(JSON.parse(badLimit.stdout).cause, '--limit must be between 1 and 1000');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cancel requests an active supervisor without changing its durable state', { skip: iotrouteMissing() }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pcb-cancel-'));
  let lock: Awaited<ReturnType<typeof holdLock>> | undefined;
  try {
    const folder = join(root, '.gate/cli/run-active');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'run.json'), '{}');
    const raw = JSON.stringify({ status: 'running', updated_unix: Date.now() / 1000, elapsed_s: 1 });
    writeFileSync(join(folder, 'state.json'), raw);
    lock = await holdLock(join(folder, 'worker.lock'));
    const program = fileURLToPath(new URL('../pcb-observe.ts', import.meta.url));
    const text = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', program,
      '--project', root, 'cancel', 'run-active', '--json'], {
      encoding: 'utf8', env: { ...process.env, IOTROUTE_BIN: iotrouteBin() },
    });
    const result = JSON.parse(text);
    assert.equal(result.controller_alive, true);
    assert.equal(result.cancellation_requested, true);
    assert.equal(readFileSync(join(folder, 'state.json'), 'utf8'), raw);
    const request = JSON.parse(readFileSync(join(folder, 'cancel.request'), 'utf8'));
    assert.match(request.requested_at, /^\d{4}-\d\d-\d\dT.*\+00:00$/);
  } finally { if (lock) await lock.release(); rmSync(root, { recursive: true, force: true }); }
});
