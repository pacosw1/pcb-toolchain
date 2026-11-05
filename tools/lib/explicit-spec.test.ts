import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validatePlaceSpec, validateRouteFile } from './explicit-spec.ts';
import { candidateFields } from './pcb-candidate-admission.ts';
import { runOperation } from './pcb-candidate-run.ts';
import { place, route } from './pcbtool-write.ts';
import { placements } from './route-spec.ts';

const track = { net: 'N', layer: 'F.Cu', width: 0.2, path: [[0, 0], [1, 0]] };
const badPlaces = [
  { plcae: { U1: [10, 20, 90] } },
  { place: { U1: [10, 20, 90] }, movement: {} },
  { grids: [{ refs: ['U1'], origin: [0, 0], pitch: [1, 1], rott: 90 }] },
];
const badRoutes = [
  { routes: [], unexpected_policy: {} },
  { routes: [{ ...track, any_angel: true }] },
  { routes: [{ ...track, path: [[0, 0], { via: [1, 0], too: 'B.Cu' }] }] },
  { routes: [], move_vias: [{ net: 'N', from: [0, 0], to: [1, 1], layer: 'F.Cu' }] },
  { routes: [], via: { size: 0.6, drill: 0.3, layers: ['F.Cu'] } },
];

test('explicit specs reject unknown fields at every structured level', () => {
  for (const value of badPlaces) {
    assert.throws(() => validatePlaceSpec(value), /unknown fields/);
    assert.throws(() => placements(value as never), /unknown fields/);
  }
  for (const value of badRoutes) assert.throws(() => validateRouteFile(value), /unknown fields/);
});

test('explicit JSON rejects malformed values rather than coercing them during native editing', () => {
  for (const value of [null, [], { place: null }, { place: { U1: [1, 2] } }, { place: { U1: [1, 2, Infinity] } },
    { grids: [{ refs: ['U1'], origin: [0, 0], pitch: [1, 1], cols: 0 }] }]) assert.throws(() => validatePlaceSpec(value));
  for (const value of [{}, { routes: null }, { routes: [{ ...track, width: '0.2' }] }, { routes: [{ ...track, any_angle: 'false' }] },
    { routes: [], clear: 'N' }, { routes: [], via: { size: 0.6 } }]) assert.throws(() => validateRouteFile(value));
  validatePlaceSpec({ place: { U1: [1, 2, 90] }, grids: [{ refs: ['R1'], origin: [3, 4], pitch: [1, 0], cols: 1, rot: 0 }] });
  validateRouteFile({ clear: ['N'], routes: [track], move_vias: [{ net: 'N', from: [0, 0], to: [1, 1] }], via: { size: 0.6, drill: 0.3 } });
});

test('direct pcbtool and supervisor admission reject before touching a board or starting a native job', async t => {
  const root = mkdtempSync(join(tmpdir(), 'explicit-admission-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const spec = join(root, 'spec.json'), missingBoard = join(root, 'missing.kicad_pcb');
  for (const [kind, bad, command] of [['place', badPlaces, place], ['route', badRoutes, route]] as const) {
    for (const value of bad) {
      writeFileSync(spec, JSON.stringify(value));
      assert.throws(() => command(missingBoard, spec), /unknown fields/);
      assert.throws(() => candidateFields(root, 'edit', 'X', { kind, spec }), /unknown fields/);
      if (kind === 'route') assert.throws(() => candidateFields(root, 'route', 'X', { spec }), /unknown fields/);
      // Even a malformed run manifest cannot reach the deliberately missing design contract/native board.
      writeFileSync(join(root, 'run.json'), JSON.stringify({ root, board: 'X', operation: 'edit', kind, spec: value,
        design_contract: { path: join(root, 'missing-contract.json'), sha256: 'bad' } }));
      await assert.rejects(runOperation(root), /unknown fields/);
      assert.equal(existsSync(join(root, 'workspace')), false);
    }
  }
});
