// Candidate operations through the real owned supervisor. The tools they run are fixtures; the isolation, evidence and verdict are not.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { iotrouteMissing } from './iotroute-bin.ts';
import { exemptBoard } from './design-exempt-fixture.ts';
import { BOARD as FIXTURE_BOARD, makeFixture } from './part-fixture.ts';
import { verify } from './pcb-evidence.ts';
import { postVerifyCommands } from './pcb-candidate-run.ts';
import { candidateLayoutCheck, designAdmission, type OperationManifest } from './pcb-candidate-screens.ts';
import { EscapeStageReceipts } from './route-decision-escape.ts';
import { status } from './pcb-runs.ts';
import { sha } from './pcb-workflow.ts';

type Row = Record<string, any>;
const tools = fileURLToPath(new URL('..', import.meta.url));
const needsBinary = { skip: iotrouteMissing() };
const BOARD = '(kicad_pcb (version 20240108) (generator test) (net 0 "") (gr_line (start 0 0) (end 1 0) (layer "Edge.Cuts")))\n';
const MOVED = BOARD.replace('(version 20240108)', '(version 20240109)').replace('(net 0 "")', '(net 0 "") (segment (start 1 1) (end 2 2) (width 0.2) (layer "F.Cu") (net 0))');
const RESHAPED = BOARD.replace('(end 1 0)', '(end 9 0)');

const GATE = (code = 0) => `
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
const dir = process.argv[process.argv.indexOf('--evidence-dir') + 1]; mkdirSync(dir, { recursive: true });
const event = type => appendFileSync(dir + '/events.jsonl', JSON.stringify({ schema_version: 1, time: new Date().toISOString(), type }) + '\\n');
event('gate.start');
writeFileSync(dir + '/findings.json', JSON.stringify({ complete: true, inputs_valid: true, findings: [] }));
writeFileSync(dir + '/result.json', JSON.stringify({ exit: ${code}, changedDuringRun: false, metrics: { drc: ${code} }, provenance: { input_sha256: 'a'.repeat(64), inputs: [], tools: { kicad: 'fixture' } }, checks: {} }));
event('gate.end'); process.exitCode = ${code};`;

const WRITER = (board: string, code = 0, extra = '') => `
import { readFileSync, writeFileSync } from 'node:fs';
const [, , , pcb] = process.argv;
if (process.env.FIXTURE_EXPECT && readFileSync(pcb, 'utf8') !== process.env.FIXTURE_EXPECT) process.exit(9);
writeFileSync(pcb, process.env.FIXTURE_BOARD ?? ${JSON.stringify(board)}); ${extra}
process.stdout.write('edited\\n'); process.exitCode = ${code};`;

function project(t: { after(fn: () => void): void }, writer = WRITER(MOVED), gate = GATE()): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pcb-operation-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'tools'));
  mkdirSync(join(root, 'hardware-design/boards/X/cad'), { recursive: true });
  writeFileSync(join(root, 'hardware-design/boards/X/gate.json'), '{"project":"cad/X","checks":{"drc":true}}');
  for (const suffix of ['kicad_sch', 'kicad_pro']) writeFileSync(join(root, `hardware-design/boards/X/cad/X.${suffix}`), '{}');
  writeFileSync(join(root, 'hardware-design/boards/X/cad/X.kicad_pcb'), BOARD);
  writeFileSync(join(root, 'tools/gate.mjs'), gate);
  writeFileSync(join(root, 'tools/pcbtool.ts'), writer);
  writeFileSync(join(root, 'tools/pcb_snapshot_inputs.mjs'), 'console.log("[]");');
  writeFileSync(join(root, 'spec.json'), '{"place":{}}');
  exemptBoard(root, 'X');
  return root;
}

let fixtureEnv: NodeJS.ProcessEnv = {};
const pcb = (root: string, ...args: string[]) => spawnSync(join(tools, 'pcb'), ['--project', root, ...args], { encoding: 'utf8', cwd: root, env: { ...process.env, ...fixtureEnv } });

async function settled(folder: string): Promise<Row> {
  for (let i = 0; i < 600; i++) {
    const state = status(folder);
    if (['passed', 'failed', 'error', 'cancelled', 'timeout'].includes(String(state.get('status'))) && state.get('controller_alive') !== true) break;
    await delay(50);
  }
  return JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8')) as Row;
}

async function run(root: string, ...args: string[]): Promise<{ folder: string; result: Row }> {
  const call = pcb(root, ...args, '--detach', '--json');
  assert.equal(call.status, 0, call.stderr || call.stdout);
  const folder = join(root, '.gate/cli', (JSON.parse(call.stdout) as Row).run_id as string);
  return { folder, result: await settled(folder) };
}

const eventRows = (folder: string): Row[] => (existsSync(join(folder, 'events.jsonl')) ? readFileSync(join(folder, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Row) : []);
const edit = (root: string, ...more: string[]) => run(root, 'edit', 'X', '--kind', 'place', '--spec', join(root, 'spec.json'), ...more);

test('a verified candidate stays isolated and seals its board, gate and source receipts', needsBinary, async t => {
  const root = project(t), canonical = join(root, 'hardware-design/boards/X/cad/X.kicad_pcb');
  const { folder, result } = await edit(root);
  assert.equal(result.status, 'passed', String(result.cause));
  assert.equal(result.scope, 'candidate_board_gate');
  assert.equal(result.candidate_verified, true);
  assert.equal(result.identity_preserved, true);
  assert.deepEqual(result.protected_source_changes, []);
  assert.equal(result.source_unchanged, true);
  assert.equal(result.cleanup.complete, true);
  assert.equal(result.gate_result, join(folder, 'gate/result.json'));
  assert.equal(readFileSync(canonical, 'utf8'), BOARD);
  assert.equal(readFileSync(result.candidate, 'utf8'), MOVED);
  assert.equal(result.candidate_sha256, sha(result.candidate));
  assert.equal(verify(folder).get('status'), 'passed');
  for (const name of ['operation/result.json', 'operation/source.json', 'gate/result.json', 'gate/findings.json']) assert.ok(result.evidence_sha256[name], name);
  assert.ok(result.artifacts['operation/edit.log']);
  const rows = eventRows(folder), types = rows.map(row => row.type);
  for (const type of ['tool.start', 'tool.output', 'tool.exit', 'gate.start', 'gate.end', 'run.end']) assert.ok(types.includes(type), type);
  assert.ok(rows.some(row => row.type === 'stage.end' && row.stage === 'snapshot'));
  assert.equal(rows.filter(row => row.type === 'gate.end').length, 1);
});

test('a failing gate keeps the candidate as a failed, sealed observation', needsBinary, async t => {
  const { folder, result } = await edit(project(t, WRITER(MOVED), GATE(1)));
  assert.equal(result.status, 'failed');
  assert.equal(result.cause, 'candidate does not meet configured gate targets');
  assert.equal(result.candidate_verified, false);
  assert.deepEqual(result.metrics, { drc: 1 });
  assert.equal(verify(folder).get('status'), 'failed');
});

test('a failing tool stops before the gate and names its operation', needsBinary, async t => {
  const { folder, result } = await edit(project(t, WRITER(BOARD, 3)));
  assert.equal(result.status, 'failed');
  assert.equal(result.cause, 'edit tool failed');
  assert.equal(result.tool_exit, 3);
  assert.equal(result.candidate_verified, false);
  assert.equal(result.continuation_allowed, false, 'failed edit never grants routing continuation');
  assert.equal(existsSync(join(folder, 'gate')), false);
});

test('changing protected identity or any other source is rejected before the gate', needsBinary, async t => {
  const reshaped = await edit(project(t, WRITER(RESHAPED)));
  assert.equal(reshaped.result.status, 'failed');
  assert.match(reshaped.result.cause, /protected design inputs/);
  assert.equal(reshaped.result.identity_preserved, false);
  assert.equal(existsSync(join(reshaped.folder, 'gate')), false);
  const { result } = await edit(project(t, WRITER(MOVED, 0, `writeFileSync('hardware-design/boards/X/gate.json', '{"project":"cad/X","checks":{}}');`)));
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.protected_source_changes, ['hardware-design/boards/X/gate.json']);
});

test('failed tools cannot make altered identity or protected sources continuable', needsBinary, async t => {
  const changed = await edit(project(t, WRITER(RESHAPED, 3)));
  assert.equal(changed.result.candidate_verified, false);
  assert.equal(changed.result.identity_preserved, false);
  assert.equal(changed.result.continuation_allowed, false);
  const altered = await edit(project(t, WRITER(BOARD, 3, `writeFileSync('hardware-design/boards/X/gate.json', '{}');`)));
  assert.deepEqual(altered.result.protected_source_changes, ['hardware-design/boards/X/gate.json']);
  assert.equal(altered.result.continuation_allowed, false);
});

test('canonical source changing during the operation invalidates its verdict', needsBinary, async t => {
  const root = project(t);
  const writer = WRITER(MOVED, 0, `writeFileSync(${JSON.stringify(join(root, 'hardware-design/boards/X/cad/X.kicad_sch'))}, 'edited meanwhile');`);
  writeFileSync(join(root, 'tools/pcbtool.ts'), writer);
  const { result } = await edit(root);
  assert.equal(result.status, 'error');
  assert.equal(result.cause, 'canonical source changed during candidate operation');
});

test('a candidate continues from its sealed parent; changed canonical inputs refuse it', needsBinary, async t => {
  const root = project(t), canonical = join(root, 'hardware-design/boards/X/cad/X.kicad_pcb');
  const parent = await edit(root), id = parent.folder.split('/').at(-1)!;
  assert.equal(parent.result.status, 'passed', String(parent.result.cause));
  const second = MOVED.replace('(start 1 1)', '(start 3 3)');
  t.after(() => { fixtureEnv = {}; });
  fixtureEnv = { FIXTURE_EXPECT: MOVED, FIXTURE_BOARD: second };
  const child = await edit(root, '--from-run', id);
  assert.equal(child.result.status, 'passed', String(child.result.cause));
  assert.equal(readFileSync(child.result.candidate, 'utf8'), second);
  assert.equal(readFileSync(canonical, 'utf8'), BOARD);
  assert.equal((JSON.parse(readFileSync(join(child.folder, 'run.json'), 'utf8')) as Row).from_run.folder, parent.folder);
  writeFileSync(join(root, 'tools/gate.mjs'), GATE() + '\n');
  const refused = await edit(root, '--from-run', id);
  assert.equal(refused.result.status, 'error');
  assert.match(refused.result.cause, /canonical inputs changed since parent candidate creation/);
});

test('bad options stop at the command line, before any run exists', t => {
  const root = project(t);
  const rejected: [string[], RegExp][] = [
    [['edit', 'X', '--kind', 'place'], /requires --spec/],
    [['edit', 'X', '--spec', 'spec.json', '--kind', 'other'], /--kind/],
    [['repair', 'X'], /requires --plan/],
    [['route', 'X', '--router', 'engine', '--spec', 'spec.json'], /--router must be one of/],
    [['route', 'X'], /--router explicit requires --spec/],
    [['route', 'X', '--router', 'route-json', '--spec', 'spec.json'], /requires a iot-lab.route.v1 spec/],
    [['build', 'X', '--spec', 'spec.json'], /--spec is not supported for build/],
    [['build'], /requires one board ID/],
    [['view', 'run-x'], /usage/],
  ];
  for (const [args, cause] of rejected) {
    const call = pcb(root, ...args);
    assert.equal(call.status, 2, args.join(' '));
    assert.match(call.stderr, cause);
  }
  assert.equal(existsSync(join(root, '.gate/cli')) && readdirSync(join(root, '.gate/cli')).some(name => name.startsWith('run-')), false);
});

test('no operation of tools/pcb falls back to Python', t => {
  const root = project(t), shim = join(root, 'shim');
  mkdirSync(shim);
  for (const name of ['python3', 'python']) writeFileSync(join(shim, name), '#!/bin/sh\necho python-was-called >&2\nexit 72\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${shim}:${process.env.PATH}` };
  for (const args of [['build', 'X'], ['route', 'X'], ['edit', 'X'], ['repair', 'X'], ['release'], ['adopt', 'run-x'], ['cycle', 'status', 'cycle-x'], ['nonsense']]) {
    const call = spawnSync(join(tools, 'pcb'), ['--project', root, ...args], { encoding: 'utf8', env });
    assert.doesNotMatch(call.stderr, /python-was-called/, args.join(' '));
    assert.notEqual(call.status, 72, args.join(' '));
  }
  assert.doesNotMatch(readFileSync(join(tools, 'pcb'), 'utf8'), /python/);
});

function iotroute(root: string, body: string): void {
  // A route run admits the gate first: a valid configuration, and the validator in the snapshot.
  writeFileSync(join(root, 'hardware-design/boards/X/gate.json'), JSON.stringify({ project: 'cad/X', stage: 'G4', checks: { erc: true, drc: true, paths: 'paths.json', viapads: {}, kicad_happy: {}, port_labels: true } }));
  mkdirSync(join(root, 'tools/lib'));
  writeFileSync(join(root, 'tools/lib/gate-core.mjs'), readFileSync(new URL('./gate-core.mjs', import.meta.url)));
  mkdirSync(join(root, 'tools/router'));
  writeFileSync(join(root, 'tools/router/route-dispatch.mjs'), `
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2), routed = args[args.indexOf('run') + 2], pcb = args[args.indexOf('--pcb') + 1], record = routed + '.iotroute';
mkdirSync(record, { recursive: true });
${body}`);
}

test('iotroute replaces the candidate only from a PASS record with its board', needsBinary, async t => {
  const root = project(t);
  iotroute(root, `writeFileSync(routed, ${JSON.stringify(MOVED)});
writeFileSync(record + '/result.json', JSON.stringify({ status: 'PASS', board_file: routed, drc_errors: 0, unconnected: 0, parity: 0 }));`);
  const { folder, result } = await run(root, 'route', 'X', '--router', 'iotroute');
  assert.equal(result.status, 'passed', String(result.cause));
  assert.equal(readFileSync(result.candidate, 'utf8'), MOVED);
  assert.ok(existsSync(join(folder, 'operation/router-summary.json')));
  assert.equal((JSON.parse(readFileSync(join(folder, 'run.json'), 'utf8')) as Row).router, 'iotroute');
});

test('an iotroute DRC failure is a failed route with a cause, and the board stays', needsBinary, async t => {
  const root = project(t);
  iotroute(root, `writeFileSync(record + '/result.json', JSON.stringify({ status: 'FAIL', drc_errors: 2, unconnected: 1, parity: 0 })); process.exitCode = 1;`);
  const { folder, result } = await run(root, 'route', 'X', '--router', 'iotroute');
  assert.equal(result.status, 'failed');
  assert.equal(result.cause, 'iotroute DRC not clean: errors 2 unconnected 1 parity 0');
  assert.equal(readFileSync(join(folder, 'workspace/hardware-design/boards/X/cad/X.kicad_pcb'), 'utf8'), BOARD);
});

test('a failed iotroute route keeps its stuck report, and the cause says what is stuck', needsBinary, async t => {
  const root = project(t);
  iotroute(root, `if (!args.includes('--diagnose') || !args.includes('--checkpoint')) throw new Error('no diagnosis asked for');
writeFileSync(record + '/drc.json', '{}');
writeFileSync(record + '/stuck.json', JSON.stringify({ work: record, summary: ['1 nets open'], open_nets: ['/A'] }));
writeFileSync(record + '/result.json', JSON.stringify({ status: 'FAIL', drc_errors: 0, unconnected: 1, parity: 0 })); process.exitCode = 1;`);
  const { folder, result } = await run(root, 'route', 'X', '--router', 'iotroute');
  assert.equal(result.status, 'failed');
  assert.equal(result.cause, 'route stuck: 1 nets open');
  assert.deepEqual((JSON.parse(readFileSync(join(folder, 'operation/stuck.json'), 'utf8')) as Row).open_nets, ['/A']);
});

test('iotroute success without a PASS record fails closed', needsBinary, async t => {
  const root = project(t);
  iotroute(root, `writeFileSync(record + '/result.json', JSON.stringify({ status: 'FAIL' }));`);
  const { result } = await run(root, 'route', 'X', '--router', 'iotroute');
  assert.equal(result.status, 'error');
  assert.match(result.cause, /without a PASS record/);
});

test('release promotes its artifacts into the receipt and does not replay events from the moved folder', needsBinary, async t => {
  const root = project(t);
  writeFileSync(join(root, 'tools/fab-workflow.sh'), `#!/bin/sh
set -eu
mkdir -p "$FAB_WORK_DIR/gate"
printf '{"schema_version":1,"time":"2026-11-04T00:00:00.000Z","type":"gate.start"}\\n' >> "$FAB_WORK_DIR/gate/events.jsonl"
printf '{"schema_version":1,"time":"2026-11-04T00:00:01.000Z","type":"stage.activity","stage":"export"}\\n' >> "$FAB_WORK_DIR/stages.jsonl"
sleep 1
mv "$FAB_WORK_DIR" "$FAB_RELEASE_OUT"
printf 'fab' > "$FAB_RELEASE_OUT/fab.zip"
`);
  chmodSync(join(root, 'tools/fab-workflow.sh'), 0o755);
  const { folder, result } = await run(root, 'release', 'X');
  assert.equal(result.status, 'passed', String(result.cause));
  assert.equal(result.scope, 'fabrication_candidate');
  assert.equal(result.artifact_directory, join(folder, 'candidate'));
  assert.ok(result.evidence_sha256['candidate/fab.zip']);
  const rows = eventRows(folder);
  assert.equal(rows.filter(row => row.type === 'gate.start').length, 1);
  assert.equal(rows.filter(row => row.type === 'stage.activity').length, 1);
});

test('cancelling stops the running tool and its operation with confirmed cleanup', needsBinary, async t => {
  const root = project(t, WRITER(MOVED, 0, 'await new Promise(done => setTimeout(done, 60000));'));
  const call = pcb(root, 'edit', 'X', '--kind', 'place', '--spec', 'spec.json', '--detach', '--json');
  assert.equal(call.status, 0, call.stderr);
  const id = (JSON.parse(call.stdout) as Row).run_id as string, folder = join(root, '.gate/cli', id);
  for (let i = 0; i < 200 && !eventRows(folder).some(row => row.type === 'tool.output' || row.type === 'tool.start'); i++) await delay(50);
  assert.equal(pcb(root, 'cancel', id, '--json').status, 0);
  const result = await settled(folder);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.cleanup.complete, true);
});

test('a deadline ends the candidate as a timeout, never as a verdict', needsBinary, async t => {
  const root = project(t, WRITER(MOVED, 0, 'await new Promise(done => setTimeout(done, 60000));'));
  const { result } = await run(root, 'edit', 'X', '--kind', 'place', '--spec', 'spec.json', '--timeout', '1');
  assert.equal(result.status, 'timeout');
  assert.equal(result.exit_code, 124);
  assert.equal(result.candidate_verified, undefined);
});

test('an incomplete part review stops before the snapshot', needsBinary, async t => {
  const root = project(t), manifest = join(root, 'hardware-design/registry/part-reviews/X.json');
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(manifest, '{"schema":"iot-lab.part-use.v1","board":"X","parts":[]}');
  const { folder, result } = await edit(root);
  assert.equal(result.status, 'failed');
  assert.equal(result.scope, 'engineering_preflight');
  assert.equal(existsSync(join(folder, 'workspace')), false);
});

test('reviewed part use screens a copper edit before and after the tool', needsBinary, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pcb-operation-review-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  exemptBoard(root, FIXTURE_BOARD, undefined, { revisions: [{ revision: 'synthetic-1', spec: 'SPEC.md', state: 'review', gate: FIXTURE_BOARD }] });
  const manifest = makeFixture(root);
  mkdirSync(join(root, 'tools'), { recursive: true });
  writeFileSync(join(root, 'tools/gate.mjs'), GATE());
  writeFileSync(join(root, 'tools/pcbtool.ts'), 'process.stdout.write("no change\\n");');
  writeFileSync(join(root, 'tools/pcb_snapshot_inputs.mjs'), 'console.log("[]");');
  writeFileSync(join(root, 'spec.json'), '{"routes":[]}');
  const { folder, result } = await run(root, 'edit', FIXTURE_BOARD, '--kind', 'route', '--spec', join(root, 'spec.json'), '--engineering-manifest', manifest);
  assert.equal(result.status, 'passed', String(result.cause));
  for (const name of ['part-review.json', 'placement-preflight.json', 'placement-postcheck.json']) assert.ok(result.evidence_sha256[`operation/${name}`], name);
  assert.equal((JSON.parse(readFileSync(join(folder, 'operation/placement-postcheck.json'), 'utf8')) as Row).status, 'passed');
  assert.equal((JSON.parse(readFileSync(join(folder, 'run.json'), 'utf8')) as Row).engineering_manifest.sha256, sha(manifest));
});

test('an unexpected failure is a sealed error in the operation\'s own scope', needsBinary, async t => {
  const root = project(t);
  rmSync(join(root, 'tools/gate.mjs'));
  writeFileSync(join(root, 'spec.json'), '{"place":{}}');
  const contract = join(root, 'hardware-design/registry/design-contracts/X.json');
  mkdirSync(dirname(contract), { recursive: true });
  writeFileSync(contract, '{"identity":{"board":"OTHER","design_id":"OTHER"}}');
  const { result } = await edit(root);
  assert.equal(result.status, 'error');
  assert.equal(result.scope, 'candidate_board_gate');
});

test('a design contract of another board stops the run before any work', needsBinary, async t => {
  const root = project(t), contract = join(root, 'hardware-design/registry/design-contracts/X.json');
  mkdirSync(dirname(contract), { recursive: true });
  writeFileSync(contract, '{"identity":{"board":"OTHER","design_id":"OTHER"}}');
  const { folder, result } = await edit(root);
  assert.equal(result.status, 'error');
  assert.match(result.cause, /exact native board/);
  assert.equal(existsSync(join(folder, 'workspace')), false);
});

const journalOf = (root: string): string => join(root, '.gate/board-locks/X.adoption.json');
const canonicalOf = (root: string): string => join(root, 'hardware-design/boards/X/cad/X.kicad_pcb');
function intent(root: string, folder: string, candidate: string, pid: number, board = canonicalOf(root)): void {
  mkdirSync(dirname(journalOf(root)), { recursive: true });
  writeFileSync(journalOf(root), JSON.stringify({ run: folder.split('/').at(-1), folder, target: board, before_sha256: sha(board), after_sha256: sha(candidate), defect: null, board: 'X', pid }));
}
/** A process that has exited: its pid is free, as after a crash. */
const deadPid = (): number => spawnSync('sh', ['-c', 'echo $'], { encoding: 'utf8' }).stdout.trim() as unknown as number;

test('adoption replaces the canonical board atomically, with a backup and a receipt, and only once', needsBinary, async t => {
  const root = project(t), { folder, result } = await edit(root), id = folder.split('/').at(-1)!;
  const mode = statSync(canonicalOf(root)).mode;
  const call = pcb(root, 'adopt', id, '--json');
  assert.equal(call.status, 0, call.stdout + call.stderr);
  const receipt = JSON.parse(call.stdout) as Row;
  assert.equal(receipt.after_sha256, result.candidate_sha256);
  assert.equal(receipt.candidate_run, id);
  assert.equal(readFileSync(canonicalOf(root), 'utf8'), MOVED);
  assert.equal(readFileSync(join(folder, 'backup/X.kicad_pcb'), 'utf8'), BOARD);
  assert.equal(statSync(canonicalOf(root)).mode, mode);
  assert.deepEqual(JSON.parse(readFileSync(join(folder, 'adoption.json'), 'utf8')), receipt);
  assert.equal(existsSync(journalOf(root)), false);
  const again = pcb(root, 'adopt', id, '--json');
  assert.equal(again.status, 0, again.stdout);
  assert.deepEqual(JSON.parse(again.stdout), receipt);
  assert.equal(readFileSync(canonicalOf(root), 'utf8'), MOVED);
});

test('a source edit after the candidate blocks adoption, and the board stays free', needsBinary, async t => {
  const root = project(t), { folder } = await edit(root), id = folder.split('/').at(-1)!;
  writeFileSync(canonicalOf(root), BOARD + '\n');
  const call = pcb(root, 'adopt', id, '--json');
  assert.equal(call.status, 2);
  assert.match(call.stdout, /canonical inputs changed since candidate creation/);
  assert.equal(readFileSync(canonicalOf(root), 'utf8'), BOARD + '\n');
  assert.equal(existsSync(journalOf(root)), false);
  assert.equal(existsSync(join(folder, 'adoption.json')), false);
});

test('a failed run, or one that is not a candidate, cannot be adopted', needsBinary, async t => {
  const root = project(t, WRITER(MOVED), GATE(1)), { folder } = await edit(root);
  const call = pcb(root, 'adopt', folder.split('/').at(-1)!, '--json');
  assert.equal(call.status, 2);
  assert.match(call.stdout, /run did not finish|successful, settled candidate/);
  assert.equal(readFileSync(canonicalOf(root), 'utf8'), BOARD);
});

test('an adoption interrupted after its replacement finishes its receipt', needsBinary, async t => {
  const root = project(t), { folder, result } = await edit(root), id = folder.split('/').at(-1)!;
  mkdirSync(join(folder, 'backup'));
  writeFileSync(join(folder, 'backup/X.kicad_pcb'), BOARD);
  intent(root, folder, result.candidate, Number(deadPid()));
  writeFileSync(canonicalOf(root), MOVED);
  const call = pcb(root, 'adopt', id, '--json');
  assert.equal(call.status, 0, call.stdout + call.stderr);
  assert.equal((JSON.parse(call.stdout) as Row).after_sha256, result.candidate_sha256);
  assert.equal(existsSync(journalOf(root)), false);
});

test('an adoption interrupted before its replacement is simply done again', needsBinary, async t => {
  const root = project(t), { folder, result } = await edit(root), id = folder.split('/').at(-1)!;
  intent(root, folder, result.candidate, Number(deadPid()));
  writeFileSync(join(dirname(canonicalOf(root)), '.pcb-adopt-leftover'), 'partial');
  const call = pcb(root, 'adopt', id, '--json');
  assert.equal(call.status, 0, call.stdout + call.stderr);
  assert.equal(readFileSync(canonicalOf(root), 'utf8'), MOVED);
  assert.equal(existsSync(join(dirname(canonicalOf(root)), '.pcb-adopt-leftover')), false);
});

test('a frozen board finishes an interrupted adoption without asking for its baseline again', needsBinary, async t => {
  const root = project(t);
  writeFileSync(join(root, 'FOCUS.md'), '## Frozen\n- X\n');
  const { folder, result } = await edit(root), id = folder.split('/').at(-1)!;
  assert.equal(result.status, 'passed', String(result.cause));
  mkdirSync(join(folder, 'backup'));
  writeFileSync(join(folder, 'backup/X.kicad_pcb'), BOARD);
  intent(root, folder, result.candidate, Number(deadPid()));
  writeFileSync(canonicalOf(root), MOVED);
  const call = pcb(root, 'adopt', id, '--json');
  assert.equal(call.status, 0, call.stdout + call.stderr);
  assert.equal((JSON.parse(call.stdout) as Row).candidate_run, id);
});

test('a crash of an adoption that changes no bytes is done again, never receipted from a partial backup', needsBinary, async t => {
  const root = project(t, WRITER(BOARD)), { folder, result } = await edit(root), id = folder.split('/').at(-1)!;
  assert.equal(result.status, 'passed', String(result.cause));
  mkdirSync(join(folder, 'backup'));
  writeFileSync(join(folder, 'backup/X.kicad_pcb'), 'partial');
  intent(root, folder, result.candidate, Number(deadPid()));
  const call = pcb(root, 'adopt', id, '--json');
  assert.equal(call.status, 0, call.stdout + call.stderr);
  assert.equal(readFileSync(join(folder, 'backup/X.kicad_pcb'), 'utf8'), BOARD);
});

test('a replaced board without its exact backup is left for a person', needsBinary, async t => {
  const root = project(t), { folder, result } = await edit(root), id = folder.split('/').at(-1)!;
  intent(root, folder, result.candidate, Number(deadPid()));
  writeFileSync(canonicalOf(root), MOVED);
  const call = pcb(root, 'adopt', id, '--json');
  assert.equal(call.status, 2);
  assert.match(call.stdout, /lacks its exact backup/);
  assert.ok(existsSync(journalOf(root)));
});

test('concurrent adoptions of one board: exactly one replaces it', needsBinary, async t => {
  const root = project(t), first = await edit(root), second = await edit(root);
  const adoptRun = (folder: string) => new Promise<number>(done => {
    spawn(join(tools, 'pcb'), ['--project', root, 'adopt', folder.split('/').at(-1)!, '--json'], { stdio: 'ignore' }).once('close', code => done(code ?? 1));
  });
  const codes = await Promise.all([adoptRun(first.folder), adoptRun(second.folder)]);
  assert.deepEqual(codes.sort(), [0, 2]);
  assert.equal(existsSync(journalOf(root)), false);
  assert.equal(readFileSync(canonicalOf(root), 'utf8'), MOVED);
  assert.equal([first, second].filter(row => existsSync(join(row.folder, 'adoption.json'))).length, 1);
});

test('a live adoption, or a board matching neither side of a crash, is left alone', needsBinary, async t => {
  const root = project(t), { folder, result } = await edit(root), id = folder.split('/').at(-1)!;
  intent(root, folder, result.candidate, process.pid);
  const busy = pcb(root, 'adopt', id, '--json');
  assert.equal(busy.status, 2);
  assert.match(busy.stdout, /another adoption of X is running/);
  assert.equal(readFileSync(canonicalOf(root), 'utf8'), BOARD);
  assert.ok(existsSync(journalOf(root)));
  intent(root, folder, result.candidate, Number(deadPid()));
  writeFileSync(canonicalOf(root), BOARD + 'third party\n');
  const stuck = pcb(root, 'adopt', id, '--json');
  assert.equal(stuck.status, 2);
  assert.match(stuck.stdout, /neither side of an interrupted adoption/);
  assert.ok(existsSync(journalOf(root)));
});

test('incomplete design prerequisites stop before the snapshot, with their report', needsBinary, async t => {
  const root = project(t), contract = join(root, 'hardware-design/registry/design-contracts/X.json');
  mkdirSync(dirname(contract), { recursive: true });
  writeFileSync(contract, '{"schema":"iot-lab.design-contract.v1","identity":{"board":"X","design_id":"X","revision":"1"}}');
  const { folder, result } = await edit(root);
  assert.equal(result.status, 'failed', String(result.cause));
  assert.equal(result.scope, 'design_preflight');
  assert.equal(result.design_stage, 'schematic');
  assert.equal(result.candidate_verified, false);
  assert.ok(result.evidence_sha256['operation/design-preflight.json']);
  assert.equal(existsSync(join(folder, 'workspace')), false);
});

test('a board with no design contract and no exemption stops before the snapshot', needsBinary, async t => {
  const root = project(t);
  rmSync(join(root, 'hardware-design/registry/boards.json'));
  const { folder, result } = await edit(root);
  assert.equal(result.status, 'failed', String(result.cause));
  assert.equal(result.scope, 'design_preflight');
  assert.equal(result.candidate_verified, false);
  assert.match(String(result.cause), /board has no design contract/);
  assert.match(String(result.cause), /design_contract_exempt/);
  assert.ok(result.evidence_sha256['operation/design-preflight.json']);
  assert.equal(existsSync(join(folder, 'workspace')), false);
});

test('an exempt board continues and records one design.exempt event with the reason', needsBinary, async t => {
  const { folder, result } = await edit(project(t));
  assert.equal(result.status, 'passed', String(result.cause));
  const exempt = eventRows(folder).filter(row => row.type === 'design.exempt');
  assert.equal(exempt.length, 1);
  assert.match(String(exempt[0]!.reason), /test fixture/);
});

function admission(t: { after(fn: () => void): void }, root: string, operation = 'edit') {
  const folder = join(root, 'run'), events: Row[] = [];
  mkdirSync(join(folder, 'operation'), { recursive: true });
  const manifest = { root, board: 'X', operation, node: process.execPath, timeout_s: 1 } as OperationManifest;
  return designAdmission(root, folder, manifest, (type, data) => { events.push({ type, ...data }); }).then(report => ({ report, events, result: existsSync(join(folder, 'operation/result.json')) ? JSON.parse(readFileSync(join(folder, 'operation/result.json'), 'utf8')) as Row : null }));
}

test('design admission without a binding: exempt continues, a registered contract or none fails closed', async t => {
  const root = project(t);
  const exempt = await admission(t, root);
  assert.equal(exempt.report, null);
  assert.equal(exempt.result, null);
  assert.deepEqual(exempt.events.map(row => row.type), ['design.exempt']);
  rmSync(join(root, 'hardware-design/registry/boards.json'));
  const none = await admission(t, root, 'release');
  assert.equal(none.report?.status, 'failed');
  assert.deepEqual([none.result?.status, none.result?.scope, none.result?.candidate_verified, none.result?.qualified, none.result?.release_approved], ['failed', 'design_preflight', false, false, false]);
  assert.match(String(none.result?.cause), /board has no design contract/);
  assert.match(String(none.result?.cause), /--design-contract/);
  assert.deepEqual(none.events, []);
  const file = 'hardware-design/registry/design-contracts/X.json';
  mkdirSync(join(root, dirname(file)), { recursive: true });
  writeFileSync(join(root, file), '{}');
  const unbound = await admission(t, root);
  assert.equal(unbound.report?.status, 'failed', 'a registered contract that the run does not bind');
  assert.match(String(unbound.result?.cause), new RegExp(file));
  assert.match(String(unbound.result?.cause), /--design-contract/);
  assert.equal(unbound.result?.scope, 'design_preflight');
});

test('design admission refuses a malformed exemption instead of continuing', async t => {
  const root = project(t);
  writeFileSync(join(root, 'hardware-design/registry/boards.json'), JSON.stringify({ schema_version: 1, boards: [{ id: 'X', design_contract_exempt: { reason: '' } }] }));
  await assert.rejects(admission(t, root), /design_contract_exempt/);
});

test('the candidate layout screen writes a blocked report for a contract it cannot judge', t => {
  const root = project(t), output = join(root, 'operation/design-layout-preflight.json'), contract = join(root, 'contract.json');
  mkdirSync(dirname(output));
  writeFileSync(contract, '{"identity":{"board":"X","design_id":"X"}}');
  const manifest = { root, board: 'X', operation: 'route', node: process.execPath, timeout_s: 1, design_contract: { path: contract, sha256: sha(contract) } } as OperationManifest;
  return candidateLayoutCheck(root, root, manifest, output, () => {}, new EscapeStageReceipts()).then(report => {
    assert.equal(report.status, 'blocked');
    assert.equal(report.schema, 'iot-lab.design-candidate-layout.v1');
    assert.equal((JSON.parse(readFileSync(output, 'utf8')) as Row).status, 'blocked');
  });
});

test('gate.json post_verify hooks run on the verified candidate, and a failing one fails it', needsBinary, async t => {
  const root = project(t), gate = join(root, 'hardware-design/boards/X/gate.json');
  writeFileSync(join(root, 'tools/semantic.mjs'), `import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync(process.argv[3], readFileSync(process.argv[2], 'utf8').length + '\\n'); process.exitCode = process.env.SEMANTIC_EXIT === '1' ? 1 : 0;`);
  writeFileSync(gate, JSON.stringify({ project: 'cad/X', checks: { drc: true }, post_verify: [{ stage: 'board-semantic-0', run: ['{node}', 'tools/semantic.mjs', '{candidate}', '{operation}/board-check.txt'] }] }));
  const { folder, result } = await edit(root);
  assert.equal(result.status, 'passed', String(result.cause));
  assert.ok(existsSync(join(folder, 'operation/board-semantic-0.log')));
  assert.equal(readFileSync(join(folder, 'operation/board-check.txt'), 'utf8').trim(), String(MOVED.length));
  t.after(() => { fixtureEnv = {}; });
  fixtureEnv = { SEMANTIC_EXIT: '1' };
  const failed = await edit(root);
  assert.equal(failed.result.status, 'failed');
  assert.equal(failed.result.candidate_verified, false);
});

test('post_verify hooks fill their placeholders and require a stage and argv', () => {
  const hooks = postVerifyCommands([{ stage: 'semantic', run: ['{node}', 'check.mjs', '{candidate}', '{operation}'], env: { OUT: '{run}/x' } }], '/run', '/run/board.kicad_pcb', '/bin/node', { KEEP: '1' });
  assert.deepEqual(hooks, [{ stage: 'semantic', command: ['/bin/node', 'check.mjs', '/run/board.kicad_pcb', '/run/operation'], env: { KEEP: '1', OUT: '/run/x' } }]);
  assert.throws(() => postVerifyCommands([{ run: ['x'] }], '/r', '/c', 'n', {}), /stage and a run argv/);
  assert.deepEqual(postVerifyCommands(null, '/r', '/c', 'n', {}), []);
});
