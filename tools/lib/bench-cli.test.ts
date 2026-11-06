// tools/bench.ts as a program: bad runs must stop with a clear error and a non-zero exit code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SUITE } from './bench-suite.ts';

const BENCH = fileURLToPath(new URL('../bench.ts', import.meta.url));
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const bench = (args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', BENCH, ...args], { encoding: 'utf8' });

const suiteText = (argv: string[], seeds: number[]) => JSON.stringify({
  schema: SUITE, suite_id: 'cli', arms: [{ id: 'base', argv }, { id: 'new', argv }],
  boards: [{ family: 'A', board: 'ENV', split: 'development', input: { path: 'e', sha256: sha('e') } }, { family: 'B', board: 'REL', split: 'holdout', input: { path: 'r', sha256: sha('r') } }],
  seeds, budget: { timeout_s: 20, cpus: 1, memory_gb: 1 },
});

test('a run that dies after some trials cannot be resumed under a different suite', () => {
  const root = mkdtempSync(join(tmpdir(), 'bench-cli-'));
  try {
    writeFileSync(join(root, 'e'), 'e');
    writeFileSync(join(root, 'r'), 'r');
    const marker = join(root, 'marker');
    // The first trial leaves the marker; the second kills the bench process itself.
    const dying = join(root, 'dying.json'), other = join(root, 'other.json'), out = join(root, 'out');
    writeFileSync(dying, suiteText(['/bin/sh', '-c', 'test -f "$0" && kill -9 $PPID; touch "$0"', marker], [1, 2]));
    writeFileSync(other, suiteText(['/bin/sh', '-c', 'exit 0'], [1, 2, 3]));
    const first = bench(['run', dying, '--out', out, '--root', root, '--no-lock', '--no-analyze']);
    assert.equal(first.signal, 'SIGKILL');
    const second = bench(['run', other, '--out', out, '--root', root, '--no-lock', '--no-analyze']);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /already holds a different suite/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
