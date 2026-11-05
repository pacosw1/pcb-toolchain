import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { bestRouted, blockColour, fps, gridOf, main, renderFrames, rudy } from './movie.ts';
import { playback } from './viewer.ts';

const sha = 'a'.repeat(64);

/** The run of tools/placer/test_viewer.py. */
function run() {
  const unit = (name: string, x: number, fixed: boolean) => ({ name, refs: [name], fixed, x, y: x, rects: [[-0.5, -0.5, 0.5, 0.5, 0.5]], box: null });
  const problem = { units: [unit('A', 2, false), unit('B', 8, true)], nets: [{ name: 'N', weight: 1, pins: [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0]] }],
    board: { outline: [[0, 0], [10, 0], [10, 10], [0, 10]], keepouts: [], edge_clearance: 0 }, region: { box: [1, 1, 4, 4] } };
  const components = { hpwl: 12, cong: 0, overlap: 0, oob: 0 };
  const step = { s: 2, k: 1.2, cost: 12, unrouted: 0, passed: true, pose: [[3, 3, 0], [8, 8, 0]],
    history: [{ epoch: 1, cost: 20, pose: [[2, 2, 0], [8, 8, 0]], components }, { epoch: 2, cost: 12, pose: [[3, 3, 1], [8, 8, 0]], components }] };
  return { problem, steps: [step], verdict: 'fits' };
}

const folder = (t: TestContext): string => {
  const dir = mkdtempSync(join(tmpdir(), 'movie-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('one PNG per viewer frame, in order', t => {
  const dir = folder(t), r = run();
  const paths = renderFrames(r, playback(r, sha), dir);
  assert.deepEqual(paths.map(p => basename(p)), ['f0000.png', 'f0001.png', 'f0002.png']);
  for (const p of paths) assert.deepEqual([...readFileSync(p).subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.notDeepEqual(readFileSync(paths[0]!), readFileSync(paths[2]!));
});

test('a step with no search result adds no frame', t => {
  const dir = folder(t), r = run();
  r.steps.push({ s: 1, k: 1, cost: 0, unrouted: null as unknown as number, passed: false, pose: null as unknown as number[][], history: [] });
  assert.equal(renderFrames(r, playback(r, sha), dir).length, 3);
});

test('the frame rate fits the target length', () => {
  assert.equal(fps(300, 15), 20);
  assert.equal(fps(3, 15), 1);       // never below 1 frame/s
  assert.equal(fps(3000, 15), 30);   // never above 30 frames/s
});

test('the demand of a net spreads over the cells of its box and a cohesion net has none', () => {
  const board = { outline: [[0, 0], [4, 0], [4, 4], [0, 4]] };
  const grid = gridOf(board);
  assert.deepEqual(grid, { x0: 0, y0: 0, nx: 4, ny: 4 });
  const units = [{ pads: [[0.5, 0.5]] }, {}];
  const nets = [{ pins: [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0]] }, { cohesion: true, pins: [[0, -1, -1, 1, 1], [1, -1, -1, 1, 1]] }];
  const g = rudy({ units, nets, board }, [[0.5, 0.5, 0], [2.5, 0.5, 0]], grid, new Float64Array(16));
  assert.deepEqual([...g.slice(0, 4)], [2 / 3, 2 / 3, 2 / 3, 0]);   // a box of 2 mm over 3 cells: floor and ceil of the span
  assert.equal(g[5], 0.5);                                           // the pad at (1, 1): pin demand 0.5
});

test('a turned pad and pin follow the part', () => {
  const board = { outline: [[0, 0], [4, 0], [4, 4], [0, 4]] };
  const g = rudy({ units: [{ pads: [[1, 0]] }], nets: [], board }, [[2.5, 2.5, 1]], gridOf(board), new Float64Array(16));
  assert.equal(g[1 * 4 + 2], 0.5);   // (1, 0) turned to (0, -1)
});

test('a block colour comes from its name and stays in range', () => {
  assert.deepEqual(blockColour('U1'), blockColour('U1'));
  assert.notDeepEqual(blockColour('U1'), blockColour('U2'));
  for (const v of blockColour('U7')) assert.ok(v >= 51 && v <= 204);   // lightness 0.5, saturation 0.6: 0.2 to 0.8
});

test('the best routed board is the one with the fewest unrouted, by its last count', t => {
  const dir = folder(t);
  for (const [k, log] of [[0, 'UNROUTED 9\nUNROUTED 7\n'], [1, 'UNROUTED 3\n'], [2, 'no count\n']] as const) {
    mkdirSync(join(dir, `route-${k}`));
    writeFileSync(join(dir, `route-${k}`, 'b-r.kicad_pcb'), '');
    writeFileSync(join(dir, `route-${k}.log`), log);
  }
  mkdirSync(join(dir, 'other'));
  assert.deepEqual(bestRouted(dir), { unrouted: 3, pcb: join(dir, 'route-1', 'b-r.kicad_pcb') });
});

test('the command writes run.gif and run.mp4', t => {
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).error) { t.skip('no ffmpeg'); return; }
  const dir = folder(t), input = join(dir, 'run.json');
  writeFileSync(input, JSON.stringify(run()));
  const lines: string[] = [], log = console.log;
  console.log = (line: string) => lines.push(line);
  try { assert.equal(main([input, join(dir, 'out'), '--seconds', '3']), 0); } finally { console.log = log; }
  assert.equal(lines[0], `frames 3, ${join(dir, 'out', 'run.gif')}, ${join(dir, 'out', 'run.mp4')}`);
  assert.ok(existsSync(join(dir, 'out', 'run.gif')) && existsSync(join(dir, 'out', 'run.mp4')));
  assert.deepEqual(readdirSync(join(dir, 'out')).filter(n => n.endsWith('.png')).length, 3);
});

test('a bad command line is a usage error', () => {
  assert.throws(() => main(['only-one']), /usage: movie.ts/);
  assert.throws(() => main(['a', 'b', '--seconds', '0']), /usage: movie.ts/);
});
