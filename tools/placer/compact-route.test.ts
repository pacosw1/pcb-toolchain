// The handoff of a routed step: retained copper, feedback that may continue the search, and scoped skipped opens.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { sha256File } from '../lib/json-file.ts';
import { bestLine, NO_RESULT, parseUnrouted, reportedCounts, routeCommand, routeHandoff, type Counts, type Feedback } from './compact-route.ts';

type Row = Record<string, any>;

let folder: string, route: string, candidate: string, decision: Row, feedback: Feedback;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'compact-route-'));
  route = join(folder, 'route-0');
  mkdirSync(route);
  candidate = join(route, 'routed.kicad_pcb');
  writeFileSync(candidate, 'synthetic retained copper');
  writeFileSync(join(route, 'outcome.json'), JSON.stringify({ board_sha256: sha256File(candidate) }));
  const source = join(route, 'pin-escape.json');
  writeFileSync(source, 'synthetic source-bound screen fixture');
  decision = {
    status: 'diagnosed', action: 'inspect_escape', qualified: false, source_board_sha256: 'b'.repeat(64), findings: [{ classification: 'escape_failure' }],
    evidence: join(folder, 'route-decision.json'), artifacts: { 'outcome.json': sha256File(join(route, 'outcome.json')), 'pin-escape.json': sha256File(source) },
  };
  feedback = { accepted: true, source_board_sha256: 'b'.repeat(64), sources: { [source]: sha256File(source) } };
});

afterEach(() => rmSync(folder, { recursive: true, force: true }));

test('the last UNROUTED count counts; no line is a no-result', () => {
  assert.equal(parseUnrouted('FR_RC 0\nUNROUTED 12 SUBSET 3 ERRORS 1\n'), 12);
  assert.equal(parseUnrouted('remote: exit 124\n'), NO_RESULT);
  assert.deepEqual(reportedCounts('UNROUTED 9 GND_OPEN 9 ERRORS 9\nUNROUTED 1 GND_OPEN 2 ERRORS 3\n'), { signal_open: 1, ground_open: 2, errors: 3 });
  assert.equal(reportedCounts('nothing'), null);
});

test('a route job adds ground pad vias only when asked', () => {
  assert.deepEqual(routeCommand('B', false), ['bash', 'tools/placer/fr_job.sh', 'B']);
  assert.deepEqual(routeCommand('B', true), ['env', 'GNDVIAS=1', 'bash', 'tools/placer/fr_job.sh', 'B']);
});

test('only a source-bound positive geometry update can continue', () => {
  const checked = routeHandoff([2], decision, folder, { feedback, priorHints: {}, hints: { U1: 0.5 } });
  assert.equal(checked.stop, false);
  assert.equal((checked.candidate as Row).sha256, sha256File(candidate));
  const before = readFileSync(candidate);
  const cases: [Feedback, Record<string, number>, Record<string, number>][] = [
    [{ ...feedback, accepted: false }, {}, { U1: 0.5 }],
    [{ ...feedback, source_board_sha256: 'c'.repeat(64) }, {}, { U1: 0.5 }],
    [{ ...feedback, sources: {} }, {}, { U1: 0.5 }],
    [feedback, { U1: 0.5 }, { U1: 0.5 }],
  ];
  for (const [given, priorHints, hints] of cases) {
    const stopped = routeHandoff([2], decision, folder, { feedback: given, priorHints, hints });
    assert.equal(stopped.stop, true);
    const next = stopped.decision.next_action as Row;
    assert.equal(next.full_configured_gates_required, true);
    assert.equal(next.qualified, false);
  }
  assert.deepEqual(readFileSync(candidate), before);
});

test('changed retained copper or feedback stops instead of reusing it', () => {
  writeFileSync(candidate, 'changed after native diagnosis');
  const changed = routeHandoff([2], decision, folder, { feedback, priorHints: {}, hints: { U1: 0.5 } });
  assert.equal(changed.stop, true);
  assert.equal(changed.candidate, null);
  assert.equal(changed.decision.action, 'inspect_evidence');
  rmSync(candidate);
  const gone = routeHandoff([0], decision, folder);
  assert.equal(gone.stop, true);
  assert.equal(gone.candidate, null);
});

function skippedFixture() {
  const manifest: Row = { board_sha256: 'b'.repeat(64), configuration: { skip_net: '*GND*', plane_nets: '', gnd_vias: false, route_planes: false } };
  const outcome: Row = { status: 'complete', board_sha256: sha256File(candidate), signal_open: 0, ground_open: 1, errors: 0 };
  const drc: Row = { violations: [], schematic_parity: [], unconnected_items: [{ items: [{ description: 'Pad 1 [GND] of J1' }, { description: 'Zone [GND] on F.Cu' }] }] };
  const scoped: Row = { ...decision, action: 'diagnose_selected_connections', findings: [{ classification: 'native_open' }], artifacts: { ...decision.artifacts } };
  return { manifest, outcome, drc, decision: scoped };
}

function scopedResult({ manifest, outcome, drc, decision: given }: ReturnType<typeof skippedFixture>, reported: Counts = { signal_open: 0, ground_open: 1, errors: 0 }) {
  for (const [name, value] of Object.entries({ 'input-manifest.json': manifest, 'outcome.json': outcome, 'drc.json': drc })) {
    writeFileSync(join(route, name), JSON.stringify(value));
    given.artifacts[name] = sha256File(join(route, name));
  }
  return routeHandoff([0], given, folder, { reportedCounts: reported });
}

test('explicit skipped plane opens keep signal step semantics only', () => {
  for (const config of [{ skip_net: '*GND*' }, { skip_net: '', gnd_vias: true }, { skip_net: '', plane_nets: 'GND' }, { skip_net: '*GND*', plane_nets: 'GND', route_planes: true }]) {
    const fixture = skippedFixture();
    Object.assign(fixture.manifest.configuration, config);
    const result = scopedResult(fixture);
    assert.equal(result.stop, false);
    assert.equal(result.routingStepClean, true);
    const scope = result.decision.routing_step_scope as Row;
    assert.equal(scope.excluded_native_opens, 1);
    assert.deepEqual(scope.nets, ['GND']);
    assert.equal(scope.native_verified, false);
    assert.equal(scope.qualified, false);
    assert.equal(scope.full_configured_gates_required, true);
    assert.deepEqual(JSON.parse(readFileSync(join(route, 'drc.json'), 'utf8')), fixture.drc);
  }
});

test('unconfigured, mixed, unnamed or inconsistent skipped opens do not pass', () => {
  type Fixture = ReturnType<typeof skippedFixture>;
  const item = (d: Fixture) => d.drc.unconnected_items[0].items[1];
  const cases: ((d: Fixture) => void)[] = [
    d => { d.manifest.configuration.skip_net = ''; },
    d => { d.manifest.configuration.route_planes = 'false'; },
    d => { d.outcome.ground_open = 2; },
    d => { d.outcome.signal_open = 1; },
    d => { d.outcome.status = 'stuck'; },
    d => { item(d).description = 'Pad 1 [VCC] of U1'; },
    d => { item(d).description = 'Unnamed zone'; },
    d => { item(d).description = 'Zone [[GND]]'; },
    d => { d.drc.violations.push({ severity: 'error', type: 'clearance' }); },
    d => { d.drc.schematic_parity.push({ type: 'pad_net_conflict' }); },
    d => { d.decision.findings.push({ classification: 'constraints_unknown' }); },
    d => { d.decision.findings.push({ classification: 'escape_failure' }); },
  ];
  for (const change of cases) {
    const fixture = skippedFixture();
    change(fixture);
    const result = scopedResult(fixture);
    assert.equal(result.stop, true);
    assert.equal(result.routingStepClean, false);
    assert.equal('routing_step_scope' in result.decision, false);
  }
  const fixture = skippedFixture();
  assert.equal(scopedResult(fixture, { signal_open: 0, ground_open: 2, errors: 0 }).stop, true);
  delete fixture.decision.artifacts['input-manifest.json'];
  assert.equal(routeHandoff([0], fixture.decision, folder, { reportedCounts: { signal_open: 0, ground_open: 1, errors: 0 } }).stop, true);
});

test('the best line names step, halo, length, vias and reason', () => {
  const line = bestLine({
    best: { board: '/o/step-2/b/NET-CORE.kicad_pcb', s: 0.542, k: 1, unrouted: 0, box_sum: 2407, measure: { length_mm: 1580.3, vias: 296, routed: '/o/step-2/route-0/NET-CORE.kicad_pcb' } },
    best_step: 2, best_reason: 'shortest routed length of 4 measured passing steps',
  });
  assert.match(line, /^BEST board .*?\/step-(\d+)\//);   // tools/design_sweep.py parses this
  for (const part of ['step 2', 's 0.542', 'length 1580.3 mm', 'vias 296', 'shortest routed length']) assert.ok(line.includes(part));
});
