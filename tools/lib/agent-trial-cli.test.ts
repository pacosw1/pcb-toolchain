// tools/pcb trial as a program: the three commands in order with a fake agent, and the exit codes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resultIntact } from './agent-trial-collect.ts';
import { rewriteCase, trialFixture } from './agent-trial-fixture.ts';

const PCB = fileURLToPath(new URL('../pcb', import.meta.url));
const pcb = (...args: string[]) => spawnSync(PCB, ['trial', ...args], { encoding: 'utf8' });

test('prepare, run and collect through tools/pcb trial; a trial with no sealed run fails with exit 1', () => {
  const t = trialFixture();
  try {
    const agent = join(t.base, 'agent.sh');
    writeFileSync(agent, `#!/bin/sh\necho '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"a","name":"Bash"}]}}'\necho '{"type":"result","num_turns":1,"total_cost_usd":0.01,"usage":{"input_tokens":3,"output_tokens":4}}'\n`);
    chmodSync(agent, 0o755);
    rewriteCase(t, v => { v.agent.argv = ['/bin/sh', agent]; v.design_contract_exempt = true; });
    const prepared = pcb('prepare', t.casePath, '--lab', t.lab, '--out', t.out);
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.match(prepared.stdout, /prepared .*project: board X, lab commit [0-9a-f]{40}/);
    assert.equal(pcb('prepare', t.casePath, '--lab', t.lab, '--out', t.out).status, 1, 'the same DIR cannot be prepared twice');
    const ran = pcb('run', t.out, '--no-lock');
    assert.equal(ran.status, 0, ran.stderr);
    assert.ok(existsSync(join(t.out, 'run.json')));
    assert.equal(pcb('run', t.out, '--no-lock').status, 1, 'the same DIR cannot run twice');
    const collected = pcb('collect', t.out, '--json');
    assert.equal(collected.status, 1, collected.stderr);
    const result = JSON.parse(collected.stdout);
    assert.deepEqual([result.verdict, result.cause, result.agent.tokens_in, result.agent.tool_calls], ['failed', 'no_sealed_run', 3, 1]);
    assert.ok(resultIntact(JSON.parse(readFileSync(join(t.out, 'result.json'), 'utf8'))));
  } finally { t.cleanup(); }
});

test('a bad command line prints the usage and exits 2', () => {
  assert.equal(pcb('prepare').status, 2);
  assert.equal(pcb('prepare', 'case.json').status, 2);
  const unknown = pcb('explode', 'x');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /usage: agent-trial\.ts prepare CASE\.json/);
});

test('trial inputs is a command: a gate folder that is not there fails with a cause, not the usage text', () => {
  const run = pcb('inputs', '/nonexistent/gate', '--board', 'X');
  assert.notEqual(run.status, 0);
  assert.doesNotMatch(run.stderr, /usage:/);
});
