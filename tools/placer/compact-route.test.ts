// What a step that did not pass hands on: the stops, the plane-net scope and the summary line of the chosen step.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { sha256File } from '../lib/json-file.ts';
import { observeRoute } from '../lib/route-decision.ts';
import { Measured, RouteOutcome } from './compact.ts';
import { bestLine, skippedOpenScope, stepOutcome } from './compact-route.ts';

test('the best line names step, halo, length, vias and reason', () => {
  const line = bestLine({
    best: { board: '/o/step-2/b/NET-CORE.kicad_pcb', s: 0.542, k: 1, unrouted: 0, box_sum: 2407, measure: { length_mm: 1580.3, vias: 296, routed: '/o/step-2/route-0/NET-CORE.kicad_pcb' } },
    best_step: 2, best_reason: 'shortest routed length of 4 measured passing steps',
  });
  assert.match(line, /^BEST board .*?\/step-(\d+)\//);   // tools/design_sweep.py parses this
  for (const part of ['step 2', 's 0.542', 'length 1580.3 mm', 'vias 296', 'shortest routed length']) assert.ok(line.includes(part));
});

const open = (net: string) => ({ type: 'unconnected_items', items: [{ description: `Pad 1 [${net}]` }, { description: `Pad 2 [${net}]` }] });

/** The work folder of one `iotroute run` of a step board with these DRC findings. */
function run(t: TestContext, findings: { opens?: string[]; parity?: number; errors?: number }): { source: string; work: string } {
  const work = mkdtempSync(join(tmpdir(), 'compact-route-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const source = join(work, 'in.kicad_pcb'), board = join(work, 'out.kicad_pcb'), model = join(work, 'model.json');
  writeFileSync(source, 'step');
  writeFileSync(board, 'routed');
  writeFileSync(model, JSON.stringify({ nets: { GND: { plane: true }, A: { plane: false } } }));
  const opens = (findings.opens ?? []).map(open), parity = Array.from({ length: findings.parity ?? 0 }, () => ({ type: 'missing_footprint' }));
  const violations = Array.from({ length: findings.errors ?? 0 }, () => ({ type: 'clearance', severity: 'error' }));
  writeFileSync(join(work, 'drc.json'), JSON.stringify({ violations, unconnected_items: opens, schematic_parity: parity }));
  writeFileSync(join(work, 'result.json'), JSON.stringify({
    status: 'FAIL', drc_errors: violations.length, unconnected: opens.length, parity: parity.length, input_sha256: sha256File(source),
    board_file: board, board_sha256: sha256File(board), stages: { model: { sha256: sha256File(model) } },
  }));
  return { source, work };
}

const outcome = (source: string, work: string, counts = [1]) => stepOutcome(new Measured(counts), { ...observeRoute(source, work) }, work);

test('a refused admission and a run with no verdict stop the search; a route with opens goes on bisecting the halo', t => {
  const { source, work } = run(t, { opens: ['A'] });
  assert.ok(outcome(source, work) instanceof Measured);
  writeFileSync(join(work, 'result.json'), JSON.stringify({ status: 'ERROR', cause: 'rule coverage refused: r / connection_width: not modelled' }));
  const refused = outcome(source, work, [10 ** 6]) as RouteOutcome;
  assert.equal(refused.stop, true);
  assert.equal(refused.decision.action, 'resolve_constraint_coverage');
  assert.match(refused.decision.reason as string, /connection_width/);
  writeFileSync(join(work, 'result.json'), JSON.stringify({ status: 'ERROR', cause: 'preflight blocked' }));
  assert.equal((outcome(source, work) as RouteOutcome).decision.action, 'inspect_evidence');
});

test('a netlist that disagrees stops, and evidence of another board is not read as this one', t => {
  const parity = run(t, { parity: 1, opens: ['A'] });
  assert.equal((outcome(parity.source, parity.work) as RouteOutcome).decision.action, 'resolve_schematic_parity');
  const stale = run(t, { opens: ['A'] });
  writeFileSync(stale.source, 'another step');
  const decision = observeRoute(stale.source, stale.work);
  assert.deepEqual([decision.status, decision.action], ['unverified', 'inspect_evidence']);
});

test('only plane-net opens keep a routing step clean, and that is never a qualification', t => {
  const plane = run(t, { opens: ['GND', 'GND'] });
  const clean = outcome(plane.source, plane.work, [2]) as RouteOutcome;
  assert.equal(clean.stop, false);
  assert.equal(clean.routingStepClean, true);
  assert.deepEqual(clean.counts, [0]);
  assert.deepEqual(clean.decision.routing_step_scope, {
    scope: 'plane_nets_only', status: 'routing_step_complete', excluded_native_opens: 2, nets: ['GND'], qualified: false, native_verified: false, full_configured_gates_required: true,
  });
  for (const findings of [{ opens: ['GND', 'A'] }, { opens: ['GND'], errors: 1 }]) {
    const { source, work } = run(t, findings);
    assert.equal(skippedOpenScope({ ...observeRoute(source, work) }, work), null);
  }
  writeFileSync(join(plane.work, 'model.json'), JSON.stringify({ nets: { GND: { plane: true } }, changed: true }));
  assert.equal(skippedOpenScope({ ...observeRoute(plane.source, plane.work) }, plane.work), null);
});
