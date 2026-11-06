import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rewriteCase, trialFixture, type Trial } from './agent-trial-fixture.ts';
import { prepareTrial } from './agent-trial-prepare.ts';
import { runTrial } from './agent-trial-run.ts';

const read = (path: string) => readFileSync(path, 'utf8');
const json = (path: string) => JSON.parse(read(path)) as Record<string, any>;
const noLock = async () => () => {};

/** A prepared trial whose agent is the shell script BODY. */
function prepared(body: string, change: (value: Record<string, any>) => void = () => {}): Trial {
  const t = trialFixture();
  const script = join(t.base, 'agent.sh');
  writeFileSync(script, `#!/bin/sh\n${body}\n`);
  chmodSync(script, 0o755);
  rewriteCase(t, v => { v.agent = { argv: ['/bin/sh', script, '{root}', '{prompt_file}'], parser: 'claude-stream-json', env: { FROM_CASE: 'yes' } }; change(v); });
  prepareTrial({ casePath: t.casePath, lab: t.lab, out: t.out, toolchain: t.toolchain });
  return t;
}
const ticks = (...values: number[]) => { const list = [...values]; return () => list.shift() ?? values.at(-1)!; };

test('the agent runs in the project with the case env, IOT_LAB, no stdin, and its streams are saved', async () => {
  const t = prepared('echo \'{"type":"system"}\'; echo "cwd=$(pwd -P) lab=$IOT_LAB case=$FROM_CASE runs=$PCB_RUNS_DIR stdin=$(cat | wc -c | tr -d " ") prompt=$(cat "$2")"; echo oops >&2; exit 3');
  try {
    const record = await runTrial(t.out, { lock: noLock, clock: ticks(1_000_000, 1_042_500) });
    const project = join(t.out, 'project');
    assert.deepEqual([record.exit_code, record.signal, record.timed_out, record.wall_s], [3, null, false, 42.5]);
    assert.deepEqual(json(join(t.out, 'run.json')), record);
    const lines = read(join(t.out, 'agent.stdout.jsonl')).trim().split('\n');
    assert.equal(lines[0], '{"type":"system"}');
    assert.equal(lines[1], `cwd=${project} lab=${project} case=yes runs=${project}/.gate/cli stdin=0 prompt=Make the board pass the gate.`);
    assert.equal(read(join(t.out, 'agent.stderr.log')), 'oops\n');
    assert.deepEqual(record.argv.slice(0, 2), ['/bin/sh', join(t.base, 'agent.sh')]);
    assert.equal(record.argv[2], project);
    assert.equal(record.started_at, new Date(1_000_000).toISOString());
  } finally { t.cleanup(); }
});

test('one deadline: SIGINT at budget.timeout_s, and the run is marked timed out', async () => {
  const t = prepared('exec sleep 30', v => { v.budget.timeout_s = 0.2; });
  try {
    const record = await runTrial(t.out, { lock: noLock, graceMs: 5000 });
    assert.equal(record.timed_out, true);
    assert.equal(record.signal, 'SIGINT');
    assert.equal(record.exit_code, null);
  } finally { t.cleanup(); }
});

test('after the grace time a process that ignores SIGINT is killed', async () => {
  const t = prepared('trap "" INT; while :; do :; done', v => { v.budget.timeout_s = 0.2; });
  try {
    const record = await runTrial(t.out, { lock: noLock, graceMs: 100 });
    assert.deepEqual([record.timed_out, record.signal], [true, 'SIGKILL']);
  } finally { t.cleanup(); }
});

test('a second run in the same DIR, and a DIR that was never prepared, are refused', async () => {
  const t = prepared('exit 0');
  try {
    await runTrial(t.out, { lock: noLock });
    await assert.rejects(runTrial(t.out, { lock: noLock }), /already ran/);
    await assert.rejects(runTrial(join(t.base, 'nothing'), { lock: noLock }), /not prepared/);
  } finally { t.cleanup(); }
});

test('the benchmark lock is held while the agent runs and freed after; a held lock stops the run before it starts', async () => {
  const t = prepared('exit 0');
  try {
    const events: string[] = [];
    await runTrial(t.out, { lock: async label => { events.push(`take ${label.startsWith('trial ')}`); return () => { events.push(`free ${existsSync(join(t.out, 'run.json'))}`); }; } });
    assert.deepEqual(events, ['take true', 'free true'], 'released after run.json is written');
    const second = trialFixture();
    try {
      prepareTrial({ casePath: second.casePath, lab: second.lab, out: second.out, toolchain: second.toolchain });
      await assert.rejects(runTrial(second.out, { lock: async () => { throw new Error('bench lock is held by pid 1'); } }), /bench lock is held/);
      assert.ok(!existsSync(join(second.out, 'run.json')) && !existsSync(join(second.out, 'agent.stdout.jsonl')));
    } finally { second.cleanup(); }
  } finally { t.cleanup(); }
});

test('an agent command that cannot start is a recorded failure, not a silent success', async () => {
  const t = trialFixture();
  try {
    rewriteCase(t, v => { v.agent.argv = ['/nonexistent/agent']; });
    prepareTrial({ casePath: t.casePath, lab: t.lab, out: t.out, toolchain: t.toolchain });
    const record = await runTrial(t.out, { lock: noLock });
    assert.equal(record.exit_code, null);
    assert.match(record.spawn_error ?? '', /ENOENT/);
    assert.equal(json(join(t.out, 'run.json')).spawn_error, record.spawn_error);
  } finally { t.cleanup(); }
});
