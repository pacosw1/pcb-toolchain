import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

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
    const bin = resolve('bin/pcb');
    const args = ['--project', root];
    const options = { encoding: 'utf8' as const, env: { ...process.env, PATH: `${shim}:${process.env.PATH}` } };
    const status = JSON.parse(execFileSync(bin, [...args, 'status', 'run-test', '--json'], options));
    assert.equal(status.status, 'passed');
    assert.equal(status.evidence_dir, realpathSync(folder));
    const lines = execFileSync(bin, [...args, 'events', 'run-test', '--json'], options).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].cursor, Buffer.byteLength(first));
    assert.equal(execFileSync(bin, [...args, 'events', 'run-test', '--after', String(lines[0].cursor), '--json'], options), '');
    const bad = spawnSync(bin, [...args, 'events', 'run-test', '--after', '1', '--json'], options);
    assert.equal(bad.status, 2);
    assert.match(JSON.parse(bad.stdout).cause, /line boundary/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
