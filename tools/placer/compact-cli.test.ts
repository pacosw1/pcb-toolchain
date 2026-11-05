// The compaction driver with a fake router: options, the route callback and the stop on immutable input.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { SCHEMA } from '../lib/engineering-constraints.ts';
import { sha256File } from '../lib/json-file.ts';
import type { StageResult } from '../lib/lean-stage.ts';
import { Compaction, main, parseArgs, settle, type Args } from './compact-cli.ts';
import { ImmutableInputFailure, RouteOutcome } from './compact.ts';
import { NO_RESULT } from './compact-route.ts';
import { prepareProblem, type ReviewedProblem } from './engineering-problem.ts';
import type { Row } from './mandatory-proof.ts';

const BASE = ['p.json', 'b.kicad_pcb', '--board-dir', 'x', '--outdir', 'o', '--size', '72', '80'];

let folder: string;

beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'compact-cli-')));
});

afterEach(() => rmSync(folder, { recursive: true, force: true }));

test('the router defaults to fastroute and the size is two numbers', () => {
  assert.equal(parseArgs(BASE).router, 'fastroute');
  assert.equal(parseArgs([...BASE, '--router', 'iotroute']).router, 'iotroute');
  assert.deepEqual(parseArgs(BASE).size, [72, 80]);
  assert.throws(() => parseArgs([...BASE, '--router', 'hand']), /invalid choice/);
  assert.throws(() => parseArgs(['p', 'b', '--board-dir', 'x', '--outdir', 'o', '--size', '1']), /usage/);
});

test('the schedule comes from the command line', () => {
  const given = parseArgs([...BASE, '--tol', '0.2', '--shrink', '0.8']);
  assert.deepEqual([given.tol, given.shrink], [0.2, 0.8]);
  const plain = parseArgs(BASE);
  assert.deepEqual([plain.tol, plain.shrink, plain.routes, plain.length_patience, plain.rank], [0.05, 0.85, 3, 2, null]);
});

test('the iot-lab pipeline arguments parse', () => {
  const a = parseArgs(['p.json', 'b', '--board-dir', 'cad', '--outdir', 'loop', '--size', '100', '100', '--workers', '12', '--budget', '7200', '--target', '0',
    '--passes', '60', '--seeded-policy', '--retain-candidates', '3', '--max-routes', '1', '--diagnostic-budget', '0', '--param', 'p_swap=0', 'p_rot=0', 'w0=3',
    '--route-args', '--layers F.Cu,In2.Cu,B.Cu --plane-nets GND,+3V3']);
  assert.deepEqual(a.param, ['p_swap=0', 'p_rot=0', 'w0=3']);
  assert.equal(a.route_args, '--layers F.Cu,In2.Cu,B.Cu --plane-nets GND,+3V3');
  assert.equal(a.max_routes, 1);
});

test('rank follows the router, and length needs iotroute', () => {
  const iotroute = parseArgs([...BASE, '--router', 'iotroute']);
  settle(iotroute);
  assert.equal(iotroute.rank, 'length');
  const fast = parseArgs(BASE);
  settle(fast);
  assert.equal(fast.rank, 'halo');
  assert.throws(() => settle(parseArgs([...BASE, '--rank', 'length'])), /--rank length needs --router iotroute/);
});

test('bad options stop before anything runs', async () => {
  const cases: [string[], RegExp][] = [
    [['--budget', '0'], /budget must be positive/], [['--retain-candidates', '9'], /retain-candidates/], [['--feedback-max-mm', '3'], /feedback cap/],
    [['--max-displacement', '3'], /requires seeded policy/], [['--repair'], /--repair needs --router iotroute/], [['--length-patience', '-1'], /--length-patience/],
    [['--seeded-policy', '--scatter', '3'], /seeded policy prohibits/], [['--seeded-policy', '--param', 'p_swap=0.3'], /seeded policy prohibits/],
  ];
  for (const [flags, message] of cases) await assert.rejects(main([...BASE, ...flags]), message);
});

test('a seeded policy turns off swaps and turns, and carries the cap', () => {
  const a = parseArgs([...BASE, '--seeded-policy', '--max-displacement', '3']);
  settle(a);
  assert.deepEqual(a.param, ['p_swap=0', 'p_rot=0', 'legal_rotate=0', 'max_displacement=3']);
});

/** The router of this test: a routed copy, its evidence, and 1 open. */
class FakeRouter extends Compaction {
  calls = 0;
  override async stage(command: string[], _stage: string, options: { stdout: 'pipe' | number; stderr: 'pipe' | number }): Promise<StageResult> {
    this.calls += 1;
    const [source, route] = [command[2] as string, command[3] as string];
    rmSync(route, { recursive: true, force: true });
    mkdirSync(route);
    const routed = join(route, 'routed.kicad_pcb');
    writeFileSync(routed, `${readFileSync(source, 'utf8')} retained router copper`);
    const files = {
      'input-manifest.json': { board_sha256: sha256File(source) }, 'outcome.json': { status: 'complete', errors: 0, board_sha256: sha256File(routed) },
      'drc.json': { violations: [], schematic_parity: [], unconnected_items: [{ items: [] }] },
      'pin-escape.json': { boxed_in: [{ ref: 'U1', pad: 'U1.1', net: 'A' }], halo_hint: { U1: 0.5 } },
    };
    for (const [name, value] of Object.entries(files)) writeFileSync(join(route, name), JSON.stringify(value));
    writeSync(options.stdout as number, 'UNROUTED 1 GND_OPEN 0 ERRORS 0\n');
    return { returncode: 3, stdout: null, stderr: null };
  }
}

function driver(rows: Row[] | null = null, Kind: typeof Compaction = FakeRouter): FakeRouter {
  const a: Args = parseArgs(['p', join(folder, 'source.kicad_pcb'), '--board-dir', 'x', '--outdir', folder, '--size', '10', '10', '--optimizer', 'off', '--passes', '1']);
  settle(a);
  const problem = { units: [{ name: 'U1', refs: ['U1'], fixed: false, x: 0, y: 0, rects: [] }], nets: [], board: { outline: [] }, board_file: a.board } as unknown as ReviewedProblem;
  return new Kind(a, problem, Number.MAX_SAFE_INTEGER, rows) as FakeRouter;
}

test('a route continues on changed geometry, and an identical failure is not routed again', async () => {
  const native = join(folder, 'source.kicad_pcb');
  writeFileSync(native, 'synthetic placement bytes A');
  const run = driver();
  const first = await run.route(native, 0) as RouteOutcome;
  assert.equal(first.stop, false);
  assert.deepEqual((first.decision.geometry_feedback as Row).changed_refs, ['U1']);
  const path = (first.candidate as Row).path as string;
  const before = readFileSync(path);
  const unchanged = await run.route(native, 1) as RouteOutcome;
  assert.equal(unchanged.stop, true);
  assert.equal(run.calls, 1);
  assert.deepEqual(unchanged.candidate, first.candidate);
  writeFileSync(native, 'synthetic placement bytes B');
  const changed = await run.route(native, 2) as RouteOutcome;
  assert.equal(changed.stop, false);
  assert.equal(run.calls, 2);
  assert.notEqual((changed.candidate as Row).sha256, (first.candidate as Row).sha256);
  assert.deepEqual(readFileSync(path), before);
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
  override async stage(command: string[]): Promise<StageResult> {
    this.calls += 1;
    mkdirSync(command[3] as string, { recursive: true });
    return { returncode: 1, stdout: null, stderr: null };
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

test('a router failure with no proof is an ordinary failed candidate', async () => {
  const native = join(folder, 'source.kicad_pcb');
  writeFileSync(native, 'bytes');
  const failed = await driver([], FailingRouter).route(native, 0) as RouteOutcome;
  assert.deepEqual(failed.counts, [NO_RESULT]);
  assert.equal(failed.decision.action, 'inspect_evidence');
  assert.ok(readFileSync(join(folder, 'step-0/route-decision.json'), 'utf8').includes('inspect_evidence'));
});

test('a failed receipt on locked input copper stops the run', async () => {
  const native = join(folder, 'source.kicad_pcb');
  writeFileSync(native, 'bytes');
  const policy = join(folder, 'rules.py');
  writeFileSync(policy, 'rules');
  const track = { uuid: 'owned', net: '/N', layer: 'In2.Cu', via: false, kind: 'PCB_TRACK', locked: true, geometry: [[1, 2], [3, 4]], width: 150000 };
  const fault = { uuid: 'owned', net: '/N', layer: 'In2.Cu', source_locked: true, preservation: 'locked or retained by this invocation' };
  const receipt = {
    board_sha256: sha256File(native), qualified: false, faults: [fault], source_records: [track], policy_sources: { [policy]: sha256File(policy) },
    board_identity: { board: 'X', source_project: 'p' }, preserved_pair_profile: null, routed_nets: ['/N'], unlock_nets: '',
  };
  class Stopped extends FailingRouter {
    override async stage(command: string[]): Promise<StageResult> {
      const result = await super.stage(command);
      writeFileSync(join(command[3] as string, 'mandatory-preflight.json'), JSON.stringify(receipt));
      return result;
    }
  }
  const run = driver([track], Stopped);
  run.rowsOf = () => [track];
  await assert.rejects(run.route(native, 0), (error: unknown) => {
    assert.ok(error instanceof ImmutableInputFailure);
    assert.deepEqual(error.receipt.faults, [fault]);
    assert.ok(error.path.endsWith('route-0/mandatory-preflight.json'));
    return true;
  });
  const moved = driver([{ ...track, width: 1 }], Stopped);
  moved.rowsOf = () => [track];
  const ordinary = await moved.route(native, 1) as RouteOutcome;
  assert.deepEqual(ordinary.counts, [NO_RESULT], 'copper that is not the input copper proves nothing');
});
