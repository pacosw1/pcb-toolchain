// The repair loop and its board edits. The proposals are tested in tools/placer/core/tests/repair.rs; here they are a script.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { BoardDocument, RoutedCopper } from '../lib/board-types.ts';
import { Float } from '../lib/py-compat.mjs';
import type { Problem } from './compact-geometry.ts';
import type { Metrics } from './iotroute-step.ts';
import {
  better, copySidecars, failureNets, failurePoints, NO_RESULT, parseFailures, passed, prepare, type Proposal, type ProposeInput, readTie, ripRegion, rippedCopper,
  run, type RunOptions, scoreKey, splitRead, splitWalled, unlockedFootprint, walledPads,
} from './repair.ts';

type Dict = Record<string, unknown>;

const GATE_OK: Metrics = {
  erc_errors: 0, erc_warnings: 3, drc_errors: 0, drc_parity: 0, drc_unconnected: 0, drc_warnings: 9, planes_failures: 0, pairs_failures: 0,
  paths_low: 0, viapads: 0, kicad_happy_findings: 0, port_label_failures: 0,
};

function folder(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), 'repair-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

const padItem = (ref: string, num: string, net: string, x: number, y: number): Dict => ({ description: `Pad ${num} [${net}] of ${ref} on F.Cu`, pos: { x, y } });
const OPEN = [padItem('U1', '2', '/N', 10.5, 10), padItem('C1', '1', '/N', 15.5, 10)];
const THERMAL = [{ description: "Zone 'GND_F' [GND] on F.Cu, priority 0", pos: { x: 100, y: 100 } }, padItem('U1', '1', 'GND', 9.5, 10)];

function drc(unconnected: Dict[][] = [], errors: [string, Dict[]][] = []): Dict {
  return {
    violations: [...errors.map(([type, items]) => ({ severity: 'error', type, items })), { severity: 'warning', type: 'silk_overlap', items: [] }],
    unconnected_items: unconnected.map(items => ({ items })), schematic_parity: [],
  };
}

function boardProblem(): Problem {
  const unit = (name: string, x: number, y: number, fixed = false) => ({ name, refs: [name], fixed, x, y, rects: [] });
  return { units: [unit('U1', 10, 10, true), unit('C1', 16, 10)], nets: [], board: { outline: [] } };
}

test('a report gives located failures; a warning is none and a zone has no location', () => {
  const f = parseFailures(drc([OPEN], [['starved_thermal', THERMAL]]));
  assert.deepEqual(f.map(x => x.kind), ['drc', 'unconnected']);
  const [zone, pad] = f[0]!.items;
  assert.equal(zone!.point, null);
  assert.deepEqual([pad!.ref, pad!.pad, pad!.net, pad!.point], ['U1', '1', 'GND', [9.5, 10]]);
  assert.deepEqual(failureNets(f), ['/N']);
  assert.deepEqual(failurePoints(f), [[9.5, 10], [10.5, 10], [15.5, 10]]);
  assert.deepEqual(parseFailures({ schematic_parity: [{ type: 'extra_footprint', items: [] }] }).map(x => x.kind), ['parity']);
});

test('a track item names its net and no part', () => {
  const [f] = parseFailures({ violations: [{ severity: 'error', items: [{ description: 'Track [/CH_LED0] on F.Cu, length 1.2 mm', pos: { x: 1, y: 2 } }] }] });
  const item = f!.items[0]!;
  assert.deepEqual([item.net, item.ref, item.point], ['/CH_LED0', null, [1, 2]]);
  assert.equal(f!.type, '?');
});

function summary(drcPart = 0, gate: Metrics | null = null, length = 100.0, vias = 10): Dict {
  return { run: { status: drcPart === 0 ? 'PASS' : 'FAIL', drc_errors: 0, unconnected: drcPart, parity: 0, track_length_mm: length, vias }, gate_metrics: gate };
}

test('the key orders DRC, gate, length, vias, strictly', () => {
  const k = scoreKey;
  assert.ok(better(k(summary(1)), k(summary(2))));
  assert.ok(better(k(summary(0)), k(summary(1, null, 1))));   // no gate yet: still better
  assert.ok(better(k(summary(0, GATE_OK)), k(summary(0))));
  assert.ok(better(k(summary(0, GATE_OK, 99)), k(summary(0, GATE_OK, 100))));
  assert.ok(!better(k(summary(1)), k(summary(1))));
  assert.ok(passed(k(summary(0, GATE_OK))));
  assert.ok(!passed(k(summary(0, { ...GATE_OK, planes_failures: 1 }))));
  assert.equal(k({ run: { status: 'ERROR' } })[0], NO_RESULT);
  assert.deepEqual(k({}), [NO_RESULT, NO_RESULT, Infinity, Infinity]);
});

test('a float length of a typed score counts as its number', () => {
  const s = summary(0, GATE_OK);
  (s.run as Dict).track_length_mm = new Float(120.5);
  assert.equal(scoreKey(s)[2], 120.5);
});

test('the tie comes from the read arguments, 3 mm by default', () => {
  assert.equal(readTie([]), 3);
  assert.equal(readTie(['--x', '--decap-tie', '1.5']), 1.5);
  assert.equal(readTie(['--decap-tie=0']), 0);
});

const proposal = (x: number, extra: Partial<Proposal> = {}): Proposal => ({ problem: 'main', unit: 1, name: 'C1', x, y: 10, r: 0, term: -1, term0: 0, dcost: 0, disp: 1, ...extra });

interface Script { outcomes?: [Dict, Dict][]; start?: Dict; notes?: string[]; decapsInProblem?: boolean; loose?: Proposal[]; options?: RunOptions }

/** run() with injected effects: the router answers from a script of outcomes, proposals are C1 moves. */
async function go(t: TestContext, script: Script) {
  const tmp = folder(t);
  const { outcomes = [], start = drc([OPEN]), notes, decapsInProblem = false, loose = [] } = script;
  const calls: string[] = [], extras: string[][] = [], reads: string[][] = [], asked: ProposeInput[] = [], written: { src: string; pose: unknown; out: string }[] = [];
  const fakeFiles = (path: string, report: Dict) => {
    mkdirSync(`${path}.iotroute`, { recursive: true });
    writeFileSync(path, 'board');
    writeFileSync(`${path}.iotroute/drc.json`, JSON.stringify(report));
  };
  const [place, routed] = [join(tmp, 'p', 'X.kicad_pcb'), join(tmp, 'r', 'X.kicad_pcb')];
  mkdirSync(dirname(place));
  writeFileSync(place, 'board');
  fakeFiles(routed, start);
  if (notes) writeFileSync(`${routed}.iotroute/route.json`, JSON.stringify({ notes }));
  const rec = await run('X', place, routed, join(tmp, 'out'), {
    routeFn: (path, d, _board, _gate, _iters, extra = []) => {
      const [s, report] = outcomes[calls.length]!;
      calls.push(path);
      extras.push([...extra]);
      const out = join(d, 'route-0', 'X.kicad_pcb');
      mkdirSync(dirname(out), { recursive: true });
      fakeFiles(out, report);
      return [s, out];
    },
    readFn: (_path, _out, args) => {
      reads.push([...args]);
      return { ...boardProblem(), decaps: decapsInProblem ? [['C1', 'U1', 0.5]] : [] };
    },
    writeFn: (src, _problem, pose, out) => {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, 'board');
      written.push({ src, pose, out });
    },
    ripFn: () => 7,
    proposeFn: input => {
      asked.push(input);
      const moves = [...loose, proposal(14), proposal(15), proposal(13), proposal(12)];
      return { candidates: ['C1'], escape: [proposal(14, { kind: 'escape' })], proposals: moves };
    },
    gate: { run: () => null }, log: () => undefined, startSummary: summary(1), ...script.options,
  });
  return { rec, calls, extras, reads, asked, written, tmp };
}

test('the loop reaches a pass and stops', async t => {
  const { rec, calls } = await go(t, { outcomes: [[summary(1, null, 120), drc([OPEN])], [summary(0, GATE_OK), drc()]] });   // longer: rejected
  assert.equal(rec.passed, true);
  assert.deepEqual(rec.attempts.map(a => a.accepted), [false, true]);
  assert.equal(calls.length, 2);
  assert.match(rec.stop!, /score 0/);
});

test('the previous candidate stays when nothing is better', async t => {
  const worse: [Dict, Dict] = [summary(2), drc([OPEN, OPEN])];
  const { rec, calls } = await go(t, { outcomes: [worse, worse, worse], options: { perRound: 3 } });
  assert.equal(rec.passed, false);
  assert.deepEqual(rec.best!.key, scoreKey(summary(1)));
  assert.equal(rec.best!.routed, rec.start.routed);
  assert.equal(calls.length, 3);
  assert.match(rec.stop!, /no routed proposal is strictly better/);
});

test('reuse routes the moved placement from the present route; local rips a copy of the route', async t => {
  const { rec, calls, extras } = await go(t, { outcomes: [[summary(1, null, 90), drc([OPEN])], [summary(0, GATE_OK), drc()]], options: { perRound: 1 } });
  assert.equal(rec.mode, 'reuse');
  assert.ok(calls.every(c => c.endsWith(join('place', 'X.kicad_pcb'))));
  assert.deepEqual(extras[0], ['--reuse', rec.start.routed, '--reuse-fallback', 'none']);
  assert.deepEqual(extras[1], ['--reuse', rec.attempts[0]!.routed, '--reuse-fallback', 'none']);
  const local = await go(t, { outcomes: [[summary(0, GATE_OK), drc()]], options: { perRound: 1, mode: 'local' } });
  assert.deepEqual(local.extras, [[]]);
  assert.ok(local.calls[0]!.endsWith(join('in', 'X.kicad_pcb')));
  assert.equal(local.rec.attempts[0]!.ripped, 7);
  assert.deepEqual(local.written.map(w => w.src), [local.rec.start.place, local.rec.start.routed]);
});

test('the route cap ends the loop; each strictly shorter route is accepted', async t => {
  const outcomes = [0, 1, 2, 3, 4].map((k): [Dict, Dict] => [summary(1, null, 90 - k), drc([OPEN])]);
  const { rec, calls } = await go(t, { outcomes, options: { maxRoutes: 2, perRound: 1 } });
  assert.equal(calls.length, 2);
  assert.match(rec.stop!, /route cap 2/);
  assert.equal(rec.best!.moves.length, 2);
});

test('a problem with tied decaps asks the loose problem too, and a loose move writes it', async t => {
  const { rec, reads, asked, written } = await go(t, {
    decapsInProblem: true, loose: [proposal(11, { problem: 'loose' })], outcomes: [[summary(0, GATE_OK), drc()]],
    options: { readArgs: ['--via-net', 'GND'], perRound: 1 },
  });
  assert.deepEqual(reads, [['--via-net', 'GND'], ['--via-net', 'GND', '--decap-tie', '0']]);
  assert.equal(asked[0]!.tie, 3);
  assert.ok(asked[0]!.loose?.endsWith('round-0-loose.json'));
  assert.equal(rec.attempts[0]!.move.problem, 'loose');
  assert.deepEqual(written[0]!.pose, [[10, 10, 0], [11, 10, 0]]);
  const none = await go(t, { decapsInProblem: true, outcomes: [[summary(0, GATE_OK), drc()]], options: { decaps: false, perRound: 1 } });
  assert.equal(none.asked[0]!.loose, null);
});

test('rank hot reads the map of the present route and turns the map on for the next ones', async t => {
  const saved = process.env.IOTROUTE_CONGESTION;
  t.after(() => { if (saved === undefined) delete process.env.IOTROUTE_CONGESTION; else process.env.IOTROUTE_CONGESTION = saved; });
  const { rec, asked } = await go(t, { outcomes: [[summary(0, GATE_OK), drc()]], options: { rankMode: 'hot', perRound: 1 } });
  assert.equal(asked[0]!.congestion, `${rec.start.routed}.iotroute/congestion.json`);
  assert.equal(process.env.IOTROUTE_CONGESTION, '1');
});

test('repair.json keeps an infinite key as JSON text Python read', async t => {
  const { tmp } = await go(t, { outcomes: [[{ run: { status: 'ERROR' } }, drc([OPEN])]], options: { perRound: 1 } });
  const text = readFileSync(join(tmp, 'out', 'repair.json'), 'utf8');
  assert.match(text, /Infinity/);
  assert.doesNotMatch(text, /\binf\b/);
});

const WALL_NOTE = 'pour: U1.1 on F.Cu: 1 spoke(s) reach a connected pour piece, 0 reach an island (KiCad starved_thermal); fixed copper alone walls it in (input)';

test('a walled pad of a fixed unit is an input fault', () => {
  const walled = walledPads([WALL_NOTE, 'VDD: neck 0.2 mm']);
  assert.equal(walled.size, 1);
  const pr = boardProblem();
  const f = parseFailures(drc([OPEN], [['starved_thermal', THERMAL]]));
  const [keep, faults] = splitWalled(f, walled, pr);
  assert.deepEqual(keep.map(x => x.kind), ['unconnected']);
  assert.deepEqual(faults.map(x => x.type), ['starved_thermal']);
  pr.units[0]!.fixed = false;   // a movable pad unit is not an input fault
  assert.equal(splitWalled(f, walled, pr)[1].length, 0);
});

test('only walled failures stop the loop without a route', async t => {
  const { rec, calls } = await go(t, { start: drc([], [['starved_thermal', THERMAL]]), notes: [WALL_NOTE] });
  assert.deepEqual(calls, []);
  assert.match(rec.stop!, /walled in by fixed input copper/);
  assert.match(rec.stop!, /U1\.1/);
});

const track = (id: string, net: string, a: [number, number], b: [number, number], locked = false): RoutedCopper =>
  ({ Track: { id, start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, mid: null, width: 200_000, layer: 'F.Cu', net, locked } });
const via = (id: string, net: string, at: [number, number], locked = false): RoutedCopper =>
  ({ Via: { id, at: { x: at[0], y: at[1] }, size: 600_000, drill: 300_000, net, locked, layers: ['F.Cu', 'B.Cu'] } });

const MM = 1_000_000;
const COPPER = [
  track('a1', '/A', [0, 0], [MM, 0]), track('a2', '/A', [MM, 0], [10 * MM, 0]), via('a3', '/A', [10 * MM, 0]),   // one cluster
  track('b1', '/B', [MM, 0], [MM, 5 * MM]),   // same point, another net
  track('c1', '/C', [20 * MM, 0], [21 * MM, 0]), track('c2', '/C', [21 * MM, 0], [22 * MM, 0], true),   // locked copper stays and joins nothing
  track('d1', '/D', [40 * MM, 0], [41 * MM, 0]),
];

test('a rip takes whole unlocked clusters near a point or on a net', () => {
  assert.deepEqual(rippedCopper(COPPER, [[0, 0]], 0.5, new Set()), ['a1', 'a2', 'a3']);
  assert.deepEqual(rippedCopper(COPPER, [[21, 0]], 0.5, new Set()), ['c1']);
  assert.deepEqual(rippedCopper(COPPER, [[22, 0]], 0.5, new Set()), []);
  assert.deepEqual(rippedCopper(COPPER, [], 1, new Set(['/D'])), ['d1']);
  assert.deepEqual(rippedCopper(COPPER, [[1, 6]], 1, new Set()), ['b1']);   // the end at the edge of the radius counts
});

const BOARD = `(kicad_pcb
\t(footprint "Lib:Part(1)"
\t\t(locked yes)
\t\t(layer "F.Cu")
\t\t(uuid "fp-1")
\t\t(pad "1" smd rect
\t\t\t(locked yes)
\t\t\t(uuid "pad-1")
\t\t)
\t)
\t(footprint "Lib:Other"
\t\t(layer "F.Cu")
\t\t(uuid "fp-2")
\t)
\t(segment
\t\t(start 0 0)
\t\t(end 1 0)
\t\t(locked yes)
\t\t(net "/A")
\t\t(uuid "s-1")
\t)
\t(segment
\t\t(start 1 0)
\t\t(end 2 0)
\t\t(net "/A")
\t\t(uuid "s-2")
\t)
)
`;

const document = (copper: RoutedCopper[]): BoardDocument => ({ board: { copper } }) as unknown as BoardDocument;

test('a footprint loses its own lock; a pad, a name and a text keep theirs', () => {
  const form = '(footprint "a (locked yes) b"\n\t\t(locked yes)\n\t\t(layer "F.Cu")\n\t\t(pad "1" smd rect\n\t\t\t(locked yes)\n\t\t)\n\t)';
  assert.equal(unlockedFootprint(form), '(footprint "a (locked yes) b"\n\t\t(layer "F.Cu")\n\t\t(pad "1" smd rect\n\t\t\t(locked yes)\n\t\t)\n\t)');
  assert.equal(unlockedFootprint('(footprint "b"\n\t\t(layer "F.Cu")\n\t)'), '(footprint "b"\n\t\t(layer "F.Cu")\n\t)');
});

test('a rip removes the items by uuid and saves once; nothing to rip saves nothing', t => {
  const pcb = join(folder(t), 'X.kicad_pcb');
  writeFileSync(pcb, BOARD);
  const saves: string[] = [];
  const save = ((_pcb: string, text: string) => { saves.push(text); return {}; }) as unknown as typeof import('../lib/board-edit.ts').saveBoardInPlace;
  const copper = [track('s-1', '/A', [0, 0], [MM, 0], true), track('s-2', '/A', [MM, 0], [2 * MM, 0])];
  assert.equal(ripRegion(pcb, [[2, 0]], 0.5, new Set(), () => document(copper), save), 1);
  assert.equal(saves.length, 1);
  assert.ok(!saves[0]!.includes('"s-2"') && saves[0]!.includes('"s-1"'));
  assert.equal(ripRegion(pcb, [[50, 0]], 0.5, new Set(), () => document(copper), save), 0);
  assert.equal(saves.length, 1);
});

function prepared(t: TestContext, keep: 'lock-nets' | 'locked') {
  const tmp = folder(t);
  const [src, out] = [join(tmp, 'src', 'X.kicad_pcb'), join(tmp, 'out', 'X.kicad_pcb')];
  mkdirSync(dirname(src));
  writeFileSync(src, BOARD);
  const stripped = BOARD.slice(0, BOARD.indexOf('\t(segment')) + ')\n';
  const saves: string[] = [];
  const order: string[] = [];
  const held = [track('s-1', '/A', [0, 0], [MM, 0], true), track('s-2', '/A', [MM, 0], [2 * MM, 0]), via('v-1', '/LOCK', [0, 0], true)];
  const info = prepare(src, out, 'X', keep, {
    lockInput: (_board, _src, path) => { writeFileSync(path, stripped); return { removed: 2, kept: 0, nets: ['/LOCK'] }; },
    read: () => document(held),
    save: (_path, text) => { saves.push(text); order.push('save'); },
    sidecars: () => order.push('sidecars'),
  });
  return { info, saves, order };
}

test('prepare unlocks the footprints and saves after the project is in place', t => {
  const { info, saves, order } = prepared(t, 'lock-nets');
  assert.equal(info.kept_locked, undefined);
  assert.deepEqual(order, ['sidecars', 'save']);
  assert.equal(saves[0]!.match(/\(locked yes\)/g)?.length, 1);   // the pad's
  assert.ok(!saves[0]!.includes('segment'));
});

test('prepare --keep locked adds the locked copper off the lock nets', t => {
  const { info, saves } = prepared(t, 'locked');
  assert.equal(info.kept_locked, 1);
  assert.ok(saves[0]!.includes('"s-1"') && !saves[0]!.includes('"s-2"'));
  assert.ok(saves[0]!.trimEnd().endsWith(')'));
});

test('prepare refuses an unknown keep', () => {
  assert.throws(() => prepare('a', 'b', 'X', 'all' as 'locked'), /keep must be/);
});

test('sidecars follow the board name, and the sub-sheets of a schematic come along', t => {
  const tmp = folder(t);
  const [src, dst] = [join(tmp, 'a', 'A.kicad_pcb'), join(tmp, 'b', 'B.kicad_pcb')];
  mkdirSync(join(tmp, 'a', 'blocks'), { recursive: true });
  mkdirSync(dirname(dst));
  for (const name of ['A.kicad_pro', 'A.kicad_sch', 'fp-lib-table', 'blocks/S.kicad_sch']) writeFileSync(join(tmp, 'a', name), name);
  copySidecars(src, dst, (root, base) => {
    assert.equal(root, join(tmp, 'a', 'A.kicad_sch'));
    assert.equal(base, join(tmp, 'a'));
    return ['blocks/S.kicad_sch'];
  });
  assert.equal(readFileSync(join(tmp, 'b', 'B.kicad_pro'), 'utf8'), 'A.kicad_pro');
  assert.ok(existsSync(join(tmp, 'b', 'fp-lib-table')) && !existsSync(join(tmp, 'b', 'B.kicad_dru')));
  assert.equal(readFileSync(join(tmp, 'b', 'blocks/S.kicad_sch'), 'utf8'), 'blocks/S.kicad_sch');
});

test('--read takes the words to the next flag or its = value', () => {
  assert.deepEqual(splitRead(['run', '--read', 'a', 'b', '--mode', 'full']), { rest: ['run', '--mode', 'full'], read: ['a', 'b'] });
  assert.deepEqual(splitRead(['--read=--via-net=GND', 'x']), { rest: ['x'], read: ['--via-net=GND'] });
  assert.deepEqual(splitRead(['--read=a', '--read=b']).read, ['b']);
});
