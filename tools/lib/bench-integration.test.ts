// The study that tools/bench.ts writes must pass the real placement_outcomes evaluator. Sealed runs are built the way placement-outcomes.test.ts builds them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { POLICY } from './outcome-controls.ts';
import { evaluateStudy, type OutcomeServices } from './placement-outcomes.ts';
import { sha256File } from './json-file.ts';
import { buildStudy, runSuite, spawnExecutor, TRIAL_RECORD, type Executor } from './bench-run.ts';
import { buildResult } from './bench-analyze.ts';
import { SUITE, validateSuite, verifyInputs } from './bench-suite.ts';

type Row = Record<string, any>;
const write = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
const fp = (family: string) => `(kicad_pcb (version 20260101) (footprint "Test:Exact" (layer "F.Cu") (at ${family === 'ENV' ? 10 : 20} 10) (uuid "U1")
  (property "Reference" "U1" (at 0 0)) (property "Value" "fixture") (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "N") (uuid "U1-pad")))(property "family" "${family}"))`;
function* walk(folder: string): Generator<string> {
  for (const name of readdirSync(folder)) { const path = join(folder, name); if (statSync(path).isDirectory()) yield* walk(path); else yield path; }
}
const services: OutcomeServices = {
  pcbIdentity: path => /"family" "(\w+)"/.exec(readFileSync(path, 'utf8'))?.[1] ?? 'unknown',
  thermal: { discharge: () => { throw new Error('no thermal'); }, validateCapability: () => ({ inputs: {} }) },
};

interface Chain { candidateText?: string; sourceSha?: string; fromRun?: string }
function sealedRun(root: string, name: string, board: string, input: string, passed: boolean, chain: Chain = {}): string {
  const folder = join(root, 'runs', name), rel = `hardware-design/boards/${board}/native.kicad_pcb`, native = join(folder, 'workspace', rel);
  mkdirSync(dirname(native), { recursive: true });
  writeFileSync(native, chain.candidateText ?? fp(board));
  const files: Row = { [rel]: chain.sourceSha ?? sha256File(join(root, input)), 'tools/pcbtool.py': 'c'.repeat(64) };
  for (const extension of ['.kicad_sch', '.kicad_pro', '.kicad_dru']) {
    const path = native.replace(/\.kicad_pcb$/, extension);
    writeFileSync(path, `original ${extension}`);
    files[rel.replace(/\.kicad_pcb$/, extension)] = sha256File(path);
  }
  const command = ['python3', 'tools/pcbtool.py', 'route', rel, 'spec.json'];
  write(join(folder, 'run.json'), { root: '/x', board, project: 'native', run_id: name, operation: 'route', created_at: '2026-10-16T00:00:00Z', spec: { route: {} }, gate_config_sha256: 'd'.repeat(64), ...(chain.fromRun ? { from_run: { result_sha256: chain.fromRun } } : {}) });
  write(join(folder, 'operation/source.json'), { files });
  write(join(folder, 'operation/result.json'), { candidate: `/x/.gate/cli/${name}/workspace/${rel}`, workspace: `/x/.gate/cli/${name}/workspace`, candidate_sha256: sha256File(native),
    candidate_verified: passed, identity_preserved: true, source_unchanged: true, protected_source_changes: [], status: passed ? 'passed' : 'failed', cause: 'fixture' });
  write(join(folder, 'operation/events.jsonl'), { type: 'tool.start', command });
  const errors = passed ? 0 : 1;
  write(join(folder, 'gate/drc.json'), { source: 'native.kicad_pcb', coordinate_units: 'mm', included_severities: ['error', 'warning', 'exclusion'], violations: Array(errors).fill({ severity: 'error' }), schematic_parity: [], unconnected_items: [] });
  write(join(folder, 'gate/result.json'), { exit: passed ? 0 : 1, changedDuringRun: false, preflightErrors: [], metrics: { drc_errors: errors, drc_unconnected: 0, drc_parity: 0, paths_low: 0 },
    checks: { drc: { status: errors ? 'failed' : 'passed', cached: false } }, provenance: { inputs: [{ path: rel, sha256: sha256File(native) }], tools: { kicad: '10.0.6' } } });
  write(join(folder, 'operation/execution-policy.json'), { schema: POLICY, command, runtime: { image_id: `sha256:${'a'.repeat(64)}`, tools: { router: { sha256: 'b'.repeat(64), version: 'fixture' } } },
    resources: { cpus: 2, memory_bytes: 2147483648, threads: 1 }, effort: { timeout_s: 30, passes: 40, max_repairs: 0, optimizer: 'if-routed' } });
  const paths = [join(folder, 'run.json'), ...walk(join(folder, 'operation')), ...walk(join(folder, 'gate')), native];
  write(join(folder, 'result.json'), { status: passed ? 'passed' : 'failed', cleanup: { complete: true }, elapsed_s: passed ? 2 : 3, ended_unix_s: 1792108802, cause: 'fixture',
    evidence_sha256: Object.fromEntries(paths.map(path => [relative(folder, path), sha256File(path)])) });
  return folder;
}

test('a bench study passes the real evaluator and the proposal arm shows its extra verified trials', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bench-int-')));
  try {
    for (const board of ['ENV', 'REL']) { mkdirSync(join(root, 'inputs', board), { recursive: true }); writeFileSync(join(root, 'inputs', board, 'native.kicad_pcb'), fp(board)); }
    const suite = validateSuite({
      schema: SUITE, suite_id: 'integration', arms: [{ id: 'baseline', argv: ['x'] }, { id: 'proposal', argv: ['x'] }],
      boards: [{ family: 'A', board: 'ENV', split: 'development', input: { path: 'inputs/ENV/native.kicad_pcb', sha256: sha256File(join(root, 'inputs/ENV/native.kicad_pcb')) } },
               { family: 'B', board: 'REL', split: 'holdout', input: { path: 'inputs/REL/native.kicad_pcb', sha256: sha256File(join(root, 'inputs/REL/native.kicad_pcb')) } }],
      seeds: [1, 2], budget: { timeout_s: 30, cpus: 2, memory_gb: 2 },
    });
    verifyInputs(suite, root);
    const executor: Executor = async trial => {
      const folder = sealedRun(root, trial.id, trial.board, trial.input.path, trial.arm === 'proposal' || trial.seed === 1);
      return { schema: TRIAL_RECORD, id: trial.id, arm: trial.arm, status: 'sealed', run_id: trial.id, run_path: relative(root, folder), result_sha256: sha256File(join(folder, 'result.json')), wall_s: 1, exit_code: 0, cause: null, command: trial.argv };
    };
    const out = join(root, 'out');
    const records = await runSuite(suite, { root, runsDir: join(root, 'runs'), out, executor });
    writeFileSync(join(root, 'study.json'), JSON.stringify(buildStudy(suite, records)));
    const report = evaluateStudy(root, 'study.json', 'integration', services) as unknown as Row;
    assert.deepEqual(report.blockers, []);
    assert.equal(report.comparative_readiness, true);
    const result = buildResult(suite, 'f'.repeat(64), records, report as any, null, {});
    assert.equal(result.evidence_complete, true);
    assert.equal(result.overall.pairs, 4);
    assert.equal(result.overall.a.successes, 2);
    assert.equal(result.overall.b.successes, 4);
    assert.equal(result.overall.only_b_ok, 2);
    assert.ok(result.trials.every(item => item.evidence_valid));
    assert.equal(result.trials.find(item => item.id === 'ENV.r2.baseline')!.failure_class, 'native_errors');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a chained trial (placer step, then a continued route) passes the real evaluator and binds its sealed parent', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bench-chain-')));
  try {
    const pins: Row[] = [];
    for (const board of ['ENV', 'REL']) {
      mkdirSync(join(root, 'inputs', board), { recursive: true });
      const path = join(root, 'inputs', board, 'native.kicad_pcb');
      writeFileSync(path, fp(board));
      pins.push({ path: `inputs/${board}/native.kicad_pcb`, sha256: sha256File(path) });
    }
    const say = (id: string) => ['/bin/sh', '-c', `echo '{"run_id":"${id}"}'`];
    const suite = validateSuite({
      schema: SUITE, suite_id: 'chain',
      arms: [{ id: 'baseline', argv: say('b-{board}-{seed}') },
        { id: 'proposal', steps: [['/bin/sh', '-c', 'echo placed > "$0/placement.json"', '{work}'], say('p-{board}-{seed}'),
          ['/bin/sh', '-c', 'test "$0" = "p-$1-$2" && echo \'{"run_id":"c-\'$1\'-\'$2\'"}\'', '{prev_run}', '{board}', '{seed}']] }],
      boards: [{ family: 'A', board: 'ENV', split: 'development', input: pins[0] }, { family: 'B', board: 'REL', split: 'holdout', input: pins[1] }],
      seeds: [1, 2], budget: { timeout_s: 30, cpus: 2, memory_gb: 2 },
    });
    for (const [index, board] of ['ENV', 'REL'].entries()) {
      for (const seed of [1, 2]) {
        sealedRun(root, `b-${board}-${seed}`, board, pins[index]!.path, seed === 1);
        const text = fp(board).replace(/\(at (10|20) 10\)/, '(at 11 10)');
        const parent = sealedRun(root, `p-${board}-${seed}`, board, pins[index]!.path, true, { candidateText: text });
        const parentSha = sha256File(join(parent, 'result.json'));
        sealedRun(root, `c-${board}-${seed}`, board, pins[index]!.path, true, { sourceSha: sha256File(join(parent, 'workspace', `hardware-design/boards/${board}/native.kicad_pcb`)), fromRun: parentSha });
      }
    }
    const out = join(root, 'out');
    const records = await runSuite(suite, { root, runsDir: join(root, 'runs'), out, executor: spawnExecutor });
    const proposal = records.filter(item => item.arm === 'proposal');
    assert.ok(proposal.every(item => item.status === 'sealed' && item.run_id!.startsWith('c-') && item.parent_run && item.placement_input));
    assert.ok(records.filter(item => item.arm === 'baseline').every(item => !item.parent_run));
    assert.equal(readFileSync(join(out, 'work', 'ENV.r1.proposal', 'placement.json'), 'utf8'), 'placed\n');
    writeFileSync(join(root, 'study.json'), JSON.stringify(buildStudy(suite, records)));
    const report = evaluateStudy(root, 'study.json', 'chain', services) as unknown as Row;
    assert.deepEqual(report.blockers, []);
    const result = buildResult(suite, 'f'.repeat(64), records, report as any, null, {});
    assert.ok(result.trials.every(item => item.evidence_valid));
    assert.equal(result.overall.b.successes, 4);
    assert.equal(result.overall.a.successes, 2);
    // a placement input that is not the sealed parent's candidate must be refused
    const study = buildStudy(suite, records) as { trials: Row[] };
    const forged = study.trials.find(item => item.parent_run)!;
    forged.placement_input = pins[0];
    writeFileSync(join(root, 'forged.json'), JSON.stringify(study));
    assert.notDeepEqual((evaluateStudy(root, 'forged.json', 'chain', services) as unknown as Row).blockers, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
