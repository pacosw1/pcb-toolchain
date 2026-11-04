import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { lastEvent, markStage, statusLine } from './route-progress.ts';

const TOOL = fileURLToPath(new URL('../route_status.ts', import.meta.url));
const ROUTE = '{"t": "2026-11-04T10:00:00", "t0": 1000.0, "elapsed_s": 12.0, "stage": "route", "pass": 2, "open": 20, "vias": null, "best_open": 20, "eta_s": 30.5}';

function inFolder(body: (folder: string, path: string) => void): void {
  const folder = mkdtempSync(join(tmpdir(), 'route-status-'));
  try {
    body(folder, join(folder, 'progress.jsonl'));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

const tool = (...args: string[]) => spawnSync(process.execPath, ['--no-warnings', TOOL, ...args], { encoding: 'utf8' });

test('the status line shows a missing value as a dash and a float as Python does', () => {
  inFolder((_, path) => {
    writeFileSync(path, `${ROUTE}\n`);
    assert.equal(statusLine(lastEvent(path)), 'route 12.0s open=20 best=20 vias=- eta=30.5');
  });
});

test('no file is no progress yet', () => {
  inFolder((_, path) => assert.equal(statusLine(lastEvent(path)), 'no progress yet'));
});

test('a half-written last line is skipped, an earlier bad line is an error', () => {
  inFolder((_, path) => {
    writeFileSync(path, `${ROUTE}\n{"t": "2026`);
    assert.equal(statusLine(lastEvent(path)), 'route 12.0s open=20 best=20 vias=- eta=30.5');
    writeFileSync(path, `{"t": "2026\n${ROUTE}\n`);
    assert.throws(() => lastEvent(path), /line 1 is not JSON/);
  });
});

test('a stage event keeps the job clock, the best count and the vias', () => {
  inFolder((_, path) => {
    writeFileSync(path, `${ROUTE.replace('"vias": null', '"vias": 7')}\n`);
    const row = markStage(path, 'gate start', new Date(1_100_000));
    assert.equal(statusLine(row), 'gate start 100.0s open=- best=20 vias=7 eta=-');
    const line = readFileSync(path, 'utf8').trimEnd().split('\n').at(-1)!;
    assert.match(line, /^\{"t": "[^"]+", "t0": 1000\.0, "elapsed_s": 100\.0, "stage": "gate start", "pass": null, "open": null, "vias": 7, "best_open": 20, "eta_s": null\}$/);
  });
});

test('the first stage event starts the clock', () => {
  inFolder((_, path) => {
    const row = markStage(path, 'gate start', new Date(5_000_000));
    assert.equal(statusLine(row), 'gate start 0.0s open=- best=- vias=- eta=-');
  });
});

test('the time of an event is local', () => {
  inFolder((_, path) => {
    const now = new Date(2026, 10, 4, 9, 8, 7);
    assert.equal(markStage(path, 'x', now).get('t'), '2026-11-04T09:08:07');
  });
});

test('the program prints the line, marks a stage and reads the log', () => {
  inFolder(folder => {
    assert.equal(tool(folder).stdout, 'no progress yet\n');
    assert.match(tool(folder, '--mark', 'gate').stdout, /^gate start 0\.0s /);
    assert.match(tool(folder, '--mark', 'gate', '--end').stdout, /^gate end [\d.]+s /);
    assert.match(tool(folder).stdout, /^gate end /);
    assert.equal(tool(folder, '--log').status, 0);
  });
});

test('no folder is a usage error', () => {
  const run = tool();
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^usage: /);
});
