// The compaction driver with a fake router: options, the route callback and the stop on an identical failure.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { SCHEMA } from '../lib/engineering-constraints.ts';
import { sha256File } from '../lib/json-file.ts';
import type { StageResult } from '../lib/lean-stage.ts';
import { Compaction, main, parseArgs, settle, type Args } from './compact-cli.ts';
import { Measured, RouteOutcome } from './compact.ts';
import { NO_RESULT } from './compact-route.ts';
import { prepareProblem, type ReviewedProblem } from './engineering-problem.ts';

const BASE = ['p.json', 'b.kicad_pcb', '--board-dir', 'x', '--outdir', 'o', '--size', '72', '80'];

let folder: string;
const realBin = process.env.IOTROUTE_BIN;

beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'compact-cli-')));
  // The routers here are fakes that never run the binary, so any executable names it: the path only fills the command.
  process.env.IOTROUTE_BIN = process.execPath;
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
  if (realBin === undefined) delete process.env.IOTROUTE_BIN;
  else process.env.IOTROUTE_BIN = realBin;
});

test('the router is iotroute and the size is two numbers', () => {
  assert.equal(parseArgs(BASE).router, 'iotroute');
  assert.equal(parseArgs([...BASE, '--router', 'iotroute']).router, 'iotroute');
  assert.throws(() => parseArgs([...BASE, '--router', 'fastroute']), /invalid choice/);
  assert.deepEqual(parseArgs(BASE).size, [72, 80]);
  assert.throws(() => parseArgs([...BASE, '--router', 'hand']), /invalid choice/);
  assert.throws(() => parseArgs(['p', 'b', '--board-dir', 'x', '--outdir', 'o', '--size', '1']), /usage/);
});

test('the schedule comes from the command line', () => {
  const given = parseArgs([...BASE, '--tol', '0.2', '--shrink', '0.8']);
  assert.deepEqual([given.tol, given.shrink], [0.2, 0.8]);
  const plain = parseArgs(BASE);
  assert.deepEqual([plain.tol, plain.shrink, plain.length_patience, plain.rank], [0.05, 0.85, 2, null]);
});

test('the iot-lab pipeline arguments parse', () => {
  const a = parseArgs(['p.json', 'b', '--board-dir', 'cad', '--outdir', 'loop', '--size', '100', '100', '--workers', '12', '--budget', '7200', '--target', '0',
    '--passes', '60', '--seeded-policy', '--retain-candidates', '3', '--max-routes', '1', '--diagnostic-budget', '0', '--param', 'p_swap=0', 'p_rot=0', 'w0=3',
    '--route-args', '--layers F.Cu,In2.Cu,B.Cu --plane-nets GND,+3V3']);
  assert.deepEqual(a.param, ['p_swap=0', 'p_rot=0', 'w0=3']);
  assert.equal(a.route_args, '--layers F.Cu,In2.Cu,B.Cu --plane-nets GND,+3V3');
  assert.equal(a.max_routes, 1);
});

test('rank defaults to the measured length, and a given rank stays', () => {
  const plain = parseArgs(BASE);
  settle(plain);
  assert.equal(plain.rank, 'length');
  const halo = parseArgs([...BASE, '--rank', 'halo']);
  settle(halo);
  assert.equal(halo.rank, 'halo');
});

test('bad options stop before anything runs', async () => {
  const cases: [string[], RegExp][] = [
    [['--budget', '0'], /budget must be positive/], [['--retain-candidates', '9'], /retain-candidates/],
    [['--max-displacement', '3'], /requires seeded policy/], [['--length-patience', '-1'], /--length-patience/],
    [['--seeded-policy', '--scatter', '3'], /seeded policy prohibits/], [['--seeded-policy', '--param', 'p_swap=0.3'], /seeded policy prohibits/],
  ];
  for (const [flags, message] of cases) await assert.rejects(main([...BASE, ...flags]), message);
});

test('a seeded policy turns off swaps and turns, and carries the cap', () => {
  const a = parseArgs([...BASE, '--seeded-policy', '--max-displacement', '3']);
  settle(a);
  assert.deepEqual(a.param, ['p_swap=0', 'p_rot=0', 'legal_rotate=0', 'max_displacement=3']);
});

/** The router of this test: `iotroute run` reports 1 open, so the step fails before its gate. */
class FakeRouter extends Compaction {
  calls = 0;
  override async stage(): Promise<StageResult> {
    this.calls += 1;
    return { returncode: 1, stdout: `${JSON.stringify({ status: 'FAIL', drc_errors: 0, unconnected: 1, parity: 0 })}\n`, stderr: '' };
  }
}

function driver(Kind: typeof Compaction = FakeRouter): FakeRouter {
  const a: Args = parseArgs(['p', join(folder, 'source.kicad_pcb'), '--board-dir', join(folder, 'hardware-design/boards/X/cad'), '--outdir', folder, '--size', '10', '10', '--passes', '1']);
  settle(a);
  const problem = { units: [{ name: 'U1', refs: ['U1'], fixed: false, x: 0, y: 0, rects: [] }], nets: [], board: { outline: [] }, board_file: a.board } as unknown as ReviewedProblem;
  return new Kind(a, problem, Number.MAX_SAFE_INTEGER) as FakeRouter;
}

test('a changed board routes again, and an identical failure is not routed again', async () => {
  const native = join(folder, 'source.kicad_pcb');
  writeFileSync(native, 'synthetic placement bytes A');
  const run = driver();
  const first = await run.route(native, 0) as Measured;
  assert.ok(first instanceof Measured);
  assert.deepEqual(first.counts, [1]);
  const unchanged = await run.route(native, 1) as RouteOutcome;
  assert.equal(unchanged.stop, true);
  assert.equal(unchanged.decision.action, 'inspect_prior_diagnosis');
  assert.equal(unchanged.decision.prior_decision, join(folder, 'step-0/route-0/score.json'));
  assert.equal(run.calls, 1);
  assert.ok(existsSync(join(folder, 'step-1/route-decision.json')));
  writeFileSync(native, 'synthetic placement bytes B');
  const changed = await run.route(native, 2) as Measured;
  assert.ok(changed instanceof Measured);
  assert.equal(run.calls, 2);
});

/** `iotroute run` with its evidence: a refused admission when `cause` says so, else opens with a pin the placer can give room. */
class EvidenceRouter extends Compaction {
  cause: string | null = null;
  override async stage(command: string[]): Promise<StageResult> {
    const out = command[3]!, work = `${out}.iotroute`;
    mkdirSync(work, { recursive: true });
    const record = this.cause === null
      ? { status: 'FAIL', drc_errors: 0, unconnected: 1, parity: 0, input_sha256: sha256File(command[command.indexOf('--pcb') + 1]!), board_file: out, board_sha256: sha256File(this.a.board) }
      : { status: 'ERROR', cause: this.cause };
    if (this.cause === null) {
      writeFileSync(out, readFileSync(this.a.board));
      writeFileSync(join(work, 'drc.json'), JSON.stringify({ violations: [], unconnected_items: [{ items: [] }], schematic_parity: [] }));
      writeFileSync(join(work, 'pin-escape.json'), JSON.stringify({ halo_hint: { U1: 0.25 } }));
    }
    writeFileSync(join(work, 'result.json'), JSON.stringify(record));
    return { returncode: 1, stdout: `${JSON.stringify(record)}\n`, stderr: '' };
  }
}

test('a step asks for a diagnosis, its evidence teaches the next search, and a refused admission stops the run', async () => {
  const native = join(folder, 'source.kicad_pcb');
  writeFileSync(native, 'bytes');
  const run = driver(EvidenceRouter as typeof Compaction) as unknown as EvidenceRouter;
  assert.ok(await run.route(native, 0) instanceof Measured);
  assert.deepEqual(run.escapeHint, { U1: 0.25 });
  assert.equal(JSON.parse(readFileSync(join(folder, 'step-0/route-decision.json'), 'utf8')).action, 'diagnose_selected_connections');
  assert.equal(JSON.parse(readFileSync(join(folder, 'step-0/feedback.json'), 'utf8')).accepted, true);
  writeFileSync(native, 'other bytes');
  run.cause = 'rule coverage refused: r / creepage: why';
  const stopped = await run.route(native, 1) as RouteOutcome;
  assert.equal(stopped.stop, true);
  assert.equal(stopped.decision.action, 'resolve_constraint_coverage');
});

test('the route cap ends routing without another attempt', async () => {
  const native = join(folder, 'source.kicad_pcb');
  writeFileSync(native, 'bytes');
  const run = driver();
  run.a.max_routes = 1;
  await run.route(native, 0);
  const capped = await run.route(native, 1) as RouteOutcome;
  assert.equal(capped.stop, true);
  assert.deepEqual(capped.counts, [NO_RESULT]);
  assert.equal(run.calls, 1);
});

class FailingRouter extends FakeRouter {
  override async stage(): Promise<StageResult> {
    this.calls += 1;
    return { returncode: 2, stdout: '', stderr: '' };
  }
}

/** A reviewed problem with an escape rule on a fixture board, in `folder`. */
function reviewed(run: FakeRouter) {
  const board = join(folder, 'hardware-design/boards/X');
  mkdirSync(join(board, 'cad'), { recursive: true });
  writeFileSync(join(board, 'gate.json'), JSON.stringify({ project: 'cad/X', checks: { erc: true, drc: true } }));
  const native = join(board, 'cad/X.kicad_pcb');
  writeFileSync(native, `(kicad_pcb (version 20260101) (footprint "T:E" (layer "F.Cu") (at 10 10) (uuid "U1") (property "Reference" "U1" (at 0 0)) (property "Value" "v")
    (fp_rect (start -0.5 -0.5) (end 0.5 0.5) (layer "F.CrtYd")) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "N") (uuid "p"))) (gr_rect (start 0 0) (end 20 20) (layer "Edge.Cuts")))`);
  const sidecars = ['.kicad_pro', '.kicad_dru', '.kicad_sch'].map(extension => native.replace(/\.kicad_pcb$/, extension));
  for (const file of sidecars) writeFileSync(file, 'fixture');
  const document = join(folder, 'reviewed.pdf'), manifest = join(folder, 'parts.json');
  writeFileSync(document, '%PDF-1.4\n');
  writeFileSync(manifest, '{}\n');
  const source = { path: 'reviewed.pdf', sha256: sha256File(document), page: 1 };
  const review = {
    status: 'passed', constraints: { schema: SCHEMA, rules: [{ id: 'e', kind: 'escape', refs: ['U1'], metric: 'native_minimum_track_escape', source }] },
    native_inputs: Object.fromEntries([native, ...sidecars].map(file => [file, sha256File(file)])),
  };
  run.services = { verifyManifest: () => JSON.parse(JSON.stringify(review)), verifyEscapeEvidence: () => [] };
  const problem = { board_file: native, units: [{ name: 'U1', refs: ['U1'], x: 10, y: 10, fixed: false, rects: [] }], nets: [], board: { outline: [[0, 0], [20, 0], [20, 20], [0, 20]] } } as unknown as ReviewedProblem;
  return { native, document, manifest, prepared: prepareProblem(folder, 'X', manifest, problem, run.services) };
}

test('a reviewed step is screened under its owner root before routing, and a stale source stops it', async () => {
  const run = driver();
  const { native, document, manifest, prepared } = reviewed(run);
  (run as unknown as { problem: ReviewedProblem }).problem = prepared;
  const escapes: string[][] = [], checks: unknown[][] = [];
  run.generateEscape = (...args) => escapes.push(args);
  run.checkManifest = ((...args: unknown[]) => {
    checks.push(args);
    return { status: 'passed', qualified: false };
  }) as never;
  const candidate = join(folder, 'candidate.kicad_pcb');
  writeFileSync(candidate, 'candidate');
  await run.route(candidate, 0);
  const output = join(folder, 'step-0/engineering-pre-route.json'), receipt = join(folder, 'step-0/engineering-pre-route-escape.json');
  assert.deepEqual(escapes, [[folder, 'X', candidate, receipt]]);
  assert.deepEqual(checks[0]!.slice(0, 3), [folder, 'X', manifest]);
  assert.deepEqual(checks[0]![4], { candidate, escapeEvidence: receipt });
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).status, 'passed');
  assert.equal(native, prepared.board_file);
  writeFileSync(document, 'changed before native screen');
  await assert.rejects(run.route(candidate, 1), /input changed/);
  assert.equal(escapes.length, 1);
});

test('a reviewed step that fails its screen does not route', async () => {
  const run = driver();
  const { prepared } = reviewed(run);
  (run as unknown as { problem: ReviewedProblem }).problem = prepared;
  run.generateEscape = () => undefined;
  run.checkManifest = (() => ({ status: 'blocked', blockers: [{ id: 'e' }], qualified: false })) as never;
  const candidate = join(folder, 'candidate.kicad_pcb');
  writeFileSync(candidate, 'candidate');
  const blocked = await run.route(candidate, 0) as RouteOutcome;
  assert.deepEqual(blocked.counts, [NO_RESULT]);
  assert.equal(blocked.decision.action, 'resolve_placement_requirements');
  assert.equal(run.calls, 0);
});

test('a router that prints no record is an ordinary failed step, and is not routed again', async () => {
  const native = join(folder, 'source.kicad_pcb');
  writeFileSync(native, 'bytes');
  const run = driver(FailingRouter);
  const failed = await run.route(native, 0) as Measured;
  assert.deepEqual(failed.counts, [NO_RESULT]);
  assert.equal((await run.route(native, 1) as RouteOutcome).stop, true);
  assert.equal(run.calls, 1);
});
