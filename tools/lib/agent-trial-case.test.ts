import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CASE_SCHEMA, fillArgv, readCase, validateCase } from './agent-trial-case.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const good = () => ({
  schema: CASE_SCHEMA, case_id: 'env-sense-1', board: 'ENV-SENSE', lab: { commit: 'a'.repeat(40) },
  inputs: [{ path: 'hardware-design/boards/ENV-SENSE/cad/ENV-SENSE/ENV-SENSE.kicad_pcb', sha256: sha('pcb') }],
  prompt: { path: 'prompt.md', sha256: sha('prompt') },
  agent: { argv: ['claude', '-p', '--output-format', 'stream-json', '--max-turns', '{max_turns}', '--add-dir', '{root}', '@{prompt_file}', '{board}'], parser: 'claude-stream-json', env: { A: 'b' } },
  budget: { timeout_s: 600, max_turns: 40 },
});
const bad = (change: (value: Record<string, any>) => void, message: RegExp) => {
  const value = good() as Record<string, any>;
  change(value);
  assert.throws(() => validateCase(value), message);
};

test('a good case validates and defaults design_contract_exempt to false', () => {
  const value = validateCase(good());
  assert.equal(value.design_contract_exempt, false);
  assert.equal(value.board, 'ENV-SENSE');
});

test('a bad case is a clear error', () => {
  bad(v => { v.schema = 'x'; }, /schema must be iot-lab.agent-case.v1/);
  bad(v => { v.case_id = 'a b'; }, /case_id/);
  bad(v => { v.board = 'env'; }, /board/);
  bad(v => { v.lab.commit = 'main'; }, /lab.commit/);
  bad(v => { v.inputs = []; }, /inputs/);
  bad(v => { v.inputs[0].path = '/abs/ENV-SENSE.kicad_pcb'; }, /relative/);
  bad(v => { v.inputs[0].path = '../x/ENV-SENSE.kicad_pcb'; }, /relative/);
  bad(v => { v.inputs[0].sha256 = 'abc'; }, /SHA-256/);
  bad(v => { v.inputs = [{ path: 'README.md', sha256: sha('r') }]; }, /\.kicad_pcb/);
  bad(v => { v.inputs.push({ ...v.inputs[0] }); }, /twice/);
  bad(v => { v.prompt.sha256 = 'abc'; }, /prompt/);
  bad(v => { v.agent.argv = []; }, /argv/);
  bad(v => { v.agent.parser = 'other'; }, /parser/);
  bad(v => { v.agent.argv.push('{nope}'); }, /unknown placeholder \{nope\}/);
  bad(v => { v.agent.env = { IOT_LAB: '/x' }; }, /IOT_LAB/);
  bad(v => { v.agent.env = { A: 1 }; }, /env/);
  bad(v => { v.budget.timeout_s = 0; }, /timeout_s/);
  bad(v => { v.budget.max_turns = 1.5; }, /max_turns/);
  bad(v => { delete v.budget.max_turns; }, /\{max_turns\}/);
  bad(v => { v.design_contract_exempt = 'yes'; }, /design_contract_exempt/);
  bad(v => { v.extra = 1; }, /unknown field extra/);
});

test('fillArgv replaces the placeholders and nothing else', () => {
  const argv = fillArgv(validateCase(good()), { prompt_file: '/d/prompt.txt', root: '/d/project' });
  assert.deepEqual(argv.slice(5, 9), ['40', '--add-dir', '/d/project', '@/d/prompt.txt']);
  assert.equal(argv.at(-1), 'ENV-SENSE');
});

test('readCase returns the hash of the file bytes and refuses bad JSON', () => {
  const folder = mkdtempSync(join(tmpdir(), 'trial-case-'));
  try {
    const path = join(folder, 'c.json'), text = JSON.stringify(good());
    writeFileSync(path, text);
    assert.equal(readCase(path).sha256, sha(text));
    writeFileSync(path, '{');
    assert.throws(() => readCase(path), /not valid JSON/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('a setup step needs a string argv, known placeholders and no trial variable in its env', () => {
  const base = { ...good(), setup: { argv: ['sh', 'x', '{root}', '{board}'], env: { A: '1' } } };
  assert.deepEqual(validateCase(base).setup, base.setup);
  assert.throws(() => validateCase({ ...base, setup: { argv: [] } }), /setup.argv/);
  assert.throws(() => validateCase({ ...base, setup: { argv: ['{prompt_file}'] } }), /placeholder \{prompt_file\}/);
  assert.throws(() => validateCase({ ...base, setup: { argv: ['x'], env: { IOT_LAB: 'y' } } }), /setup.env cannot set IOT_LAB/);
  assert.equal(validateCase(good()).setup, undefined);
});

test('verify_prefix is a nonempty string array when present', () => {
  assert.deepEqual(validateCase({ ...good(), verify_prefix: ['tools/bench-in-route.sh', '.'] }).verify_prefix, ['tools/bench-in-route.sh', '.']);
  assert.throws(() => validateCase({ ...good(), verify_prefix: [] }), /verify_prefix/);
  assert.equal(validateCase(good()).verify_prefix, undefined);
});
