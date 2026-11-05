// The iotroute step score is measured (DRC + gate), never the router claim. iotroute run and the gate are fakes here.
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Float, number, PyError } from '../lib/py-compat.mjs';
process.env.IOTROUTE_BIN = process.execPath;   // the steps run on a stand-in stage: any executable will do
import { boardId, GateWorkspace, gatePart, measure, measureKey, NO_RESULT, routeStep, routerCpu, score, type Metrics } from './iotroute-step.ts';

const CLEAN = { status: 'PASS', drc_errors: 0, unconnected: 0, parity: 0, track_length_mm: 10.0, vias: 3 };
const GATE_OK: Metrics = {
  erc_errors: 0, erc_warnings: 311, drc_errors: 0, drc_parity: 0, drc_unconnected: 0, drc_warnings: 31, planes_failures: 0, pairs_failures: 0,
  paths_low: 0, viapads: 0, kicad_happy_findings: 0, port_label_failures: 0,
};

function folder(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), 'iotroute-step-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test('the board id comes from the board folder', () => {
  assert.equal(boardId('hardware-design/boards/NET-CORE/cad/NET-CORE'), 'NET-CORE');
  assert.equal(boardId('/x/hardware-design/boards/H7-CORE'), 'H7-CORE');
  assert.throws(() => boardId('/tmp/NET-CORE'), (error: PyError) => error.type === 'ValueError');
  assert.throws(() => boardId('/x/hardware-design/boards'), (error: PyError) => error.type === 'ValueError');
});

test('the DRC part counts without a gate', () => {
  assert.equal(score({ ...CLEAN, status: 'FAIL', drc_errors: 2, unconnected: 3, parity: 1 }, null), 6);
});

test('a clean DRC needs a complete gate', () => {
  assert.equal(score(CLEAN, null), NO_RESULT);
  assert.equal(score(CLEAN, GATE_OK), 0);
  assert.equal(score(CLEAN, { ...GATE_OK, kicad_happy_findings: 4, planes_failures: 1 }), 5);
  assert.equal(score(CLEAN, { ...GATE_OK, pairs_failures: null }), NO_RESULT);
  assert.equal(score(CLEAN, {}), NO_RESULT);
});

test('a gate metric that is no int leaves the gate incomplete', () => {
  assert.equal(gatePart({ ...GATE_OK, pairs_failures: new Float(2) })[1], false);
  assert.equal(gatePart({ ...GATE_OK, pairs_failures: true })[1], false);
  assert.equal(gatePart({ ...GATE_OK, pairs_failures: -1 })[1], false);
  assert.equal(gatePart({ ...GATE_OK, unexpected: 0 })[1], false);
  assert.equal(gatePart({ erc_errors: 0 })[1], false);
  assert.deepEqual(gatePart(null), [0, false]);
});

test('warnings do not count but a fresh gate DRC failure cannot pass', () => {
  assert.equal(score(CLEAN, { ...GATE_OK, drc_warnings: 99, erc_warnings: 5, drc_errors: 1 }), 1);
  assert.equal(score({ ...CLEAN, status: 'FAIL' }, GATE_OK), NO_RESULT);
  assert.equal(score({ ...CLEAN, drc_errors: -1, unconnected: 1 }, GATE_OK), NO_RESULT);
  assert.equal(score({ ...CLEAN, drc_errors: false }, GATE_OK), NO_RESULT);
});

test('a router claim is not a result', () => {
  assert.equal(score({ status: 'ERROR', cause: 'x' }, GATE_OK), NO_RESULT);
});

test('a record that lost a count is an error, not a clean step', () => {
  assert.throws(() => score({ status: 'PASS', unconnected: 0, parity: 0 }, GATE_OK), (error: PyError) => error.type === 'KeyError');
});

async function runStep(t: TestContext, rec: object, metrics: Metrics) {
  const d = folder(t);
  const gates: string[] = [];
  const calls: [string[], string][] = [];
  const gate = { run: (routed: string) => { gates.push(routed); return metrics; } };
  const stage = (command: string[], name: string) => {
    calls.push([command, name]);
    return { returncode: 0, stdout: `PASS 0 0 0 1 1 1\n${JSON.stringify(rec)}\n` };
  };
  const out = await routeStep(join(d, 'b', 'NET-CORE.kicad_pcb'), d, 'NET-CORE', gate, 40, ['--max-time', '60'], stage);
  return { out, calls, gates, summary: JSON.parse(readFileSync(join(d, 'route-0', 'score.json'), 'utf8')), d };
}

test('a clean step runs the gate and passes', async t => {
  const { out, calls, gates, summary, d } = await runStep(t, CLEAN, GATE_OK);
  const [command, stage] = calls[0];
  assert.equal(stage, 'routing');
  assert.equal(command[1], 'run');
  assert.equal(command[2], 'NET-CORE');
  assert.ok(command[3].endsWith('route-0/NET-CORE.kicad_pcb'));
  assert.equal(command[command.indexOf('--iters') + 1], '40');
  assert.ok(command.includes('--max-time'));
  assert.deepEqual([out, gates.length, summary.passed], [[0], 1, true]);
  assert.match(readFileSync(join(d, 'route-0.log'), 'utf8'), /^PASS 0 0 0/);
});

test('a DRC fail skips the gate', async t => {
  const { out, gates, summary } = await runStep(t, { ...CLEAN, status: 'FAIL', drc_errors: 1 }, GATE_OK);
  assert.deepEqual([out, gates, summary.passed], [[1], [], false]);
});

test('gate findings fail the step', async t => {
  assert.deepEqual((await runStep(t, CLEAN, { ...GATE_OK, kicad_happy_findings: 2 })).out, [2]);
});

test('a run with no record is no result, and no gate runs', async t => {
  const d = folder(t);
  const gate = { run: () => assert.fail('no gate without a record') };
  assert.deepEqual(await routeStep(join(d, 'B.kicad_pcb'), d, 'B', gate, 1, [], () => ({ returncode: 1, stdout: 'crashed\n' })), [NO_RESULT]);
  const summary = JSON.parse(readFileSync(join(d, 'route-0/score.json'), 'utf8'));
  assert.equal(summary.run.status, 'ERROR');
  assert.equal(summary.gate, 'not run: DRC part not 0 or no record');
});

test('score.json keeps the floats of the record and the indent of json.dump', async t => {
  const d = folder(t);
  const gate = { run: () => GATE_OK };
  await routeStep(join(d, 'B.kicad_pcb'), d, 'B', gate, 1, [], () => ({ returncode: 0, stdout: '{"status": "PASS", "drc_errors": 0, "unconnected": 0, "parity": 0, "track_length_mm": 12.0}\n' }));
  const text = readFileSync(join(d, 'route-0/score.json'), 'utf8');
  assert.ok(text.startsWith('{\n "router": "iotroute",\n "score": 0,\n "run": {\n  "status": "PASS",'), text);
  assert.ok(text.includes('"track_length_mm": 12.0'));
  assert.ok(!text.endsWith('\n'));
});

test('the measure reads the saved board counts of the run', t => {
  const d = folder(t);
  const path = join(d, 'route-0', 'score.json');
  mkdirSync(join(d, 'route-0'));
  writeFileSync(path, JSON.stringify({ run: { ...CLEAN, track_length_mm: 1580.26, vias: 296, board_file: '/x/route-0/B.kicad_pcb' } }));
  const m = measure(d);
  assert.deepEqual([number(m?.length_mm), m?.vias, m?.routed], [1580.3, 296, '/x/route-0/B.kicad_pcb']);
  assert.match(m?.source as string, /copper_counts/);
  writeFileSync(path, JSON.stringify({ run: { status: 'ERROR' } }));
  assert.equal(measure(d), null);
  writeFileSync(path, 'not json');
  assert.equal(measure(d), null);
  assert.equal(measure('/nonexistent'), null);
});

test('the measure of a repair key', () => {
  const m = measureKey([0, 0, 1567.04, 291], '/r/routed.kicad_pcb', 'repair');
  assert.deepEqual([number(m?.length_mm), m?.vias], [1567, 291]);
  assert.ok(m?.source?.startsWith('repair'));
  assert.equal(measureKey([1, 0, Infinity, 0], 'x'), null);
  assert.equal(measureKey([1, 0, NaN, 0], 'x'), null);
  assert.equal(measureKey([1, 0], 'x'), null);
  assert.equal(measureKey([1, 0, null, 0], 'x'), null);
});

test('the router CPU follows its real thread use', t => {
  const core = folder(t);
  assert.equal(routerCpu(8, join(core, 'absent')), 8);   // cannot be read: the whole budget
  writeFileSync(join(core, 'Cargo.toml'), '[package]\n');
  assert.equal(routerCpu(8, core), 8);   // no source: fail safe
  mkdirSync(join(core, 'src/deep'), { recursive: true });
  writeFileSync(join(core, 'src/deep/a.rs'), 'fn main() {}\n');
  assert.equal(routerCpu(8, core), 2);
  assert.equal(routerCpu(1, core), 1);
  writeFileSync(join(core, 'src/deep/b.rs'), 'use rayon::prelude::*;\n');
  assert.equal(routerCpu(8, core), 8);
});

function gateBoard(t: TestContext, config: string) {
  const out = folder(t);
  const made: string[][] = [];
  const snapshot = (root: string, workspace: string, board: string) => {
    made.push([root, workspace, board]);
    mkdirSync(join(workspace, 'hardware-design/boards', board), { recursive: true });
    writeFileSync(join(workspace, 'hardware-design/boards', board, config), JSON.stringify({ project: 'cad/B' }));
    mkdirSync(join(workspace, 'hardware-design/boards', board, 'cad'));
  };
  return { out, made, snapshot };
}

test('the gate workspace verifies each fresh receipt and exact routed board', async t => {
  const { out, made, snapshot } = gateBoard(t, 'gate.json');
  const commands: { command: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  const runner = (command: string[], { cwd, log, env }: { cwd: string; log: number; env: NodeJS.ProcessEnv }) => {
    commands.push({ command, cwd, env });
    writeFileSync(log, 'gate output\n');
    if (command[1].endsWith('gate.mjs') && !command[1].endsWith('check-release-gate.mjs')) {
      const evidence = command[command.indexOf('--evidence-dir') + 1];
      mkdirSync(evidence);
      writeFileSync(join(evidence, 'result.json'), JSON.stringify({ exit: 0, changedDuringRun: false, preflightErrors: [], metrics: GATE_OK }));
    }
    return { returncode: 0 };
  };
  writeFileSync(join(out, 'routed.kicad_pcb'), 'routed copper');
  const gate = new GateWorkspace(out, 'B', snapshot, runner);
  const run = (n: number) => gate.run(join(out, 'routed.kicad_pcb'), join(out, `evidence-${n}`), join(out, `gate-${n}.log`));
  assert.deepEqual(await run(1), GATE_OK);
  assert.deepEqual(await run(2), GATE_OK);
  assert.equal(made.length, 1);
  assert.equal(readFileSync(`${gate.project}.kicad_pcb`, 'utf8'), 'routed copper');
  assert.equal(commands[0].cwd, gate.path);
  assert.equal(commands[0].env.IOT_LAB, gate.path);
  assert.deepEqual(commands[0].command.slice(2), ['B', '--fresh', '--evidence-dir', join(out, 'evidence-1')]);
  assert.deepEqual(commands[1].command.slice(2), ['B', '--gate-dir', join(out, 'evidence-1')]);
});

test('a pending gate cannot be accepted as full gate evidence', async t => {
  const { out, snapshot } = gateBoard(t, 'gate.pending.json');
  const commands: string[][] = [];
  writeFileSync(join(out, 'routed.kicad_pcb'), 'routed copper');
  const gate = new GateWorkspace(out, 'B', snapshot, command => { commands.push(command); return { returncode: 0 }; });
  assert.equal(await gate.run(join(out, 'routed.kicad_pcb'), join(out, 'evidence'), join(out, 'gate.log')), null);
  assert.deepEqual(commands, []);
});

test('nonzero process status cannot promote a clean-looking route record', async t => {
  const d = folder(t), gate = { run: () => assert.fail('gate must not run after failed router') };
  const out = await routeStep(join(d, 'B.kicad_pcb'), d, 'B', gate, 1, [], () => ({ returncode: 1, stdout: JSON.stringify(CLEAN) }));
  assert.deepEqual(out, [NO_RESULT]);
});

test('gate process, evidence verifier, stale result and incomplete metrics all fail closed', async t => {
  const { out, snapshot } = gateBoard(t, 'gate.json');
  writeFileSync(join(out, 'routed.kicad_pcb'), 'routed copper');
  for (const kind of ['gate-failed', 'verify-failed', 'changed-result', 'missing-metric', 'gate-error'] as const) {
    const evidence = join(out, `evidence-${kind}`);
    const runner = (command: string[]) => {
      if (command[1].endsWith('/gate.mjs')) {
        mkdirSync(evidence);
        const metrics = { ...GATE_OK };
        if (kind === 'missing-metric') delete metrics.viapads;
        writeFileSync(join(evidence, 'result.json'), JSON.stringify({ exit: kind === 'gate-error' ? 1 : 0, changedDuringRun: false, preflightErrors: [], metrics }));
        return { returncode: kind === 'gate-failed' ? 1 : 0 };
      }
      if (kind === 'changed-result') writeFileSync(join(evidence, 'result.json'), '{}');
      return { returncode: kind === 'verify-failed' ? 1 : 0 };
    };
    const gate = new GateWorkspace(join(out, `run-${kind}`), 'B', snapshot, runner);
    assert.equal(await gate.run(join(out, 'routed.kicad_pcb'), evidence, join(out, `gate-${kind}.log`)), null, kind);
  }
});

test('a pre-existing gate receipt is not accepted or overwritten', async t => {
  const { out, snapshot } = gateBoard(t, 'gate.json');
  const evidence = join(out, 'evidence'); mkdirSync(evidence);
  writeFileSync(join(evidence, 'result.json'), 'previous result');
  writeFileSync(join(out, 'routed.kicad_pcb'), 'routed copper');
  const gate = new GateWorkspace(out, 'B', snapshot, () => assert.fail('stale evidence must not launch a gate'));
  assert.equal(await gate.run(join(out, 'routed.kicad_pcb'), evidence, join(out, 'gate.log')), null);
  assert.equal(readFileSync(join(evidence, 'result.json'), 'utf8'), 'previous result');
});

test('a snapshot cannot write through a dangling symlink or a hard link to the canonical board', async t => {
  const { out, snapshot } = gateBoard(t, 'gate.json');
  const canonical = join(out, 'canonical.kicad_pcb'), routed = join(out, 'routed.kicad_pcb');
  writeFileSync(canonical, 'canonical'); writeFileSync(routed, 'candidate');
  const runner = () => ({ returncode: 1 });
  const linked = new GateWorkspace(join(out, 'hard'), 'B', async (root, workspace, board) => {
    snapshot(root, workspace, board);
    linkSync(canonical, join(workspace, 'hardware-design/boards/B/cad/B.kicad_pcb'));
  }, runner);
  assert.equal(await linked.run(routed, join(out, 'hard-evidence'), join(out, 'hard.log')), null);
  assert.equal(readFileSync(canonical, 'utf8'), 'canonical');
  const dangling = new GateWorkspace(join(out, 'symlink'), 'B', async (root, workspace, board) => {
    snapshot(root, workspace, board);
    symlinkSync(join(out, 'outside-missing'), join(workspace, 'hardware-design/boards/B/cad/B.kicad_pcb'));
  }, runner);
  await assert.rejects(() => dangling.run(routed, join(out, 'sym-evidence'), join(out, 'sym.log')), /symlink/);
  assert.equal(readFileSync(canonical, 'utf8'), 'canonical');
});
