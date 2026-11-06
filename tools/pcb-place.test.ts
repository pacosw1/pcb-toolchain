import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { footprints } from './lib/native-board.ts';
import { sha256File } from './lib/json-file.ts';
import { placeBoard, placeCandidates } from './pcb-place.ts';
import { placementSpec } from './placer/place-spec.ts';

const board = (rows: [string, number, number, number][]): string => `(kicad_pcb (version 20240108) (generator test)\n${
  rows.map(([ref, x, y, angle]) => `(footprint "X:Y" (layer "F.Cu") (at ${x} ${y} ${angle}) (property "Reference" "${ref}" (at 0 0 0) (layer "F.SilkS")))`).join('\n')}\n)\n`;

function project(t: TestContext, rows: [string, number, number, number][]): string {
  const root = mkdtempSync(join(tmpdir(), 'pcb-place-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'hardware-design/boards/X/cad'), { recursive: true });
  writeFileSync(join(root, 'hardware-design/boards/X/gate.json'), JSON.stringify({ project: 'cad/X', checks: { drc: true } }));
  writeFileSync(join(root, 'hardware-design/boards/X/cad/X.kicad_pcb'), board(rows));
  return root;
}

const file = (t: TestContext, rows: [string, number, number, number][]): string => join(project(t, rows), 'hardware-design/boards/X/cad/X.kicad_pcb');

test('the spec holds only the parts that the placer moved, with absolute poses', t => {
  const before = footprints(file(t, [['U1', 1, 2, 0], ['R1', 3, 4, 90], ['H1', 5, 6, 0]]));
  const after = footprints(file(t, [['U1', 1.5, 2, 0], ['R1', 3, 4, 180], ['H1', 5, 6, 0]]));
  assert.deepEqual(placementSpec(before, after), { place: { R1: [3, 4, 180], U1: [1.5, 2, 0] } });
});

test('a candidate with a part that the board does not have fails', t => {
  const before = footprints(file(t, [['U1', 1, 2, 0]])), after = footprints(file(t, [['U9', 1, 2, 0]]));
  assert.throws(() => placementSpec(before, after), /U9/);
});

test('placeBoard writes the spec and leaves the board unchanged', t => {
  const root = project(t, [['U1', 1, 2, 0]]), native = join(root, 'hardware-design/boards/X/cad/X.kicad_pcb'), start = readFileSync(native, 'utf8');
  const steps: string[] = [];
  const report = placeBoard(root, 'X', { seed: 7, epochs: 2, steps: 100 }, args => {
    steps.push(args[0]!);
    if (args[0] === 'run') assert.deepEqual(args.slice(-6), ['--seed', '7', '--epochs', '2', '--steps', '100']);
    if (args[0] !== 'write') return;
    const folder = join(args[args.indexOf('--outdir') + 1]!, 'cand0');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'X.kicad_pcb'), board([['U1', 9, 8, 90]]));
  });
  assert.deepEqual(steps, ['read', 'run', 'write']);
  assert.equal(readFileSync(native, 'utf8'), start);
  assert.equal(report.spec, join(root, '.gate/place/X.json'));
  assert.deepEqual(JSON.parse(readFileSync(report.spec, 'utf8')), { place: { U1: [9, 8, 90] } });
  assert.equal(report.moved, 1);
  assert.match(report.edit, /^tools\/pcb edit X --kind place --spec .*X\.json --json$/);
});

test('a placer that moves nothing is a failure, and writes no spec', t => {
  const root = project(t, [['U1', 1, 2, 0]]), native = join(root, 'hardware-design/boards/X/cad/X.kicad_pcb');
  assert.throws(() => placeBoard(root, 'X', { seed: 1, epochs: 1, steps: 1 }, args => {
    if (args[0] !== 'write') return;
    const folder = join(args[args.indexOf('--outdir') + 1]!, 'cand0');
    mkdirSync(folder, { recursive: true });
    copyFileSync(native, join(folder, 'X.kicad_pcb'));
  }), /moved no parts/);
  assert.equal(existsSync(join(root, '.gate/place/X.json')), false);
});

test('multiple seeds drop rule misses and retain margins and reported wirelength', t => {
  const root = project(t, [['U1', 1, 2, 0]]);
  let seed = 0;
  const report = placeCandidates(root, 'X', { seed: 2, epochs: 1, steps: 1 }, 3, args => {
    if (args[0] === 'run') {
      seed = Number(args[args.indexOf('--seed') + 1]);
      writeFileSync(args[args.indexOf('-o') + 1]!, JSON.stringify({ candidates: [{ components: { hpwl: seed * 10 }, engineering: { blockers: seed === 3 ? [{ id: 'island' }] : [] } }] }));
      if (seed === 3) throw new Error('no legal candidate');
    }
    if (args[0] === 'write') {
      const folder = join(args[args.indexOf('--outdir') + 1]!, 'cand0'); mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'X.kicad_pcb'), board([['U1', seed, 2, 0]]));
    }
  });
  assert.deepEqual(report.candidates.map(row => row.seed), [2, 4]);
  assert.deepEqual(report.candidates.map(row => row.wirelength), [20, 40]);
  assert.match(report.candidates[0]!.spec, /X-seed2.json$/);
  assert.equal(existsSync(join(root, '.gate/place/X-seed3.json')), false);
});

test('no kept seed names the rule with the most misses', t => {
  const root = project(t, [['U1', 1, 2, 0]]);
  assert.throws(() => placeCandidates(root, 'X', { seed: 1, epochs: 1, steps: 1 }, 2, args => {
    if (args[0] === 'run') {
      writeFileSync(args[args.indexOf('-o') + 1]!, JSON.stringify({ candidates: [{ engineering: { blockers: [{ id: 'too-close' }] } }] }));
      throw new Error('failed');
    }
  }), /rule too-close missed in 2 seeds/);
  assert.throws(() => placeCandidates(root, 'X', { seed: 1, epochs: 1, steps: 1 }, 0), /positive integer/);
});

test('board rules reach the reader and the kept candidate reports its margin', t => {
  const root = project(t, [['U1', 1, 2, 0], ['H1', 5, 2, 0]]);
  const folder = join(root, 'hardware-design/boards/X');
  writeFileSync(join(folder, 'SPEC.md'), 'limit');
  writeFileSync(join(folder, 'placement-constraints.json'), JSON.stringify({ schema: 'iot-lab.engineering-constraints.v1', rules: [{ id: 'near', kind: 'part_distance', source: { path: 'hardware-design/boards/X/SPEC.md', sha256: sha256File(join(folder, 'SPEC.md')), page: 1 }, a: 'U1', b: ['H1'], metric: 'origin_nearest_euclidean', max_mm: 4 }] }));
  const report = placeCandidates(root, 'X', { seed: 1, epochs: 1, steps: 1 }, 1, args => {
    if (args[0] === 'read') assert.ok(args.includes(join(folder, 'placement-constraints.json')));
    if (args[0] === 'write') {
      const out = join(args[args.indexOf('--outdir') + 1]!, 'cand0'); mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'X.kicad_pcb'), board([['U1', 2, 2, 0], ['H1', 5, 2, 0]]));
    }
  });
  assert.equal(report.candidates[0]!.margins.smallest_mm, 1);
  assert.deepEqual(report.candidates[0]!.margins.rules, [{ id: 'near', margin_mm: 1 }]);
});

test('a legal unmoved seed remains a candidate in comparison mode', t => {
  const root = project(t, [['U1', 1, 2, 0]]);
  const report = placeCandidates(root, 'X', { seed: 1, epochs: 1, steps: 1 }, 1, args => {
    if (args[0] !== 'write') return;
    const out = join(args[args.indexOf('--outdir') + 1]!, 'cand0'); mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'X.kicad_pcb'), board([['U1', 1, 2, 0]]));
  });
  assert.equal(report.candidates[0]!.moved, 0);
});
