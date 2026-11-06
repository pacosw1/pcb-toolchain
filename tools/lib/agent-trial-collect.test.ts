import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectTrial, parseAgentStream, resultIntact, type CollectServices } from './agent-trial-collect.ts';
import { rewriteCase, trialFixture, type Trial } from './agent-trial-fixture.ts';
import { prepareTrial } from './agent-trial-prepare.ts';
import { reseal } from './cad-seal.ts';
import { atomicJson, readObject, sha256File } from './json-file.ts';
import { evidenceFiles } from './pcb-evidence.ts';

const json = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
const fresh: CollectServices = { verifyInputs: async () => {} };
const stale: CollectServices = { verifyInputs: async () => { throw new Error('recorded gate input changed: hardware-design/boards/X/cad/X.kicad_pcb'); } };
const lines = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

const CLAUDE = lines(
  { type: 'system', subtype: 'init' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom' }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }, { type: 'tool_use', id: 't3', name: 'Read', input: {} }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }, { type: 'tool_result', tool_use_id: 't3', is_error: false, content: 'ok' }] } },
  { type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.42, usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 70 } },
);

test('claude stream: tokens, cost, turns and tool calls come from the stream', () => {
  const usage = parseAgentStream('claude-stream-json', CLAUDE);
  assert.deepEqual([usage.tokens_in, usage.tokens_out, usage.cost_usd, usage.turns, usage.tool_calls, usage.tool_calls_failed, usage.tokens_known], [150, 70, 0.42, 3, 3, 1, true]);
  assert.deepEqual([usage.stream_complete, usage.result_subtype, usage.unparsed_lines], [true, 'success', 0]);
});

test('a stream without a result keeps what it can count and gives null, never 0, for the rest', () => {
  const cut = CLAUDE.split('\n').slice(0, 5).join('\n') + '\nnot json\n';
  const usage = parseAgentStream('claude-stream-json', cut);
  assert.deepEqual([usage.tokens_in, usage.tokens_out, usage.cost_usd, usage.turns, usage.tokens_known, usage.stream_complete], [null, null, null, null, false, false]);
  assert.deepEqual([usage.tool_calls, usage.tool_calls_failed, usage.unparsed_lines], [3, 1, 1]);
  const empty = parseAgentStream('claude-stream-json', '');
  assert.deepEqual([empty.tool_calls, empty.tool_calls_failed, empty.tokens_in, empty.tokens_known], [null, null, null, false]);
  const partial = parseAgentStream('claude-stream-json', lines({ type: 'result', usage: { output_tokens: 5 } }));
  assert.deepEqual([partial.tokens_in, partial.tokens_out, partial.tokens_known], [null, 5, false]);
});

test('codex stream: usage of the completed turns and command or tool items', () => {
  const stream = lines(
    { type: 'thread.started', thread_id: 'x' }, { type: 'turn.started' },
    { type: 'item.started', item: { id: 'i1', type: 'command_execution', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'i1', type: 'command_execution', exit_code: 0, status: 'completed' } },
    { type: 'item.completed', item: { id: 'i2', type: 'command_execution', exit_code: 2, status: 'failed' } },
    { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'done' } },
    { type: 'item.completed', item: { id: 'i4', type: 'file_change', status: 'completed' } },
    { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 } },
  );
  const usage = parseAgentStream('codex-jsonl', stream);
  assert.deepEqual([usage.tokens_in, usage.tokens_out, usage.cost_usd, usage.turns, usage.tool_calls, usage.tool_calls_failed, usage.tokens_known], [1000, 50, null, 1, 3, 1, true]);
  const none = parseAgentStream('codex-jsonl', lines({ type: 'turn.started' }));
  assert.deepEqual([none.tokens_in, none.tokens_out, none.turns, none.tokens_known, none.stream_complete], [null, null, null, false, false]);
});

/** A prepared trial plus a finished agent run (run.json and a stream), ready to collect. */
function finished(run: Record<string, any> = {}, caseChange: (value: Record<string, any>) => void = v => { v.design_contract_exempt = true; }, stream = CLAUDE): Trial {
  const t = trialFixture();
  rewriteCase(t, caseChange);
  prepareTrial({ casePath: t.casePath, lab: t.lab, out: t.out, toolchain: t.toolchain });
  atomicJson(join(t.out, 'run.json'), { schema: 'iot-lab.agent-trial-run.v1', case_id: 'fixture', board: 'X', argv: ['x'], started_at: '2026-11-06T10:00:00.000Z', ended_at: '2026-11-06T10:01:00.000Z',
    wall_s: 60, exit_code: 0, signal: null, timed_out: false, spawn_error: null, ...run });
  writeFileSync(join(t.out, 'agent.stdout.jsonl'), stream);
  return t;
}

/** A sealed run of the check operation in the scratch project, shaped like the ones the pcb-next tests build. */
function sealedRun(t: Trial, name = 'run-a', status = 'passed', created = '2026-11-06T10:00:30Z', extra: (folder: string) => void = () => {}): string {
  const project = join(t.out, 'project'), folder = join(project, '.gate/cli', name), failed = status !== 'passed';
  mkdirSync(join(folder, 'gate'), { recursive: true });
  atomicJson(join(folder, 'run.json'), { schema_version: 1, run_id: name, root: project, board: 'X', project: 'cad/X', created_at: created, operation: 'check', arguments: [],
    gate_config_sha256: sha256File(join(project, 'hardware-design/boards/X/gate.json')) });
  atomicJson(join(folder, 'gate/result.json'), { exit: failed ? 1 : 0, changedDuringRun: false, metrics: { drc_errors: failed ? 1 : 0 },
    checks: { erc: { status: 'passed' }, drc: { status: failed ? 'failed' : 'passed' } }, provenance: { input_sha256: 'a'.repeat(64), inputs: [] } });
  writeFileSync(join(folder, 'events.jsonl'), lines({ type: 'cache.hit' }, { type: 'check.end', status: 'passed' }, { type: 'check.end', status: failed ? 'failed' : 'passed' }, { type: 'check.end', status: 'blocked' }));
  extra(folder);
  atomicJson(join(folder, 'result.json'), { status, cleanup: { complete: true }, scope: 'configured_board_gate', input_sha256: 'a'.repeat(64), elapsed_s: 12, evidence_sha256: evidenceFiles(folder) });
  return folder;
}

test('passed: the newest sealed check run verifies, its inputs are fresh and the gate passed', async () => {
  const t = finished();
  try {
    sealedRun(t, 'run-old', 'failed', '2026-11-06T10:00:10Z');
    sealedRun(t);
    const result = await collectTrial(t.out, fresh);
    assert.deepEqual([result.verdict, result.cause, result.final_run, result.design_contract_exempt_applied], ['passed', null, 'run-a', true]);
    assert.deepEqual(json(join(t.out, 'result.json')), JSON.parse(JSON.stringify(result)));
    assert.equal(result.schema, 'iot-lab.agent-trial.v1');
    assert.deepEqual([result.wall_s, result.exit_code, result.signal, result.timed_out], [60, 0, null, false]);
    assert.equal(result.agent.tokens_in, 150);
    assert.deepEqual([result.pcb_runs.count, result.pcb_runs.by_status, result.pcb_runs.failed_checks, result.pcb_runs.blocked_checks, result.pcb_runs.cache_hits], [2, { failed: 1, passed: 1 }, 1, 2, 2]);
    assert.equal(result.pcb_runs.summary.runs.length, 2);
    assert.ok(resultIntact(result));
    assert.ok(!resultIntact({ ...result, wall_s: 1 }));
  } finally { t.cleanup(); }
});

test('gate_failed: the newest sealed run verifies but the gate did not pass', async () => {
  const t = finished();
  try {
    sealedRun(t, 'run-old', 'passed', '2026-11-06T10:00:10Z');
    sealedRun(t, 'run-new', 'failed', '2026-11-06T10:00:40Z');
    const result = await collectTrial(t.out, fresh);
    assert.deepEqual([result.verdict, result.cause, result.final_run], ['failed', 'gate_failed', 'run-new']);
  } finally { t.cleanup(); }
});

test('no_sealed_run: no check run, or only a run that never sealed, is a failure with a cause', async () => {
  const t = finished();
  try {
    let result = await collectTrial(t.out, fresh);
    assert.deepEqual([result.verdict, result.cause, result.final_run, result.pcb_runs.count], ['failed', 'no_sealed_run', null, 0]);
    const folder = sealedRun(t, 'run-open');
    rmSync(join(folder, 'result.json'));
    result = await collectTrial(t.out, fresh);
    assert.deepEqual([result.verdict, result.cause, result.pcb_runs.by_status], ['failed', 'no_sealed_run', { no_receipt: 1 }]);
    assert.equal(result.pcb_runs.unreadable.length, 1);
  } finally { t.cleanup(); }
});

test('timeout: a timed out agent is a failure even when an earlier run passed', async () => {
  const t = finished({ timed_out: true, signal: 'SIGINT', exit_code: null });
  try {
    sealedRun(t);
    const result = await collectTrial(t.out, fresh);
    assert.deepEqual([result.verdict, result.cause, result.timed_out, result.signal], ['failed', 'timeout', true, 'SIGINT']);
  } finally { t.cleanup(); }
});

test('an agent that could not start is a failure', async () => {
  const t = finished({ spawn_error: 'spawn x ENOENT', exit_code: null }, undefined, '');
  try {
    const result = await collectTrial(t.out, fresh);
    assert.deepEqual([result.verdict, result.cause, result.agent.tool_calls, result.agent.tokens_known], ['failed', 'agent_not_started', null, false]);
  } finally { t.cleanup(); }
});

test('stale_inputs: the gate passed but its inputs changed, or the gate config did', async () => {
  const t = finished();
  try {
    sealedRun(t);
    let result = await collectTrial(t.out, stale);
    assert.deepEqual([result.verdict, result.cause], ['failed', 'stale_inputs']);
    assert.match(result.detail ?? '', /recorded gate input changed/);
    appendFileSync(join(t.out, 'project/hardware-design/boards/X/gate.json'), ' ');
    result = await collectTrial(t.out, fresh);
    assert.deepEqual([result.verdict, result.cause], ['failed', 'stale_inputs']);
  } finally { t.cleanup(); }
});

test('evidence_invalid: a sealed run whose evidence changed does not count', async () => {
  const t = finished();
  try {
    const folder = sealedRun(t);
    appendFileSync(join(folder, 'gate/result.json'), ' ');
    const result = await collectTrial(t.out, fresh);
    assert.deepEqual([result.verdict, result.cause], ['failed', 'evidence_invalid']);
    assert.match(result.detail ?? '', /verified run evidence changed: gate\/result\.json/);
  } finally { t.cleanup(); }
});

test('design_contract_missing: no contract and no exemption fails even with a passing run', async () => {
  const t = finished({}, v => { v.design_contract_exempt = false; });
  try {
    sealedRun(t);
    const result = await collectTrial(t.out, fresh);
    assert.deepEqual([result.verdict, result.cause, result.design_contract_exempt_applied], ['failed', 'design_contract_missing', false]);
  } finally { t.cleanup(); }
});

test('seal: writes by tool, accepted edits, and a violation when the CAD differs from the seal', async () => {
  const t = finished();
  try {
    sealedRun(t);
    const project = join(t.out, 'project'), pcb = join(project, 'hardware-design/boards/X/cad/X.kicad_pcb');
    writeFileSync(pcb, '(kicad_pcb C123 edited by a tool)');
    reseal(project, 'X', { tool: 'pcb-adopt', run_id: 'run-a' });
    reseal(project, 'X', { tool: 'pcb-adopt', run_id: 'run-b' });
    let result = await collectTrial(t.out, fresh);
    assert.deepEqual(result.seal.writes_by_tool, { 'pcb-adopt': 2 });
    assert.deepEqual([result.seal.log_lines, result.seal.accepted_edits, result.seal.violations], [2, 0, null]);
    assert.deepEqual(result.outside_tools, { count: 0, changed: [], added: [], removed: [] }, 'a file that the seal log accounts for is not outside');
    reseal(project, 'X', { tool: 'seal-accept', run_id: null }, 'a person edited');
    writeFileSync(pcb, '(kicad_pcb C123 edited by hand)');
    result = await collectTrial(t.out, fresh);
    assert.deepEqual([result.seal.accepted_edits, result.seal.writes_by_tool], [1, { 'pcb-adopt': 2, 'seal-accept': 1 }]);
    assert.equal(result.seal.violations.state, 'changed');
    assert.deepEqual(result.seal.violations.changed, ['hardware-design/boards/X/cad/X.kicad_pcb']);
    assert.deepEqual(result.outside_tools.changed, ['hardware-design/boards/X/cad/X.kicad_pcb']);
  } finally { t.cleanup(); }
});

test('outside_tools lists files changed or added under hardware-design, by path', async () => {
  const t = finished();
  try {
    sealedRun(t);
    const board = join(t.out, 'project/hardware-design/boards/X');
    appendFileSync(join(board, 'gate.json'), ' ');
    writeFileSync(join(board, 'agent-notes.txt'), 'x');
    rmSync(join(t.out, 'project/hardware-design/registry/courtyard-bodies.json'));
    const result = await collectTrial(t.out, fresh);
    assert.deepEqual(result.outside_tools, { count: 3, changed: ['hardware-design/boards/X/gate.json'], added: ['hardware-design/boards/X/agent-notes.txt'], removed: ['hardware-design/registry/courtyard-bodies.json'] });
  } finally { t.cleanup(); }
});

test('interventions: notes of kind intervention and rework across the runs', async () => {
  const t = finished();
  try {
    sealedRun(t, 'run-a', 'passed', '2026-11-06T10:00:10Z', folder => writeFileSync(join(folder, 'notes.jsonl'), lines({ kind: 'intervention', message: 'm' }, { kind: 'decision', message: 'd' })));
    sealedRun(t, 'run-b', 'passed', '2026-11-06T10:00:20Z', folder => writeFileSync(join(folder, 'notes.jsonl'), lines({ kind: 'rework', message: 'r' }, { kind: 'intervention', message: 'i' })));
    const result = await collectTrial(t.out, fresh);
    assert.deepEqual(result.interventions, { intervention: 2, rework: 1, total: 3 });
  } finally { t.cleanup(); }
});

test('collect refuses a DIR whose agent never ran, and can run again with the same result', async () => {
  const t = finished();
  try {
    sealedRun(t);
    const first = await collectTrial(t.out, fresh), second = await collectTrial(t.out, fresh);
    assert.equal(first.result_sha256, second.result_sha256);
    rmSync(join(t.out, 'run.json'));
    await assert.rejects(collectTrial(t.out, fresh), /no run\.json/);
    assert.deepEqual(readObject(join(t.out, 'prepare.json')).board, 'X');
  } finally { t.cleanup(); }
});

test('verify_prefix: the freshness check runs through the prefix, where the gate ran, with the agent env', async () => {
  const script = 'echo "$MARK $*" > .args; [ -f .stale ] && { echo "gate tool versions changed" >&2; exit 1; }; exit 0';
  const t = finished({}, value => { value.design_contract_exempt = true; value.verify_prefix = ['sh', '-c', script, 'x']; value.agent.env = { MARK: 'env' }; });
  const project = join(t.out, 'project');
  try {
    sealedRun(t);
    let result = await collectTrial(t.out, stale);   // the local check would fail; the prefix decides
    assert.deepEqual([result.verdict, result.cause], ['passed', null]);
    assert.equal(readFileSync(join(project, '.args'), 'utf8').trim(), `env tools/pcb trial inputs ${join(project, '.gate/cli/run-a/gate')} --board X`);
    writeFileSync(join(project, '.stale'), '');
    result = await collectTrial(t.out, fresh);
    assert.deepEqual([result.verdict, result.cause], ['failed', 'stale_inputs']);
    assert.match(result.detail ?? '', /gate tool versions changed/);
  } finally { t.cleanup(); }
});
