import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditLayout, type Finding } from './project-layout.ts';
import { boardConfig } from './pcb-workflow.ts';
import { routePlanErrors } from './route-plan-schema.ts';

type Raw = Record<string, unknown>;
const BOARDS = 'hardware-design/boards';
const ROUTE = { schema: 'iot-lab.route.v1', backend: 'iotroute', layers: ['F.Cu', 'B.Cu'], stages: [{ name: 'main', skip_nets: [] }] };
const FULL_CHECKS = { erc: true, drc: true, paths: 'paths.json', viapads: { allow: [] }, kicad_happy: {}, port_labels: true };

interface Project { root: string; toolchain: string; write(name: string, value: unknown): void; registry(boards: Raw[], more?: Raw): void }

function project(t: TestContext): Project {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'project-layout-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'project'), toolchain = join(base, 'toolchain');
  const put = (at: string, name: string, value: unknown): void => {
    mkdirSync(dirname(join(at, name)), { recursive: true });
    writeFileSync(join(at, name), typeof value === 'string' ? value : JSON.stringify(value));
  };
  put(toolchain, 'tools/route-features.json', { features: { rule_compiler: { on: false } } });
  put(toolchain, 'tools/synced.mjs', 'release\n');
  mkdirSync(join(root, BOARDS), { recursive: true });
  return {
    root, toolchain, write: (name, value) => put(root, name, value),
    registry: (boards, more = {}) => put(root, 'hardware-design/registry/boards.json', { schema_version: 1, boards, ...more }),
  };
}

const revision = (id: string, more: Raw = {}): Raw => ({ revision: 'A', spec: 'SPEC.md', state: 'review', gate: id, project: `cad/${id}/${id}`, ...more });
const entry = (id: string, more: Raw = {}): Raw => ({ id, directory: id, kind: 'board', lifecycle: 'active', packet: 'full', revisions: [revision(id)], ...more });

/** A board that meets its whole row at G4. */
function goodBoard(p: Project, id: string, gate: Raw = {}): void {
  const folder = `${BOARDS}/${id}`;
  for (const name of ['SPEC.md', 'STATUS.md', 'DOC-RECONCILIATION.md', 'BOM-VERIFIED.csv', 'SCHEMATIC.md', 'reports/README.md']) p.write(`${folder}/${name}`, 'x\n');
  for (const extension of ['kicad_sch', 'kicad_pcb', 'kicad_pro']) p.write(`${folder}/cad/${id}/${id}.${extension}`, '(x)\n');
  p.write(`${folder}/paths.json`, {});
  p.write(`${folder}/route.json`, ROUTE);
  p.write(`${folder}/gate.json`, { project: `cad/${id}/${id}`, stage: 'G4', checks: FULL_CHECKS, ...gate });
}

const audit = (p: Project, strict?: string) => auditLayout(p.root, { toolchain: p.toolchain, ...(strict ? { strict } : {}) });
const types = (findings: Finding[]): string[] => findings.map(finding => finding.type);
const paths = (findings: Finding[], type: string): (string | undefined)[] => findings.filter(finding => finding.type === type).map(finding => finding.path);

test('a board that meets its row has no finding, and gate-only and variant IDs are enumerated', t => {
  const p = project(t);
  goodBoard(p, 'GOOD');
  p.write(`${BOARDS}/GOOD-B/gate.json`, { project: '../GOOD/cad/GOOD/GOOD', stage: 'G3', checks: { erc: true } });
  p.registry([
    entry('GOOD', { revisions: [revision('GOOD'), revision('GOOD-B', { revision: 'B', project: 'cad/GOOD/GOOD' })] }),
    { id: 'GOOD-B', directory: 'GOOD-B', kind: 'gate-only', lifecycle: 'active', owner: 'GOOD', revision: 'B' },
    { id: 'GOOD-V', kind: 'variant', lifecycle: 'planned', variant_of: 'GOOD' },
  ]);
  const report = audit(p);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.boards.map(board => board.id), ['GOOD', 'GOOD-B', 'GOOD-V']);
  assert.equal(report.boards[0]!.stage, 'G4');
});

test('duplicate IDs and path escapes are errors, through a link too', t => {
  const p = project(t);
  goodBoard(p, 'GOOD');
  goodBoard(p, 'OUT', { project: '../../../outside/OUT', pipeline: '../outside.sh' });
  goodBoard(p, 'LINK', { release: { maker: 'tools/maker.sh', fab: 'fab' } });
  mkdirSync(join(p.root, 'tools'), { recursive: true });
  symlinkSync(join(p.toolchain, 'tools/synced.mjs'), join(p.root, 'tools/maker.sh'));
  p.registry([
    entry('GOOD'), entry('GOOD'), entry('OUT', { revisions: [revision('OUT', { project: 'cad/OUT/OUT' })] }), entry('LINK'),
    entry('ESCAPE', { directory: '../../etc' }), { ...entry('../NAME') },
    entry('TWICE', { directory: 'GOOD', revisions: [revision('GOOD', { revision: 'B' })] }),
  ]);
  const { findings } = audit(p);
  assert.deepEqual(findings.filter(finding => finding.type === 'duplicate_board_id').map(finding => finding.detail), [
    'board ID GOOD is registered more than once', 'gate GOOD belongs to more than one revision', 'directory GOOD belongs to more than one board',
  ]);
  assert.deepEqual(paths(findings, 'path_escape').sort(), ['../../../outside/OUT', '../../etc', '../NAME', '../outside.sh', 'tools/maker.sh']);
  assert.ok(findings.filter(finding => finding.type === 'path_escape').every(finding => finding.severity === 'error'));
});

test('gate and route schemas are validated, and a missing stage is a finding and not G4', t => {
  const p = project(t);
  goodBoard(p, 'BAD', { stage: 'G9', pipelin: 'tools/x.sh', release: { fab: 'fab' }, post_verify: [{ stage: 'x' }], place_check: [{ stage: 'y' }] });
  p.write(`${BOARDS}/BAD/route.json`, { ...ROUTE, schema: 'old', backend: 'fastroute', layers: ['Top'], extra: 1, stages: [{ name: 'a', only_nets: [], skip_nets: [] }, { name: 'a' }] });
  goodBoard(p, 'NOSTAGE', { stage: undefined, checks: { erc: true } });
  p.write(`${BOARDS}/NOSTAGE/route.json`, '{not json');
  goodBoard(p, 'G3', { stage: 'G3', checks: {} });
  p.registry([entry('BAD'), entry('NOSTAGE'), entry('G3')]);
  const { findings, boards } = audit(p);
  const details = (board: string, type: string): string[] => findings.filter(finding => finding.board === board && finding.type === type).map(finding => finding.detail);
  assert.deepEqual(details('BAD', 'gate_schema').sort(), [
    'place_check entries need a stage and a run argv', 'post_verify entries need a stage and a run argv', 'release needs a maker and a fab', 'unknown gate stage G9', 'unknown key pipelin',
  ]);
  for (const text of ['schema must be iot-lab.route.v1', 'route.json: unknown key extra', 'layers: Top is not a copper layer name', 'duplicate stage name a', 'stages[0]: only_nets and skip_nets cannot both be set']) {
    assert.ok(details('BAD', 'route_schema').includes(text), text);
  }
  assert.ok(details('BAD', 'route_schema').some(text => text.includes('fastroute')));
  assert.deepEqual(details('NOSTAGE', 'gate_schema'), []);
  assert.equal(details('NOSTAGE', 'gate_stage_missing').length, 1);
  assert.equal(details('NOSTAGE', 'route_schema').length, 1);
  assert.equal(boards.find(board => board.id === 'NOSTAGE')!.stage, null);
  assert.deepEqual(details('G3', 'gate_schema'), ['required check disabled or absent: erc']);
});

test('every configured native file and script or data reference resolves', t => {
  const p = project(t);
  goodBoard(p, 'REF', {
    pipeline: 'tools/gone.sh', route_rules: 'tools/synced.mjs', isolation_check: 'python3 tools/iso.py base && $PY tools/{x}.py',
    checks: { ...FULL_CHECKS, planes: 'planes.json', kicad_happy: { exempt: 'exempt.json' } },
    route_features: { rule_compiler: { fast_nets_file: 'fast.json' } },
    release: { maker: 'tools/make.sh', fab: 'fab', config: 'hardware-design/boards/REF/cfg.json', inputs: ['tools/input.py'], pre_checks: [{ run: ['python3', 'tools/pre.py', '{stage}/x'] }] },
    post_verify: [{ stage: 's', run: ['{node}', 'tools/post.mjs', '--out', '{run}/gate'] }],
  });
  p.write(`${BOARDS}/REF/planes.json`, { sheet: 'nested.json', note: 'see the file x.pdf', web: 'https://x/y.pdf', tool: 'tools/rules.json' });
  p.write(`${BOARDS}/REF/cad/REF/REF.kicad_sch`, '(property "Sheetfile" "child.kicad_sch")\n');
  p.write(`${BOARDS}/REF/cad/REF/fp-lib-table`, '(fp_lib_table (lib (uri "${KIPRJMOD}/gone.pretty")) (lib (uri "${KICAD9_FOOTPRINT_DIR}/x.pretty")))\n');
  rmSync(join(p.root, BOARDS, 'REF/cad/REF/REF.kicad_pcb'));
  p.registry([entry('REF', { revisions: [revision('REF', { bom: 'BOM-A.csv' })] })]);
  const { findings } = audit(p);
  assert.deepEqual(paths(findings, 'missing_reference').sort(), [
    `${BOARDS}/REF/cfg.json`, `${BOARDS}/REF/exempt.json`, `${BOARDS}/REF/fast.json`, `${BOARDS}/REF/nested.json`,
    'tools/gone.sh', 'tools/input.py', 'tools/iso.py', 'tools/make.sh', 'tools/post.mjs', 'tools/pre.py', 'tools/rules.json',
  ]);
  assert.deepEqual(paths(findings, 'missing_native_file').sort(), [
    `${BOARDS}/REF/cad/REF/REF.kicad_pcb`, `${BOARDS}/REF/cad/REF/child.kicad_sch`, `${BOARDS}/REF/cad/REF/gone.pretty`,
  ]);
  assert.deepEqual(paths(findings, 'missing_required_file'), [`${BOARDS}/REF/BOM-A.csv`]);
});

test('the required files follow lifecycle, stage and registered gate', t => {
  const p = project(t);
  const only = (id: string, keep: string[], gate?: Raw): void => {
    for (const name of keep) p.write(`${BOARDS}/${id}/${name}`, 'x\n');
    if (gate) {
      for (const extension of ['kicad_sch', 'kicad_pcb', 'kicad_pro']) p.write(`${BOARDS}/${id}/cad/${id}/${id}.${extension}`, '(x)\n');
      p.write(`${BOARDS}/${id}/gate.json`, { project: `cad/${id}/${id}`, ...gate });
    }
  };
  const concept = { revisions: [{ revision: 'A', spec: 'SPEC.md', state: 'spec-only', gate: null, project: null }] };
  only('CONCEPT', ['SPEC.md']);
  only('OLD', ['SPEC.md']);
  only('EARLY', ['SPEC.md'], { stage: 'G3', checks: { erc: true } });
  only('LATE', ['SPEC.md'], { stage: 'G4', checks: FULL_CHECKS });
  only('UNKNOWN', ['SPEC.md'], { checks: { erc: true } });
  only('PENDING', ['SPEC.md']);
  p.write(`${BOARDS}/PENDING/gate.pending.json`, { project: 'cad/P/P', stage: 'G3', checks: { erc: true } });
  only('NOGATE', ['SPEC.md'], { stage: 'G3', checks: { erc: true } });
  p.write(`${BOARDS}/NOSPEC/notes.txt`, 'x');
  p.registry([
    entry('CONCEPT', { lifecycle: 'planned', ...concept }), entry('OLD', { lifecycle: 'historical', ...concept }),
    entry('EARLY', { lifecycle: 'planned' }), entry('LATE', { lifecycle: 'planned' }), entry('UNKNOWN', { lifecycle: 'planned' }),
    entry('PENDING', { lifecycle: 'planned', revisions: [revision('PENDING', { project: null })] }),
    entry('NOGATE', { lifecycle: 'planned', ...concept }),
    entry('NOSPEC', { lifecycle: undefined, revisions: [{ revision: 'A', state: 'x' }] }),
  ]);
  const { findings } = audit(p);
  const missing = (board: string): string[] => findings.filter(finding => finding.board === board && finding.type === 'missing_required_file').map(finding => finding.path!.split('/').slice(3).join('/')).sort();
  assert.deepEqual(missing('CONCEPT'), []);
  assert.deepEqual(missing('OLD'), []);
  assert.deepEqual(missing('EARLY'), ['SCHEMATIC.md', 'STATUS.md']);
  assert.deepEqual(missing('LATE'), ['BOM-VERIFIED.csv', 'DOC-RECONCILIATION.md', 'SCHEMATIC.md', 'STATUS.md', 'reports/', 'route.json']);
  assert.deepEqual(missing('UNKNOWN'), ['SCHEMATIC.md', 'STATUS.md']);
  assert.deepEqual(missing('PENDING'), ['SCHEMATIC.md', 'STATUS.md', 'gate.json']);
  assert.deepEqual(paths(findings, 'unregistered_gate'), [`${BOARDS}/NOGATE/gate.json`]);
  const noSpec = findings.filter(finding => finding.board === 'NOSPEC' && finding.type === 'registry_schema').map(finding => finding.detail);
  assert.ok(noSpec.includes('revision A has no spec') && noSpec.some(detail => detail.startsWith('lifecycle must be')));
  assert.deepEqual(missing('NOSPEC'), [], 'no lifecycle, no row, and no SPEC.md is assumed');
});

test('unregistered and undeclared folders are reported, _art and .claude are not, and a registry exclusion hides nothing', t => {
  const p = project(t);
  goodBoard(p, 'GOOD');
  for (const name of ['_art', '.claude', 'DRAFT-C', 'STRAY', 'old_stuff']) p.write(`${BOARDS}/${name}/x.md`, 'x\n');
  p.write(`${BOARDS}/README.md`, 'a file\n');
  p.registry([entry('GOOD'), entry('GONE')], { excluded_directories: ['_art', 'DRAFT-C'] });
  const { findings } = audit(p);
  assert.deepEqual(paths(findings, 'unregistered_board_folder'), [`${BOARDS}/DRAFT-C`, `${BOARDS}/STRAY`]);
  assert.equal(findings.find(finding => finding.board === 'DRAFT-C')!.registry_excluded, true);
  assert.deepEqual(paths(findings, 'undeclared_board_folder'), [`${BOARDS}/old_stuff`]);
  assert.deepEqual(paths(findings, 'missing_board_folder'), [`${BOARDS}/GONE`]);
});

test('a project file at a synced tool path is rejected and names the boards that use it', t => {
  const p = project(t);
  goodBoard(p, 'GOOD', { route_rules: 'tools/synced.mjs' });
  p.registry([entry('GOOD')]);
  p.write('tools/own.py', 'mine\n');
  p.write('tools/synced.mjs', 'changed\n');
  const shadow = audit(p).findings.filter(finding => finding.type === 'shadowed_tool');
  assert.deepEqual(shadow.map(({ path, identical, boards, severity }) => ({ path, identical, boards, severity })), [{ path: 'tools/synced.mjs', identical: false, boards: ['GOOD'], severity: 'error' }]);
  assert.equal(audit(p, 'GOOD').strict!.pass, false);
  p.write('tools/synced.mjs', 'release\n');
  assert.equal(audit(p).findings.find(finding => finding.type === 'shadowed_tool')!.identical, true);
  p.write('tools/.toolchain-files', 'synced.mjs\n');
  assert.deepEqual(types(audit(p).findings), [], 'a copy that the sync made is not a project file');
});

test('obsolete is registry data and never hides structure debt or implicitly exempts BASE boards', t => {
  const p = project(t);
  goodBoard(p, 'BASE-PWR', { stage: undefined });
  goodBoard(p, 'BASE-PWR-B', { project: '../../../escape', stage: undefined });
  goodBoard(p, 'BASE-LP', { stage: undefined });
  const boards = [entry('BASE-PWR'), entry('BASE-PWR-B'), entry('BASE-LP')];
  p.registry(boards);
  const declared = audit(p);
  assert.deepEqual(declared.summary.obsolete, []);
  assert.ok(declared.findings.some(finding => finding.board === 'BASE-PWR' && finding.type === 'gate_stage_missing'));
  assert.ok(types(declared.findings).includes('path_escape'));
  assert.deepEqual(declared.findings.filter(finding => finding.board === 'BASE-LP').map(finding => finding.type), ['gate_stage_missing']);
  assert.equal(audit(p, 'BASE-PWR').strict!.pass, false);
  assert.equal(audit(p, 'BASE-PWR-B').strict!.pass, false);
  p.registry([boards[0]!, boards[1]!, { ...boards[2], lifecycle: 'obsolete' }]);
  const registry = audit(p);
  assert.deepEqual(registry.summary.obsolete, ['BASE-LP']);
  assert.equal(registry.boards.find(board => board.id === 'BASE-LP')!.obsolete, true);
  assert.ok(registry.findings.some(finding => finding.board === 'BASE-LP' && finding.type === 'gate_stage_missing'));
  assert.equal(audit(p, 'BASE-LP').strict!.pass, false);
  goodBoard(p, 'BASE-LP');
  assert.equal(audit(p, 'BASE-LP').strict!.pass, true, 'an explicitly obsolete board with complete structure can pass without an info finding');
});

test('declared pending G3 gates validate schematic-only owner revisions without activating a board', t => {
  const p = project(t), owner = `${BOARDS}/SUPPLY`, folder = `${BOARDS}/SUPPLY-C`;
  const revisions = [{ revision: 'C', spec: 'SPEC-REV-C.md', state: 'schematic-pending', gate: null, project: 'cad/C/C' }];
  const pending: Raw = { id: 'SUPPLY-C', directory: 'SUPPLY-C', kind: 'gate-only', lifecycle: 'planned', owner: 'SUPPLY', revision: 'C', pending_gate: 'gate.pending.json' };
  const register = () => p.registry([entry('SUPPLY', { lifecycle: 'planned', revisions }), pending]);
  p.write(`${owner}/SPEC-REV-C.md`, '# Schematic-only revision\n');
  p.write(`${owner}/cad/C/C.kicad_sch`, '(property "Sheetfile" "child.kicad_sch")');
  p.write(`${owner}/cad/C/child.kicad_sch`, '(x)');
  p.write(`${owner}/cad/C/C.kicad_pro`, '{}');
  const gate = { project: '../SUPPLY/cad/C/C', stage: 'G3', checks: { erc: true, drc: true } };
  p.write(`${folder}/gate.pending.json`, gate);
  register();
  const report = audit(p, 'SUPPLY-C');
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.boards.find(board => board.id === 'SUPPLY-C'), {
    id: 'SUPPLY-C', kind: 'gate-only', lifecycle: 'planned', stage: 'G3', gate_state: 'pending', obsolete: false,
  });
  assert.throws(() => boardConfig(p.root, 'SUPPLY-C'), /gate.json/, 'passing a file audit does not activate the operational gate');
  rmSync(join(p.root, owner, 'cad/C/child.kicad_sch'));
  assert.ok(paths(audit(p).findings, 'missing_native_file').some(path => path?.endsWith('child.kicad_sch')));
  p.write(`${owner}/cad/C/child.kicad_sch`, '(x)');
  p.write(`${folder}/paths.json`, {});
  p.write(`${folder}/gate.pending.json`, { ...gate, stage: 'G4', checks: FULL_CHECKS });
  assert.equal(audit(p, 'SUPPLY-C').strict!.pass, false);
  assert.ok(paths(audit(p).findings, 'missing_native_file').some(path => path?.endsWith('C.kicad_pcb')), 'pending G4 still requires a PCB');
  p.write(`${folder}/gate.pending.json`, { ...gate, stage: undefined });
  assert.ok(types(audit(p).findings).includes('gate_stage_missing'), 'pending never invents G3');
  assert.ok(paths(audit(p).findings, 'missing_native_file').some(path => path?.endsWith('C.kicad_pcb')));
  p.write(`${folder}/gate.pending.json`, gate);
  p.write(`${folder}/gate.json`, gate);
  assert.ok(audit(p).findings.some(finding => finding.type === 'registry_schema' && /active gate.json/.test(finding.detail)));
  assert.ok(paths(audit(p).findings, 'missing_native_file').some(path => path?.endsWith('C.kicad_pcb')), 'active G3 placement checks retain PCB requirements');
  rmSync(join(p.root, folder, 'gate.json'));
  pending.pending_gate = '../outside.json'; register();
  assert.ok(types(audit(p).findings).includes('registry_schema'));
  pending.pending_gate = 'gate.pending.json'; register();
  p.write(`${folder}/gate.pending.json`, { ...gate, project: '../SUPPLY/cad/OTHER/OTHER' });
  assert.ok(types(audit(p).findings).includes('gate_project_mismatch'));
  p.write(`${folder}/gate.pending.json`, gate);
  pending.lifecycle = 'active'; register();
  assert.ok(audit(p).findings.some(finding => finding.type === 'registry_schema' && /active board/.test(finding.detail)));
  pending.lifecycle = 'planned'; register();
  rmSync(join(p.root, folder, 'gate.pending.json'));
  assert.ok(paths(audit(p).findings, 'missing_required_file').includes(`${folder}/gate.pending.json`));
});

test('the audit always exits 0 with a JSON summary and --strict decides on one board', t => {
  const p = project(t);
  goodBoard(p, 'GOOD');
  goodBoard(p, 'BAD');
  rmSync(join(p.root, BOARDS, 'BAD/route.json'));
  p.registry([entry('GOOD'), entry('BAD')]);
  const bin = fileURLToPath(new URL('../pcb', import.meta.url));
  const run = (...args: string[]) => {
    const done = spawnSync(bin, ['--project', p.root, 'project-check', ...args], { encoding: 'utf8' });
    return { status: done.status, stderr: done.stderr, report: done.stdout ? JSON.parse(done.stdout) : null };
  };
  const plain = run('--layout');
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.report.mode, 'audit');
  assert.deepEqual(plain.report.summary.by_type, { missing_required_file: 1 });
  assert.match(plain.stderr, /^AUDIT: project-check 2 boards, 1 findings/);
  assert.equal(run('--layout', '--strict', 'GOOD').status, 0);
  const bad = run('--layout', '--strict', 'BAD');
  assert.equal(bad.status, 1);
  assert.deepEqual(bad.report.strict, { board: 'BAD', violations: 1, pass: false });
  assert.match(bad.stderr, /^FAIL: project-check BAD: 1 violations/);
  assert.equal(run('--layout', '--strict', 'NOPE').report.strict.pass, false, 'a mistyped board does not pass');
  assert.equal(run('--layout', '--strict', 'NOPE').status, 1);
  assert.equal(run().status, 2);
  rmSync(join(p.root, 'hardware-design/registry/boards.json'));
  const none = run('--layout');
  assert.equal(none.status, 0);
  assert.equal(none.report.summary.by_type.registry_schema, 1);
});

test('project-check refuses inherited iotroute threads before a native run', t => {
  const p = project(t);
  goodBoard(p, 'BAD');
  p.registry([entry('BAD')]);
  p.write(`${BOARDS}/BAD/route.json`, { ...ROUTE, budget: { threads: 2 } });
  const bin = fileURLToPath(new URL('../pcb', import.meta.url));
  const done = spawnSync(bin, ['--project', p.root, 'project-check', '--layout', '--strict', 'BAD'], { encoding: 'utf8' });
  assert.equal(done.status, 1, done.stderr);
  const report = JSON.parse(done.stdout);
  assert.ok(report.findings.some((finding: Finding) => finding.type === 'route_schema' && finding.detail === 'stage main: threads has no iotroute meaning'));
});

test('iotroute backend admission honors stage overrides and names unsupported options and features', () => {
  const features = new Set(['rule_compiler', 'via_off_small_pads', 'via_halo', 'routing_rules']);
  const base = { ...ROUTE, budget: { threads: 2 }, stages: [{ name: 'main', threads: 0, unlock_nets: [], via_skip: [] }] };
  assert.deepEqual(routePlanErrors(base, features), [], 'zero overrides the inherited thread budget');
  assert.deepEqual(routePlanErrors({ ...base, features: { rule_compiler: true, via_off_small_pads: true, via_halo: true } }, features), []);
  assert.deepEqual(routePlanErrors({ ...base, stages: [{ name: 'main', threads: 3, unlock_nets: ['A'], via_skip: ['B'] }], features: { routing_rules: false, via_halo: false } }, features), [
    'stage main: threads has no iotroute meaning',
    'stage main: unlock_nets has no iotroute meaning',
    'stage main: via_skip has no iotroute meaning',
    'feature routing_rules has no iotroute meaning',
    'feature via_halo cannot be off: iotroute always does this',
  ]);
  assert.deepEqual(routePlanErrors({ ...base, backend: 'tracemaker', stages: [{ name: 'main', threads: 3, unlock_nets: ['A'], via_skip: ['B'] }], features: { routing_rules: false, via_halo: false } }, features), []);
});

test('a planned physical pending board needs schematic indexes and a matching non-active revision', t => {
  const p = project(t), folder = `${BOARDS}/PLANNED`;
  p.registry([entry('PLANNED', { lifecycle: 'planned', pending_gate: 'gate.pending.json', revisions: [revision('PLANNED', { gate: null })] })]);
  for (const name of ['SPEC.md', 'STATUS.md', 'SCHEMATIC.md']) p.write(`${folder}/${name}`, '# Existing evidence\n');
  for (const extension of ['kicad_sch', 'kicad_pro']) p.write(`${folder}/cad/PLANNED/PLANNED.${extension}`, '(x)');
  const gate = { project: 'cad/PLANNED/PLANNED', stage: 'G3', checks: { erc: true } };
  p.write(`${folder}/gate.pending.json`, gate);
  assert.deepEqual(audit(p).findings, []);
  p.write(`${folder}/gate.pending.json`, { ...gate, project: 'cad/WRONG/WRONG' });
  assert.ok(types(audit(p).findings).includes('gate_project_mismatch'));
  p.write(`${folder}/gate.pending.json`, gate);
  rmSync(join(p.root, folder, 'STATUS.md'));
  assert.ok(paths(audit(p).findings, 'missing_required_file').includes(`${folder}/STATUS.md`));
});

test('a design contract exemption needs an object with a non-empty reason', t => {
  const p = project(t);
  goodBoard(p, 'GOOD');
  const details = (more: Raw): string[] => { p.registry([entry('GOOD', more)]); return audit(p).findings.filter(finding => finding.type === 'registry_schema').map(finding => finding.detail); };
  assert.deepEqual(details({ design_contract_exempt: { reason: 'legacy board' } }), []);
  for (const bad of [true, 'legacy', [], null, {}, { reason: '' }, { reason: ' ' }, { reason: 1 }]) {
    assert.deepEqual(details({ design_contract_exempt: bad }), ['design_contract_exempt must be an object with a non-empty reason'], JSON.stringify(bad));
  }
});

test('a layout plan exemption needs an object with a non-empty reason', t => {
  const p = project(t);
  goodBoard(p, 'GOOD');
  const details = (more: Raw): string[] => { p.registry([entry('GOOD', more)]); return audit(p).findings.filter(finding => finding.type === 'registry_schema').map(finding => finding.detail); };
  assert.deepEqual(details({ layout_plan_exempt: { reason: 'legacy board' } }), []);
  for (const bad of [true, 'legacy', [], null, {}, { reason: '' }, { reason: ' ' }, { reason: 1 }]) {
    assert.deepEqual(details({ layout_plan_exempt: bad }), ['layout_plan_exempt must be an object with a non-empty reason'], JSON.stringify(bad));
  }
});
