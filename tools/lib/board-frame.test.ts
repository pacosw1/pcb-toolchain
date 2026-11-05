import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { COLOURS, frame, mp4, OPEN, openLines, render } from './board-frame.ts';
import { encodePng, Canvas, type Rgb } from './raster.ts';
import { loadDsn, loadSes } from './specctra.ts';

const DSN = `(pcb "x.dsn"
  (parser (string_quote ") (space_in_quoted_tokens on))
  (resolution um 10) (unit um)
  (structure (layer F.Cu (type signal)) (layer B.Cu (type signal))
    (boundary (path pcb 0  20000 -10000  0 -10000  0 0  20000 0  20000 -10000)))
  (placement (component "lib:R" (place R1 5000 -5000 front 0) (place R2 15000 -5000 back 90)))
  (library (image "lib:R" (pin Rect_1x2 1 -1000 0) (pin Rect_1x2 2 1000 0))
    (padstack Rect_1x2 (shape (rect F.Cu -500 -1000 500 1000)))
    (padstack "Via[0-1]_600:300_um" (shape (circle F.Cu 600)) (shape (circle B.Cu 600))))
  (network (net N1 (pins R1-1 R2-1)))
  (wiring))
`;
const SES = `(session x
  (base_design x.dsn)
  (placement (resolution um 10) (component "lib:R" (place R1 50000 -50000 front 0)))
  (routes (resolution um 10)
    (network_out (net N1
      (wire (path F.Cu 2000  40000 -50000  100000 -50000))
      (wire (path B.Cu 2000  100000 -50000  140000 -50000))
      (via "Via[0-1]_600:300_um" 100000 -50000)))))
`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'board-frame-'));
  writeFileSync(join(dir, 'board.dsn'), DSN);
  writeFileSync(join(dir, 'board.ses'), SES);
  writeFileSync(join(dir, 'open-triage.json'), JSON.stringify({ connections: [{ a_pos: { x: 4, y: 2 }, b_pos: { x: 16, y: 2 } }] }));
});
afterEach(() => rmSync(dir, { recursive: true }));

function count(canvas: Canvas, colour: Rgb): number {
  let found = 0;
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      if (canvas.colourAt(x, y).every((value, index) => value === colour[index])) found += 1;
    }
  }
  return found;
}

test('the DSN gives the outline, the pads and the box', () => {
  const dsn = loadDsn(join(dir, 'board.dsn'));
  assert.deepEqual(dsn.bbox.map(value => value + 0), [0, 0, 20, 10]);   // + 0: the negated y axis gives -0
  assert.equal(dsn.outline.length, 5);
  assert.equal(dsn.pads.length, 4);
  const byX = (side: string) => dsn.pads.filter(pad => pad.side === side).sort((a, b) => a.x - b.x);
  const [r1] = byX('front');
  assert.deepEqual([r1?.x, r1?.y, r1?.w, r1?.h], [4, 5, 1, 2]);   // R1 pin 1 at x 5 - 1, 1 x 2 mm pad
  const [r2] = byX('back');
  assert.deepEqual([r2?.w, r2?.h], [2, 1]);                       // rotated 90: pad box swapped
});

test('the SES resolution scales wires and vias', () => {
  const ses = loadSes(join(dir, 'board.ses'));
  assert.equal(ses.wires.length, 2);
  assert.deepEqual(ses.wires[0], { layer: 'F.Cu', width: 0.2, points: [[4, 5], [10, 5]] });
  assert.deepEqual(ses.vias, [[10, 5]]);
});

test('a backslash is an ordinary character in a DSN name', () => {
  const path = join(dir, 'slash.dsn');
  writeFileSync(path, DSN.replaceAll('"lib:R"', '"lib\\"'));
  assert.equal(loadDsn(path).pads.length, 4);
});

test('open lines come from the report when there is one, else from the triage', () => {
  assert.deepEqual(openLines(dir), [[4, 2, 16, 2]]);
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ unrouted: [{ from_xy: [1, 2], to_xy: [3, 4] }, { from_xy: [1, 2] }] }));
  assert.deepEqual(openLines(dir), [[1, 2, 3, 4]]);
  writeFileSync(join(dir, 'report.json'), '{}');
  assert.deepEqual(openLines(dir), []);
  writeFileSync(join(dir, 'report.json'), 'not json');
  assert.deepEqual(openLines(dir), [[4, 2, 16, 2]]);
  assert.deepEqual(openLines(join(dir, 'nothing')), []);
});

test('a frame has the open line and the tracks', () => {
  const dsn = loadDsn(join(dir, 'board.dsn'));
  const canvas = render(dsn, loadSes(join(dir, 'board.ses')), openLines(dir), 'test', 400);
  assert.ok(count(canvas, OPEN) > 100);
  assert.ok(count(canvas, COLOURS['F.Cu']!) > 50);
  assert.ok(count(canvas, COLOURS['B.Cu']!) > 50);
});

test('the PNG holds the pixels of the canvas', () => {
  const canvas = new Canvas(3, 2);
  canvas.rectangle([1, 0], [2, 1], OPEN);
  const png = encodePng(canvas);
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [3, 2]);
  const dataLength = png.readUInt32BE(33);
  const rows = inflateSync(png.subarray(41, 41 + dataLength));
  assert.deepEqual([...rows], [0, 0, 0, 0, ...OPEN, ...OPEN, 0, 0, 0, 0, ...OPEN, ...OPEN]);
});

test('frame writes the default path and leaves no temporary file', () => {
  const out = frame(dir, { width: 200 });
  assert.equal(out, `${dir}/frame.png`);
  assert.ok(statSync(out).size > 0);
  assert.deepEqual(readdirSync(dir).filter(name => name.includes('.tmp')), []);
});

const hasFfmpeg = !spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).error;

test('mp4 deletes the frames unless keep', { skip: hasFfmpeg ? false : 'no ffmpeg' }, () => {
  const snapshots = join(dir, 'snapshots');
  mkdirSync(snapshots);
  for (const index of [0, 1, 2]) frame(dir, { out: join(snapshots, `000${index}.png`), stamp: String(index), width: 200 });
  const pngs = () => readdirSync(snapshots).filter(name => name.endsWith('.png'));
  assert.equal(mp4(join(dir, 'nothing')), null);
  assert.ok(mp4(dir, 1, true));
  assert.equal(pngs().length, 3);
  assert.match(readFileSync(join(snapshots, 'frames.txt'), 'utf8'), /duration 0\.3333\n/);
  assert.ok(mp4(dir, 1));
  assert.deepEqual(pngs(), []);
  assert.equal(existsSync(join(snapshots, 'frames.txt')), false);
  assert.ok(statSync(join(dir, 'timelapse.mp4')).size > 0);
});
