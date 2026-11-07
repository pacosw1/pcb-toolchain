import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const hook = fileURLToPath(new URL('./claude-cad-guard.mjs', import.meta.url));
const run = input => spawnSync(process.execPath, [hook], {input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8'});
const PCB = '/work/proj/hardware-design/boards/BASE-PWR/cad/A/A.kicad_pcb';
const decisionOf = result => {
  assert.equal(result.status, 0);
  const {hookSpecificOutput} = JSON.parse(result.stdout);
  assert.equal(hookSpecificOutput.hookEventName, 'PreToolUse');
  return hookSpecificOutput;
};

test('Edit on a .kicad_pcb under hardware-design/ is denied with a reason that names tools/pcb and the seal', () => {
  const out = decisionOf(run({tool_name: 'Edit', tool_input: {file_path: PCB, old_string: 'a', new_string: 'b'}}));
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /tools\/pcb/);
  assert.match(out.permissionDecisionReason, /seal/);
});

test('Write on a .kicad_sch is denied', () => {
  const out = decisionOf(run({tool_name: 'Write', tool_input: {file_path: '/work/proj/hardware-design/boards/B/cad/B.kicad_sch', content: ''}}));
  assert.equal(out.permissionDecision, 'deny');
});

test('MultiEdit on a .kicad_pro and NotebookEdit on a .kicad_dru are denied', () => {
  for (const [tool_name, tool_input] of [
    ['MultiEdit', {file_path: '/work/proj/hardware-design/boards/B/B.kicad_pro', edits: []}],
    ['NotebookEdit', {notebook_path: '/work/proj/hardware-design/boards/B/B.kicad_dru', new_source: ''}],
  ]) assert.equal(decisionOf(run({tool_name, tool_input})).permissionDecision, 'deny');
});

test('Edit on tools/foo.ts passes with no output', () => {
  const result = run({tool_name: 'Edit', tool_input: {file_path: '/work/proj/tools/foo.ts'}});
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('Edit on a .kicad_pcb outside hardware-design/ passes', () => {
  const result = run({tool_name: 'Edit', tool_input: {file_path: '/work/proj/scratch/x.kicad_pcb'}});
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('Bash with pcb seal --accept asks a person', () => {
  const out = decisionOf(run({tool_name: 'Bash', tool_input: {command: 'tools/pcb seal X --accept --reason y'}}));
  assert.equal(out.permissionDecision, 'ask');
  assert.match(out.permissionDecisionReason, /person/);
});

test('Bash with pcb seal (status only) and other commands pass', () => {
  for (const command of ['tools/pcb seal X', 'tools/pcb seal X --json', 'ls -la']) {
    const result = run({tool_name: 'Bash', tool_input: {command}});
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  }
});

test('malformed input exits 0 with empty stdout and one line on stderr', () => {
  for (const input of ['{not json', '', 'null']) {
    const result = run(input);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim().split('\n').length, 1);
  }
});

test('board placement rule edits are denied and mutation commands ask', () => {
  for (const tool_name of ['Edit', 'Write']) assert.equal(decisionOf(run({tool_name, tool_input:{file_path:'/p/hardware-design/boards/X/placement-constraints.json'}})).permissionDecision,'deny');
  for (const flag of ['--add new.json','--remove distance']) assert.equal(decisionOf(run({tool_name:'Bash',tool_input:{command:`tools/pcb constraints X ${flag} --reason updated`}})).permissionDecision,'ask');
  assert.equal(decisionOf(run({tool_name:'Bash',tool_input:{command:'tools/pcb --project /tmp/board constraints X --remove near --reason updated'}})).permissionDecision,'ask');
  assert.equal(run({tool_name:'Bash',tool_input:{command:'tools/pcb constraints X --json'}}).stdout,'');
});

test('pcb layout --approve asks a person, and so does a direct edit of a layout plan', () => {
  for (const command of ['tools/pcb layout X --approve --by Ana --reason ok', 'tools/pcb --project /tmp/board layout X --approve --by Ana --reason ok']) {
    const out = decisionOf(run({tool_name: 'Bash', tool_input: {command}}));
    assert.equal(out.permissionDecision, 'ask');
    assert.match(out.permissionDecisionReason, /person/);
  }
  for (const tool_name of ['Edit', 'Write']) assert.equal(decisionOf(run({tool_name, tool_input: {file_path: '/p/hardware-design/boards/X/layout-plan.json'}})).permissionDecision, 'ask');
  for (const command of ['tools/pcb layout X', 'tools/pcb layout X --json']) assert.equal(run({tool_name: 'Bash', tool_input: {command}}).stdout, '');
  assert.equal(run({tool_name: 'Edit', tool_input: {file_path: '/p/scratch/layout-plan.json'}}).stdout, '');
});
