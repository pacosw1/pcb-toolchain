import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rewriteCase, sha, trialFixture } from './agent-trial-fixture.ts';
import { designExemption } from './design-exemption.ts';
import { sealStatus } from './cad-seal.ts';
import { prepareTrial } from './agent-trial-prepare.ts';

const read = (path: string) => readFileSync(path, 'utf8');
const prepare = (t: ReturnType<typeof trialFixture>, out = t.out) => prepareTrial({ casePath: t.casePath, lab: t.lab, out, toolchain: t.toolchain });

test('prepare builds the scratch project from the frozen lab commit and records what it did', () => {
  const t = trialFixture();
  try {
    const record = prepare(t), project = join(t.out, 'project');
    assert.equal(read(join(project, 'hardware-design/boards/X/cad/X.kicad_pcb')), '(kicad_pcb C123)');
    assert.ok(existsSync(join(project, 'hardware-design/registry/cad-assets/C123/part.txt')), 'the part used by the board is archived');
    assert.ok(!existsSync(join(project, 'hardware-design/registry/cad-assets/C999')), 'an unused part is not');
    assert.ok(!existsSync(join(project, 'hardware-design/registry/datasheets')), 'datasheets are not');
    assert.ok(existsSync(join(project, 'tools/gate.mjs')) && !existsSync(join(project, 'tools/node_modules')), 'tools are copied without node_modules');
    assert.ok(!existsSync(join(project, 'toolchain.lock')));
    const settings = JSON.parse(read(join(project, '.claude/settings.json')));
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'node tools/hooks/claude-cad-guard.mjs');
    assert.equal(read(join(t.out, 'prompt.txt')), 'Make the board pass the gate.');
    assert.equal(JSON.stringify(JSON.parse(read(join(t.out, 'case.json')))), JSON.stringify(t.caseValue));
    assert.equal(sealStatus(project, 'X').state, 'sealed');
    const log = read(join(project, '.gate/cad-seal/X.jsonl')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(log.length, 1);
    assert.deepEqual([log[0].tool, log[0].reason], ['trial-prepare', 'trial baseline']);
    const saved = JSON.parse(read(join(t.out, 'prepare.json')));
    assert.deepEqual(saved, record);
    assert.equal(saved.lab_commit, t.commit);
    assert.match(saved.toolchain.git_sha, /^[0-9a-f]{40}$/);
    assert.equal(saved.case_sha256, sha(read(t.casePath)));
    assert.equal(saved.seal_baseline_lines, 1);
    assert.equal(saved.design_contract_exempt_applied, false);
    assert.equal(saved.files['hardware-design/boards/X/cad/X.kicad_pcb'], sha('(kicad_pcb C123)'));
    assert.ok('hardware-design/boards/X/cad-seal.json' in saved.files);
    assert.ok(!JSON.stringify(saved).match(/\d{4}-\d\d-\d\dT/), 'prepare.json holds no timestamp');
  } finally { t.cleanup(); }
});

test('prepare is deterministic: the same case, lab and toolchain give the same prepare.json', () => {
  const t = trialFixture();
  try {
    prepare(t);
    prepare(t, join(t.base, 'out2'));
    assert.equal(read(join(t.out, 'prepare.json')), read(join(t.base, 'out2/prepare.json')));
  } finally { t.cleanup(); }
});

test('a pinned input whose hash differs stops prepare, and nothing is recorded', () => {
  const t = trialFixture();
  try {
    rewriteCase(t, v => { v.inputs[0].sha256 = sha('other'); });
    assert.throws(() => prepare(t), /differs from its pinned SHA-256/);
    assert.ok(!existsSync(join(t.out, 'prepare.json')));
    rewriteCase(t, v => { v.prompt.sha256 = sha('other'); });
    assert.throws(() => prepare(t), /prompt/);
    assert.ok(!existsSync(join(t.out, 'project')), 'a failed prepare leaves no half-built project');
  } finally { t.cleanup(); }
});

test('design_contract_exempt writes the reason into the scratch registry and the record says so', () => {
  const t = trialFixture();
  try {
    rewriteCase(t, v => { v.design_contract_exempt = true; });
    const record = prepare(t);
    assert.equal(designExemption(join(t.out, 'project'), 'X'), 'agent trial baseline');
    assert.equal(record.design_contract_exempt_applied, true);
    const lab = JSON.parse(read(join(t.lab, 'hardware-design/registry/boards.json')));
    assert.equal(lab.boards[0].design_contract_exempt, undefined, 'the lab is not changed');
  } finally { t.cleanup(); }
});

test('prepare refuses a used DIR, an unknown commit, a missing board and a DIR under .gate', () => {
  const t = trialFixture();
  try {
    prepare(t);
    assert.throws(() => prepare(t), /already prepared/);
    mkdirSync(join(t.base, 'full/project'), { recursive: true });
    writeFileSync(join(t.base, 'full/project/x'), '');
    assert.throws(() => prepare(t, join(t.base, 'full')), /not empty/);
    assert.throws(() => prepare(t, join(t.base, '.gate/out')), /\.gate/);
    rewriteCase(t, v => { v.lab.commit = 'f'.repeat(40); });
    assert.throws(() => prepare(t, join(t.base, 'o3')), /commit/);
    rewriteCase(t, v => { v.board = 'NOPE'; v.inputs[0].path = 'hardware-design/boards/NOPE/a.kicad_pcb'; });
    assert.throws(() => prepare(t, join(t.base, 'o4')), /NOPE/);
  } finally { t.cleanup(); }
});

test('gate inputs found in the lab are archived, and the ones the lab lacks are listed, not hidden', () => {
  const t = trialFixture({ checks: { erc: true, paths: 'rules.json' } }, {
    'hardware-design/boards/X/rules.json': JSON.stringify({ evidence: 'hardware-design/registry/datasheets/big.pdf', missing: 'gone.json' }),
  });
  try {
    const record = prepare(t);
    assert.ok(existsSync(join(t.out, 'project/hardware-design/registry/datasheets/big.pdf')), 'a datasheet that a rule file names is archived');
    assert.ok(record.missing_gate_inputs.includes('hardware-design/boards/X/gone.json'), JSON.stringify(record.missing_gate_inputs));
    assert.ok(!record.missing_gate_inputs.includes('hardware-design/registry/datasheets/big.pdf'));
  } finally { t.cleanup(); }
});

test('a lab script that the gate names is archived, the toolchain copy wins, and a script the lab lacks is listed', () => {
  const t = trialFixture({ semantic: [{ stage: 'a', run: ['python3', 'tools/check-x.py'] }, { stage: 'b', run: ['python3', 'tools/gone.py'] }, { stage: 'c', run: ['node', 'tools/gate.mjs'] }] }, { 'tools/check-x.py': 'pass\n', 'tools/build-x.py': 'loaded by check-x\n', 'tools/gate.mjs': '// lab copy' });
  try {
    const record = prepare(t);
    assert.equal(read(join(t.out, 'project/tools/check-x.py')), 'pass\n');
    assert.equal(read(join(t.out, 'project/tools/build-x.py')), 'loaded by check-x\n', 'a lab script can load another one that gate.json does not name');
    assert.equal(read(join(t.out, 'project/tools/gate.mjs')), '// stub gate');
    assert.ok(record.missing_gate_inputs.includes('tools/gone.py'), JSON.stringify(record.missing_gate_inputs));
  } finally { t.cleanup(); }
});

test('the datasheets that the schematic names are archived, and no other', () => {
  const t = trialFixture({}, { 'hardware-design/boards/X/cad/X.kicad_sch': '(kicad_sch C123 (property "Datasheet" "hardware-design/registry/datasheets/used.pdf") (property "Datasheet" "") (property "Datasheet" "https://x.example/none.pdf"))', 'hardware-design/registry/datasheets/used.pdf': 'pdf' });
  try {
    prepare(t);
    assert.ok(existsSync(join(t.out, 'project/hardware-design/registry/datasheets/used.pdf')));
    assert.ok(!existsSync(join(t.out, 'project/hardware-design/registry/datasheets/big.pdf')));
  } finally { t.cleanup(); }
});

test('prepare archives the context sources of the board and lists the ones the lab lacks', () => {
  const t = trialFixture({}, { 'AGENTS.md': 'rules', 'hardware-design/STATUS.md': 'status' });
  try {
    const record = prepare(t), project = join(t.out, 'project');
    assert.equal(read(join(project, 'AGENTS.md')), 'rules');
    assert.equal(read(join(project, 'hardware-design/STATUS.md')), 'status');
    assert.ok(record.missing_context_sources.includes('hardware-design/REQUIREMENTS.md'));
    assert.ok(!record.missing_context_sources.includes('AGENTS.md'));
  } finally { t.cleanup(); }
});

test('a setup step changes the start board, and the seal and the baseline hold the changed board', () => {
  const t = trialFixture(), pcb = 'hardware-design/boards/X/cad/X.kicad_pcb';
  try {
    rewriteCase(t, value => { value.setup = { argv: ['sh', '-c', `printf '(kicad_pcb %s {board})' "$MARK" > ${pcb}`], env: { MARK: 'stripped' } }; });
    const record = prepare(t), project = join(t.out, 'project');
    assert.equal(read(join(project, pcb)), '(kicad_pcb stripped X)');
    assert.equal(sealStatus(project, 'X').state, 'sealed');
    assert.equal(record.files[pcb], sha('(kicad_pcb stripped X)'));
    assert.deepEqual(record.setup.argv.slice(0, 2), ['sh', '-c']);
    const log = read(join(project, '.gate/cad-seal/X.jsonl')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(log.map(line => line.tool), ['trial-prepare', 'trial-setup']);
    assert.equal(record.seal_baseline_lines, 2);
  } finally { t.cleanup(); }
});

test('a setup step that fails stops prepare, names its output, and leaves no project', () => {
  const t = trialFixture();
  try {
    rewriteCase(t, value => { value.setup = { argv: ['sh', '-c', 'echo boom >&2; exit 3'] }; });
    assert.throws(() => prepare(t), /setup failed.*boom/s);
    assert.ok(!existsSync(join(t.out, 'project')) && !existsSync(join(t.out, 'prepare.json')));
  } finally { t.cleanup(); }
});
