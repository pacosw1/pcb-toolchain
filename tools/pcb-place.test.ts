import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { reseal } from './lib/cad-seal.ts';
import { approveLayoutPlan } from './lib/layout-plan.ts';
import { footprints } from './lib/native-board.ts';
import { sha256File } from './lib/json-file.ts';
import { admitPlace, placeBoard, placeCandidates, showCandidates } from './pcb-place.ts';
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

test('multiple seeds keep a candidate with rule misses, report its misses, and list legal candidates first', t => {
  const root = project(t, [['U1', 1, 2, 0]]);
  let seed = 0;
  const writes: string[][] = [];
  const report = placeCandidates(root, 'X', { seed: 2, epochs: 1, steps: 1 }, 3, args => {
    if (args[0] === 'run') {
      seed = Number(args[args.indexOf('--seed') + 1]);
      writeFileSync(args[args.indexOf('-o') + 1]!, JSON.stringify({ candidates: [{ components: { hpwl: seed * 10 }, engineering: { blockers: seed === 2 ? [{ id: 'island', miss: 3.95 }, { id: 'tip', miss: 9.9 }] : [] } }] }));
      if (seed === 2) throw new Error('no legal candidate');
    }
    if (args[0] === 'write') {
      writes.push(args);
      const folder = join(args[args.indexOf('--outdir') + 1]!, 'cand0'); mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'X.kicad_pcb'), board([['U1', seed, 2, 0]]));
    }
  });
  assert.deepEqual(report.candidates.map(row => row.seed), [3, 4, 2]);
  assert.deepEqual(report.candidates.map(row => row.legal), [true, true, false]);
  assert.deepEqual(report.candidates.map(row => row.wirelength), [30, 40, 20]);
  assert.deepEqual(report.candidates.map(row => row.misses), [[], [], [{ id: 'island', miss_mm: 3.95 }, { id: 'tip', miss_mm: 9.9 }]]);
  assert.match(report.candidates[0]!.spec, /X-seed3.json$/);
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.gate/place/X-seed2.json'), 'utf8')), { place: { U1: [2, 2, 0] } });
  assert.deepEqual(writes.map(args => args.includes('--keep-misses')), [true, true, true]);
});

test('a candidate reports the search estimates, and null when the placer gave none', t => {
  const root = project(t, [['U1', 1, 2, 0]]);
  const components = { hpwl: 10, cong: 2.5, crossing: 7, via: 1, escape: 0.5 };
  let seed = 0;
  const report = placeCandidates(root, 'X', { seed: 1, epochs: 1, steps: 1 }, 2, args => {
    if (args[0] === 'run') {
      seed = Number(args[args.indexOf('--seed') + 1]);
      writeFileSync(args[args.indexOf('-o') + 1]!, JSON.stringify({ candidates: [seed === 1 ? { components } : {}] }));
    }
    if (args[0] === 'write') {
      const folder = join(args[args.indexOf('--outdir') + 1]!, 'cand0'); mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'X.kicad_pcb'), board([['U1', seed + 5, 2, 0]]));
    }
  });
  assert.deepEqual(report.candidates.map(row => row.estimates), [{ congestion: 2.5, crossings: 7, blocked_vias: 1, escape: 0.5 }, null]);
  const lines: string[] = [], log = console.log;
  console.log = (line: string) => { lines.push(line); };
  try { showCandidates(report, false); } finally { console.log = log; }
  assert.match(lines[0]!, /wirelength  congestion  crossings  blocked_vias  escape  misses/);
  assert.match(lines[1]!, /10  2\.5  7  1  0\.5  -/);
  assert.match(lines[2]!, /-  -  -  -  -  -/);
});

test('a candidate with no legal seed is still reported, and the command result is a failure', t => {
  const root = project(t, [['U1', 1, 2, 0]]);
  const report = placeCandidates(root, 'X', { seed: 1, epochs: 1, steps: 1 }, 2, args => {
    if (args[0] === 'run') {
      writeFileSync(args[args.indexOf('-o') + 1]!, JSON.stringify({ candidates: [{ engineering: { blockers: [{ id: 'too-close', miss: 1.5 }] } }] }));
      throw new Error('failed');
    }
    if (args[0] === 'write') {
      const folder = join(args[args.indexOf('--outdir') + 1]!, 'cand0'); mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'X.kicad_pcb'), board([['U1', 4, 2, 0]]));
    }
  });
  assert.deepEqual(report.candidates.map(row => [row.seed, row.legal]), [[1, false], [2, false]]);
  const lines: string[] = [];
  const log = t.mock.method(console, 'log', (text: string) => { lines.push(text); });
  assert.equal(showCandidates(report, false), 3);
  assert.equal(showCandidates(report, true), 3);
  log.mock.restore();
  assert.match(lines[0]!, /^seed {2}legal .*misses/);
  assert.match(lines[1]!, /^1 {2}no {2}1 .* {2}too-close=1\.5 {2}.*X-seed1\.json$/);
  assert.ok(lines.includes('NO LEGAL CANDIDATE'));
  assert.equal(lines.some(line => line.startsWith('tools/pcb edit')), false, 'no edit command for a candidate with misses');
  assert.equal(JSON.parse(lines.at(-1)!).candidates[0].misses[0].miss_mm, 1.5);
  assert.throws(() => placeCandidates(root, 'X', { seed: 1, epochs: 1, steps: 1 }, 0), /positive integer/);
});

test('a candidate that is illegal with no rule miss is reported by the names of the illegal items', t => {
  const root = project(t, [['U1', 1, 2, 0]]);
  const report = placeCandidates(root, 'X', { seed: 1, epochs: 1, steps: 1 }, 1, args => {
    if (args[0] === 'run') {
      writeFileSync(args[args.indexOf('-o') + 1]!, JSON.stringify({ candidates: [{ illegal: ['U1', 'edge:U1'], engineering: { blockers: [] } }] }));
      throw new Error('failed');
    }
    if (args[0] === 'write') {
      const folder = join(args[args.indexOf('--outdir') + 1]!, 'cand0'); mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'X.kicad_pcb'), board([['U1', 4, 2, 0]]));
    }
  });
  assert.equal(report.candidates[0]!.legal, false);
  assert.deepEqual(report.candidates[0]!.misses, [{ id: 'U1', miss_mm: null }, { id: 'edge:U1', miss_mm: null }]);
});

test('a placer failure with no result is still an error', t => {
  const root = project(t, [['U1', 1, 2, 0]]);
  assert.throws(() => placeCandidates(root, 'X', { seed: 1, epochs: 1, steps: 1 }, 1, args => { if (args[0] === 'run') throw new Error('crashed'); }), /crashed/);
});

test('one seed with a legal result gives the exit code 0 and an edit command', t => {
  const root = project(t, [['U1', 1, 2, 0]]);
  const report = placeCandidates(root, 'X', { seed: 1, epochs: 1, steps: 1 }, 1, args => {
    if (args[0] !== 'write') return;
    const folder = join(args[args.indexOf('--outdir') + 1]!, 'cand0'); mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'X.kicad_pcb'), board([['U1', 4, 2, 0]]));
  });
  const lines: string[] = [];
  const log = t.mock.method(console, 'log', (text: string) => { lines.push(text); });
  assert.equal(showCandidates(report, false), 0);
  log.mock.restore();
  assert.match(lines[1]!, /^1 {2}yes /);
  assert.match(lines[2]!, /^tools\/pcb edit X --kind place /);
});

test('a single placement stays strict: a rule miss is an error and writes no spec', t => {
  const root = project(t, [['U1', 1, 2, 0]]), steps: string[] = [];
  assert.throws(() => placeBoard(root, 'X', { seed: 1, epochs: 1, steps: 1 }, args => {
    steps.push(args[0]!);
    if (args[0] === 'run') {
      writeFileSync(args[args.indexOf('-o') + 1]!, JSON.stringify({ candidates: [{ engineering: { blockers: [{ id: 'too-close', miss: 1.5 }] } }] }));
      throw new Error('failed');
    }
  }), /placement rule misses: too-close/);
  assert.deepEqual(steps, ['read', 'run']);
  assert.equal(existsSync(join(root, '.gate/place/X.json')), false);
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

test('place stops for a board with no approved layout plan, and continues for an approved or an exempt board', async t => {
  const root = project(t, [['U1', 1, 2, 0]]), folder = join(root, 'hardware-design/boards/X'), log = join(root, '.gate/layout-plan/X.jsonl');
  reseal(root, 'X', { tool: 'fixture', run_id: null });
  assert.throws(() => admitPlace(root, 'X'), /X has no layout plan[^]*tools\/pcb layout X --approve/);
  writeFileSync(join(folder, 'SPEC.md'), 'limit');
  writeFileSync(join(folder, 'route.json'), JSON.stringify({ schema: 'iot-lab.route.v1', backend: 'tracemaker', layers: ['F.Cu', 'B.Cu'], stages: [{ name: 'main' }] }));
  writeFileSync(join(folder, 'placement-constraints.json'), JSON.stringify({ schema: 'iot-lab.engineering-constraints.v1', rules: [{ id: 'near', kind: 'part_distance', source: { path: 'hardware-design/boards/X/SPEC.md', sha256: sha256File(join(folder, 'SPEC.md')), page: 1 } }] }));
  writeFileSync(join(folder, 'layout-plan.json'), JSON.stringify({ schema: 'iot-lab.layout-plan.v1', intents: [{ id: 'a', statement: 'U1 near the edge', rule_ids: ['near'] }], route_plan: 'hardware-design/boards/X/route.json', approval: null }));
  reseal(root, 'X', { tool: 'fixture', run_id: null });
  assert.throws(() => admitPlace(root, 'X'), /not approved/);
  await approveLayoutPlan(root, 'X', 'Ana', 'reviewed');
  admitPlace(root, 'X');
  const events = (): Record<string, unknown>[] => readFileSync(log, 'utf8').trim().split('\n').map(row => JSON.parse(row) as Record<string, unknown>).filter(row => row.type === 'layout_plan.exempt');
  assert.equal(events().length, 0, 'an approved board writes no exemption event');
  writeFileSync(join(folder, 'route.json'), JSON.stringify({ schema: 'iot-lab.route.v1', backend: 'tracemaker', layers: ['F.Cu'], stages: [{ name: 'main' }] }));
  assert.throws(() => admitPlace(root, 'X'), /stale/);
  mkdirSync(join(root, 'hardware-design/registry'), { recursive: true });
  writeFileSync(join(root, 'hardware-design/registry/boards.json'), JSON.stringify({ schema_version: 1, boards: [{ id: 'X', layout_plan_exempt: { reason: 'legacy board' } }] }));
  admitPlace(root, 'X');
  assert.equal(events().length, 1);
  assert.deepEqual([events()[0]!.board, events()[0]!.reason], ['X', 'legacy board']);
});
