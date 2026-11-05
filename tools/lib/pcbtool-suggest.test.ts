// suggest, corridor, connect and stitch on small boards: SIG pads R1.1 (10, 10), R2.1 (20, 10) and maybe R3.1 (26, 10) on F.Cu of a 30 x 20 mm board.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { COMMANDS } from '../pcbtool.ts';
import { board, box, pad, part, project, track, via, zone } from './board-fixture.ts';
import type { Board, Footprint, RoutedCopper, Zone } from './board-types.ts';
import { budgetCut, CommandFailure } from './pcbtool-cli.ts';
import { corridor } from './pcbtool-corridor.ts';
import { suggest, type SuggestOptions } from './pcbtool-suggest.ts';
import { planConnect, stitchPlan, type StitchOptions } from './pcbtool-write.ts';
import { dist } from './py-math.ts';
import { expandRoute, floatPoint, parseIntent, type Xy } from './route-spec.ts';
import type { Verdict } from './suggest-verify.ts';

const NO_PLANES = '/no/such/reference-planes.json';
const OPTIONS: SuggestOptions = {
  net: 'SIG', layers: 'F.Cu,B.Cu', planes: NO_PLANES, width: null, pads: null, returnViaR: null, probeThermals: false, maxNodes: 250_000, pair: null, box: null,
  viaCost: 8, k: 3, margin: 3, cell: 0.25, verify: false,
};
const sig = (padSize: [number, number] = [1, 1]): Footprint[] => [part('R1', pad('1', 'SIG', 10, 10, ...padSize)), part('R2', pad('1', 'SIG', 20, 10, ...padSize))];
const wall = (y1: number, y2: number): RoutedCopper => track('GND', 15, y1, 15, y2);

interface Run { lines: string[]; text: string; code: number; line: string | undefined }

async function run(b: Board, options: Partial<SuggestOptions> = {}, verdicts = async (lines: string[]): Promise<Verdict[]> => lines.map(() => ({ ok: true, reason: '' }))): Promise<Run> {
  const lines: string[] = [];
  const code = await suggest({ board: b, project, thermals: () => ({}), verdicts }, { ...OPTIONS, ...options }, line => lines.push(line));
  return { lines, text: lines.join('\n'), code, line: lines.find(line => line.startsWith('SIG R1.1 -> R2.1')) };
}

/** The proposed line goes through connect's own clearance check. */
function connects(b: Board, line: string | undefined, planes = NO_PLANES): void {
  assert.ok(line);
  assert.ok('routes' in planConnect(b, project, planes, [parseIntent(line)]), line);
}

const firstScore = ({ text }: Run): string => text.split('1) ')[1]!.split('\n')[0]!;
const ys = (line: string): number[] => line.split(/\s+/).filter(word => word.includes(',')).map(word => Number(word.split(',')[1]));

test('a straight path', async () => {
  const b = board(sig());
  const result = await run(b);
  assert.equal(result.code, 0);
  assert.equal(result.line, 'SIG R1.1 -> R2.1 layer=F.Cu');
  assert.match(result.text, /1\) len 10\.00 vias 0 bends 0/);
  connects(b, result.line);
  assert.ok(result.text.length < 1500);
});

test('a detour round an obstacle', async () => {
  const b = board(sig(), [wall(8, 12)]);
  const result = await run(b, { layers: 'F.Cu' });
  assert.equal(result.code, 0);
  assert.match(result.line!, /through/);
  assert.doesNotMatch(result.line!, /via /);
  assert.match(result.text, /1\) len 1\d\.\d\d vias 0 /);
  connects(b, result.line);
});

test('a wall forces two vias to the other layer', async () => {
  const b = board(sig(), [wall(0, 20)]);
  const result = await run(b);
  assert.equal(result.code, 0);
  assert.equal(result.line!.split(' via ').length - 1, 2);
  assert.match(result.text, /vias 2/);
  connects(b, result.line);
});

test('no path names what blocks it', async () => {
  const result = await run(board(sig(), [wall(0, 20)]), { layers: 'F.Cu' });
  assert.equal(result.code, 1);
  assert.equal(result.line, undefined);
  assert.match(result.text, /no path/);
  assert.match(result.text, /track GND/);
});

test('a ground pour is avoided when a detour is cheap', async () => {
  const b = board(sig(), [], [zone('GND', 13, 9, 17, 20)]);
  const result = await run(b, { layers: 'F.Cu' });
  assert.equal(result.code, 0);
  assert.match(firstScore(result), /pour 0\.0/);
  assert.ok(Math.min(...ys(result.line!)) < 9);
  connects(b, result.line);
});

test('--verify marks what passed and names what did not', async () => {
  const straight = await run(board(sig()), { k: 2, verify: true });
  assert.match(straight.text, /1\) verified len 10\.00 vias 0/);
  const result = await run(board(sig(), [wall(8, 12)]), { layers: 'F.Cu', k: 2, verify: true }, async lines => lines.map((_, i) => ({ ok: i === 0, reason: i === 0 ? '' : '+1 clearance' })));
  assert.equal(result.code, 0);
  assert.match(result.text, /1\) verified len 1\d\.\d\d vias 0/);
  assert.match(result.text, /rejected by DRC: len \d+\.\d\d vias \d+: \+1 clearance/);
});

test('no candidate passing is exit 1', async () => {
  const result = await run(board(sig()), { k: 1, verify: true }, async lines => lines.map(() => ({ ok: false, reason: 'bad' })));
  assert.equal(result.code, 1);
});

test('a narrow channel to a pad is found with an exact end leg', async () => {
  // GND tracks 0.475 mm above and below the pad row, closed at x = 21.5: the SIG track centre needs 0.425 mm, so the channel is open
  // by 0.05 mm. The grid (0.25 mm cell, 0.18 mm inflation) sees it closed.
  const b = board(sig([1, 0.2]), [track('GND', 18.6, 9.525, 21.5, 9.525), track('GND', 18.6, 10.475, 21.5, 10.475), track('GND', 21.5, 9.525, 21.5, 10.475)]);
  const result = await run(b, { layers: 'F.Cu' });
  assert.equal(result.code, 0, result.text);
  connects(b, result.line);
});

test('a via fits a slot narrower than the grid inflation', async () => {
  // F.Cu wall x = 15, B.Cu wall x = 13.65: the left via centre must be in x 14.275 .. 14.375, a 0.1 mm slot.
  const b = board(sig(), [wall(0, 20), track('GND', 13.65, 0, 13.65, 20, 'B.Cu')]);
  const result = await run(b, { cell: 0.1 });
  assert.equal(result.code, 0, result.text);
  connects(b, result.line);
});

test('a pour of another net blocks', async () => {
  const result = await run(board(sig(), [], [zone('VCC', 13, 0, 17, 20)]), { layers: 'F.Cu' });
  assert.equal(result.code, 1);
  assert.match(result.text, /pour VCC/);
});

function planes(t: TestContext, spec: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'suggest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'planes.json');
  writeFileSync(file, JSON.stringify(spec));
  return file;
}
const TWO_GROUNDS = { about: 'test', adjacent: { 'F.Cu': 'In1.Cu' }, plane_layers: [], grounds: ['GND', 'ISO_0V'], domains: { ISO_0V: ['SIG'] } };

test('the pour of the own second ground is a cost, not a block', async (t: TestContext) => {
  const result = await run(board(sig(), [], [zone('ISO_0V', 13, 0, 17, 20)]), { layers: 'F.Cu', planes: planes(t, TWO_GROUNDS) });
  assert.equal(result.code, 0, result.text);
  assert.doesNotMatch(firstScore(result), /pour 0\.0/);
});

test('a ground pour of a foreign domain blocks', async (t: TestContext) => {
  const result = await run(board(sig(), [], [zone('GND', 13, 0, 17, 20)]), { layers: 'F.Cu', planes: planes(t, TWO_GROUNDS) });
  assert.equal(result.code, 1);
  assert.match(result.text, /pour GND/);
});

const spokePad = part('R9', pad('1', 'GND', 15, 11.2));

test('the thermal spokes of a pour pad are kept clear', async () => {
  // Pad at (15, 11.2) in a filled GND pour: its upward spoke reaches y = 10.7 - 0.5 - 0.5 = 9.7 and crosses the straight SIG line at y = 10.
  const b = board([...sig(), spokePad], [], [zone('GND', 13, 0, 17, 20, { fill: [box(13, 0, 17, 20)] })]);
  const result = await run(b, { layers: 'F.Cu' });
  assert.equal(result.code, 0, result.text);
  assert.notEqual(result.line, 'SIG R1.1 -> R2.1 layer=F.Cu');
  assert.ok(Math.min(...ys(result.line!)) < 9.7 - 0.25 - 0.2 - 0.1 + 1e-6, result.line);
  connects(b, result.line);
});

test('--probe-thermals leaves the spokes to the DRC', async () => {
  const b = board([...sig(), spokePad], [], [zone('GND', 13, 0, 17, 20, { fill: [box(13, 0, 17, 20)] })]);
  const result = await run(b, { layers: 'F.Cu', probeThermals: true, k: 1 });
  assert.equal(result.line, 'SIG R1.1 -> R2.1 layer=F.Cu');
  assert.match(result.text, /1\) verified /);
});

test('no spoke where the fill has none', async () => {
  // The outline ends 0.4 mm above the pad, less than the 0.5 mm gap: no copper there, so nothing blocks the line at y = 10.
  const b = board([...sig(), spokePad], [], [zone('GND', 14.2, 10.3, 15.8, 12.5, { fill: [box(14.2, 11.9, 15.8, 12.5)] })]);
  assert.equal((await run(b, { layers: 'F.Cu' })).line, 'SIG R1.1 -> R2.1 layer=F.Cu');
});

test('no spokes for a pad outside its pour', async () => {
  const b = board([...sig(), spokePad], [], [zone('GND', 3, 15, 6, 18)]);
  assert.equal((await run(b, { layers: 'F.Cu' })).line, 'SIG R1.1 -> R2.1 layer=F.Cu');
});

test('the options are checked before any search', async () => {
  const refused = async (b: Board, options: Partial<SuggestOptions>, message: RegExp): Promise<void> => {
    await assert.rejects(run(b, options), error => error instanceof CommandFailure && message.test(error.message));
  };
  const b = board(sig());
  await refused(b, { net: 'NOPE' }, /no net NOPE on the board/);
  await refused(b, { layers: 'F.Cu,In1.Cu' }, /^--layers: In1\.Cu is not a routing layer/);
  await refused(b, { layers: 'F.Cu,F.Cu' }, /^--layers: no layer or a layer twice/);
  await refused(b, { width: 0 }, /--width must be a finite positive number/);
  await refused(b, { pair: 2 }, /--pair 2: the net has 1 pairs/);
  await refused(b, { pads: ['R1.1', 'R2.1'], pair: 1 }, /--pads and --pair are alternatives/);
  await refused(b, { pads: ['R1.1', 'R9.1'] }, /R9\.1 is not a pad of SIG/);
  await refused(b, { box: [0, 0, 12, 12] }, /--box must hold both pads R1\.1 \(10\.0, 10\.0\) and R2\.1 \(20\.0, 10\.0\)/);
  await refused(b, { maxNodes: 0 }, /--max-nodes must be between 1 and 10000000/);
  await refused(b, { returnViaR: -1 }, /--return-via-r must be a finite positive number/);
});

test('a joined net has nothing to do; --pads still routes it', async () => {
  const b = board(sig(), [track('SIG', 10, 10, 20, 10)]);
  assert.equal((await run(b)).text, 'SIG: unconnected: none');
  const named = await run(b, { pads: ['R1.1', 'R2.1'] });
  assert.equal(named.line, 'SIG R1.1 -> R2.1 layer=F.Cu');
});

test('--width goes into the line', async () => {
  assert.equal((await run(board(sig()), { width: 0.3 })).line, 'SIG R1.1 -> R2.1 layer=F.Cu width=0.3');
});

test('--return-via-r keeps a new via near a ground via', async () => {
  const far = await run(board(sig(), [wall(0, 20), via('GND', 3, 3)]), { returnViaR: 1 });
  assert.equal(far.code, 1);
  assert.match(far.text, /no GND return via within 1 mm/);
  const near = await run(board(sig(), [wall(0, 20), via('GND', 13.5, 10), via('GND', 16.5, 10)]), { returnViaR: 1.2 });
  assert.equal(near.code, 0, near.text);
});

const three = (): Footprint[] => [...sig(), part('R3', pad('1', 'SIG', 26, 10))];
const gndWall = track('GND', 15, 5, 15, 15);

function map(b: Board, options: Partial<Parameters<typeof corridor>[3]> = {}): string[] {
  const lines: string[] = [];
  corridor(b, project, null, { net: 'SIG', margin: 1, cell: 0.5, pair: null, box: null, ...options }, line => lines.push(line));
  return lines;
}

test('the corridor lists the pair and maps the block', () => {
  const out = map(board(three(), [gndWall]));
  const text = out.join('\n');
  assert.match(text, /class Default, width 0\.2, clearance 0\.2/);
  assert.match(text, /A R1\.1 \(10\.000, 10\.000\) F\s*-\s*B R2\.1 \(20\.000, 10\.000\) F/);
  const [, front, back] = text.split('map ');
  assert.deepEqual([front!.split(/\s/)[0], back!.split(/\s/)[0]], ['F.Cu', 'B.Cu']);
  const rows = front!.split('\n');
  const row = rows.findIndex(line => line.includes('A') && line.includes('B'));
  assert.match(rows[row]!, /A[.+]*#+[.+]*B/);   // the GND track blocks the straight path on F.Cu
  assert.doesNotMatch(back!.split('\n')[row]!, /[#AB]/);   // B.Cu is free; SMD pads on F.Cu are not marked there
  assert.ok(text.length < 2500);
});

test('--pair maps one pair only', () => {
  assert.match(map(board(three(), [gndWall]), { pair: 2 }).join('\n'), /grid x0=19\.000 y0=9\.000 cell=0\.5 cols=16 rows=4/);
});

test('--box maps only the window, corners in any order, at the cell', () => {
  const text = map(board(three(), [gndWall]), { box: [16, 11, 14, 9] }).join('\n');
  assert.match(text, /grid x0=14\.000 y0=9\.000 cell=0\.5 cols=4 rows=4/);
  assert.doesNotMatch(text, /cell grown/);
});

test('a large box grows the cell and says so', () => {
  assert.match(map(board(three(), [gndWall]), { box: [0, 0, 60, 20] }).join('\n'), /cell grown from 0\.5 to 0\.75/);
});

test('--budget cuts the map and says what', () => {
  const full = map(board(three(), [gndWall]));
  const cut = budgetCut(full, 700, COMMANDS.corridor!.budget!.kind, false);
  assert.ok(cut.join('\n').length + 1 <= 700);
  assert.match(cut.at(-1)!, /^\.\.\. \d+ more map rows(, \d+ maps)?, not shown$/);
  assert.deepEqual(full.slice(0, cut.length - 1), cut.slice(0, -1));
});

test('a joined net is said to be, and a stranger refused', () => {
  assert.deepEqual(map(board(sig(), [track('SIG', 10, 10, 20, 10)])).slice(1), ['unconnected: none']);
  assert.throws(() => map(board(sig()), { pair: 9 }), /--pair 9: the net has 1 pairs/);
  assert.throws(() => map(board(sig()), { net: 'NOPE' }), /no net NOPE on the board/);
});

const plan = (b: Board, line: string) => planConnect(b, project, NO_PLANES, [parseIntent(line)]);

test('a conflict writes nothing and names the copper', () => {
  const result = plan(board(three(), [gndWall]), 'SIG R1.1 -> R2.1');
  assert.ok('conflict' in result);
  assert.match(result.conflict, /to track GND/);
  assert.match(result.conflict, /nothing written/);
  assert.equal(result.conflict.split('\n').length, 1);
});

test('vias under the block give class width and class via', () => {
  const result = plan(board(three(), [gndWall]), 'SIG R1.1 -> R2.1 via 12,10 via 18,10');
  assert.ok('routes' in result);
  const { segments, vias } = expandRoute(result.routes[0]!);
  assert.equal(vias.length, 2);
  assert.deepEqual(segments.map(item => [item.layer, item.width]), [['F.Cu', 0.2], ['B.Cu', 0.2], ['F.Cu', 0.2]]);
  assert.equal(result.routes[0]!.via_size, 0.6);
});

test('a mixed layer in connect follows the kind of the net', (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const planesFile = join(dir, 'p.json');
  const spec = { about: 'x', adjacent: { 'B.Cu': 'In2.Cu' }, plane_layers: ['In2.Cu'], grounds: ['GND'], mixed_layers: { 'In2.Cu': { allow: 'slow', fast_file: 'fast.json', power: ['VCC'], reason: 'r' } } };
  writeFileSync(planesFile, JSON.stringify(spec));
  writeFileSync(join(dir, 'fast.json'), JSON.stringify({ fast: ['FAST'] }));
  const b: Board = { ...board([part('R1', pad('1', 'SIG', 10, 10), pad('2', 'FAST', 10, 12), pad('3', 'VCC', 10, 14)), part('R2', pad('1', 'SIG', 20, 10), pad('2', 'FAST', 20, 12), pad('3', 'VCC', 20, 14))], [], [], ['SIG', 'FAST', 'VCC']), copper_layers: ['F.Cu', 'In2.Cu', 'B.Cu'] };
  const line = (net: string, row: string, y: number): string => `${net} R1.${row} -> R2.${row} via 12,${y}@In2.Cu via 18,${y}@F.Cu`;
  const result = planConnect(b, project, planesFile, [parseIntent(line('SIG', '1', 10))]);
  assert.ok('routes' in result);
  assert.deepEqual(expandRoute(result.routes[0]!).segments.map(item => item.layer), ['F.Cu', 'In2.Cu', 'F.Cu']);
  assert.throws(() => planConnect(b, project, planesFile, [parseIntent(line('FAST', '2', 12))]), /FAST is a fast net: In2\.Cu is for slow nets only/);
  assert.throws(() => planConnect(b, project, planesFile, [parseIntent(line('VCC', '3', 14))]), /VCC is a power net: In2\.Cu is for slow nets only/);
  assert.throws(() => planConnect(b, project, NO_PLANES, [parseIntent(line('SIG', '1', 10))]), /In2\.Cu is not a routing layer/);
});

const STITCH: StitchOptions = { r: 1, bestEffort: false, throughPours: '', via: '', clearance: 0 };

interface Stitched { added: Xy[]; missed: Xy[]; signal: Xy[] }

/** SIG routed with 2 vias under a GND wall, then stitched. `pours`: (net, priority) board-size B.Cu pours. `pads`: 0.6 mm GND SMD pads. */
async function stitched(options: Partial<StitchOptions> = {}, pours: [string, number][] = [], pads: Xy[] = []): Promise<Stitched> {
  const start = board(sig(), [wall(0, 20)]);
  const { line } = await run(start);
  const routed = planConnect(start, project, NO_PLANES, [parseIntent(line!)]);
  assert.ok('routes' in routed);
  const { segments, vias } = expandRoute(routed.routes[0]!);
  const copper = [wall(0, 20), ...segments.map(item => track('SIG', item.a[0], item.a[1], item.b[0], item.b[1], item.layer, item.width)), ...vias.map(([x, y]) => via('SIG', x, y))];
  const zones: Zone[] = pours.map(([net], i) => ({ ...zone(net, 0, 0, 30, 20, { layer: 'B.Cu' }), id: `z${i}` }));
  const priority = (item: Zone): number => pours[Number(item.id.slice(1))]![1];
  const footprints = [...sig(), ...pads.map(([x, y], i) => part(`C${i}`, pad('1', 'GND', x, y, 0.6, 0.6)))];
  const { added, missed } = stitchPlan(board(footprints, copper, zones), project, 'SIG', NO_PLANES, { ...STITCH, ...options }, priority);
  return { added, missed, signal: vias };
}

test('stitch puts a ground via near each signal via', async () => {
  const { added, missed, signal } = await stitched();
  assert.deepEqual([signal.length, added.length, missed.length], [2, 2, 0]);
  for (const q of signal) {
    assert.ok(added.some(g => dist(q, g) <= 1));
    assert.ok(added.every(g => dist(q, g) >= 0.6 + 0.2));   // via size + clearance
  }
});

test('stitch goes into a ground pour over a lower priority pour of another net', async () => {
  assert.equal((await stitched({}, [['VCC', 1], ['GND', 2]])).added.length, 2);
});

test('stitch puts no via in a ground SMD pad', async () => {
  // Without the pad, the GND via for the SIG via at (17.5, 10) goes to (18.24, 10.62).
  const { added, signal } = await stitched({}, [], [[18.35, 10.75]]);
  assert.ok(signal.some(q => floatPoint(q) === '(17.5, 10.0)'), signal.join(' '));
  assert.equal(added.length, 2);
  assert.ok(!added.some(([x, y]) => Math.abs(x - 18.35) < 0.6 && Math.abs(y - 10.75) < 0.6), added.join(' '));
});

test('stitch has no room in a pour of another net', async () => {
  const { added, missed } = await stitched({}, [['VCC', 1]]);
  assert.deepEqual([added.length, missed.length], [0, 2]);
});

test('stitch has no room within a radius under the via size', async () => {
  const { added, missed } = await stitched({ r: 0.5 });
  assert.deepEqual([added.length, missed.length], [0, 2]);
});
