import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { html, playback } from './viewer.ts';

const sha = 'a'.repeat(64);
const fixture = () => {
  const units = [
    { name: 'A', refs: ['A'], fixed: false, x: 2, y: 2, rects: [[-0.5, -0.5, 0.5, 0.5, 0.5]], box: null },
    { name: 'B', refs: ['B'], fixed: true, x: 8, y: 8, rects: [[-1, -0.5, 1, 0.5, 0.5]], box: null },
  ];
  const problem = { units, nets: [{ name: 'N', pins: [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0]] }],
    board: { outline: [[0, 0], [10, 0], [10, 10], [0, 10]] }, region: { box: [1, 1, 4, 4] } };
  const components = { hpwl: 12, cong: 0, overlap: 0, oob: 0 };
  const steps = [{ s: 2, k: 1.2, cost: 12, unrouted: 0, passed: true, pose: [[3, 3, 0], [8, 8, 0]],
    history: [{ epoch: 1, cost: 20, pose: [[2, 2, 0], [8, 8, 0]], components },
      { epoch: 2, cost: 12, pose: [[3, 3, 1], [8, 8, 0]], components }] }];
  return { problem, steps, verdict: 'fits' };
};

test('uses recorded epoch and step poses, without claiming routed copper or qualification', () => {
  const result = playback(fixture(), sha);
  assert.equal(result.frames.length, 3);
  assert.equal(result.frames[0]!.label, 'step 0 epoch 1');
  assert.deepEqual(result.frames[0]!.outline[0], [-1, -1]);
  assert.deepEqual(result.frames[0]!.segments, [[2, 2, 8, 8]]);
  assert.deepEqual(result.frames[1]!.rects[1]![0], [7, 7.5, 9, 8.5]);
  assert.equal(result.frames[2]!.unrouted, 0);
  assert.deepEqual(result.units[0]!.nets, ['N']);
  assert.match(result.source_scope, /not native DRC/);
  assert.ok(result.unavailable.includes('RUDY heat'));
  assert.ok(result.unavailable.includes('MP4'));
});

test('a timed-out step with no pose makes no invented frame', () => {
  const run = fixture();
  run.steps.push({ s: 1, k: 1, cost: null as unknown as number, unrouted: null as unknown as number, passed: false, pose: null as unknown as number[][], history: [] });
  const result = playback(run, sha);
  assert.equal(result.frames.length, 3);
  assert.equal(result.steps.length, 2);
});

test('malformed or absent geometry is rejected instead of rendered as an empty success', () => {
  for (const change of [
    (run: ReturnType<typeof fixture>) => { run.problem.board.outline = []; },
    (run: ReturnType<typeof fixture>) => { run.problem.board.outline = [[0, 0], [1, 1], [2, 2]]; },
    (run: ReturnType<typeof fixture>) => { run.steps[0]!.history[0]!.pose = [[1, 2, 0]]; },
    (run: ReturnType<typeof fixture>) => { run.problem.nets[0]!.pins[0]![0] = 99; },
  ]) { const run = fixture(); change(run); assert.throws(() => playback(run, sha)); }
});

test('HTML is self-contained and hostile text cannot terminate the embedded JSON', () => {
  const run = fixture(); run.problem.units[0]!.name = '</script><script>alert(1)</script>';
  const data = playback(run, sha), output = html(data, 15);
  assert.ok(!output.includes('src="http'));
  assert.ok(!output.includes('href="http'));
  assert.ok(!output.includes('</script><script>alert(1)'));
  const payload = output.match(/<script type="application\/json" id="payload">(.*?)<\/script>/s)?.[1];
  assert.ok(payload);
  assert.equal(JSON.parse(payload).units[0].name, run.problem.units[0]!.name);
  assert.throws(() => html(data, 0), /finite and positive/);
});

test('CLI writes a self-contained HTML and frame JSON once without changing input', t => {
  const root = mkdtempSync(join(tmpdir(), 'placer-viewer-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, 'run.json'), output = join(root, 'playback.html'), frames = join(root, 'frames.json');
  const source = JSON.stringify(fixture()); writeFileSync(input, source);
  const program = fileURLToPath(new URL('./viewer.ts', import.meta.url));
  const args = ['--experimental-strip-types', '--no-warnings', program, input, output, '--frames-json', frames, '--seconds', '4'];
  const run = () => spawnSync(process.execPath, args, { encoding: 'utf8' });
  const first = run(); assert.equal(first.status, 0, first.stderr); assert.match(first.stdout, /3 recorded frames; HTML playback only/);
  const saved = JSON.parse(readFileSync(frames, 'utf8'));
  assert.equal(saved.source_sha256, createHash('sha256').update(source).digest('hex'));
  assert.equal(saved.duration_s, 4);
  assert.equal(readFileSync(input, 'utf8'), source);
  const before = readFileSync(output, 'utf8');
  assert.notEqual(run().status, 0); assert.equal(readFileSync(output, 'utf8'), before);
  assert.equal(existsSync(join(root, 'run.gif')), false); assert.equal(existsSync(join(root, 'run.mp4')), false);
});
