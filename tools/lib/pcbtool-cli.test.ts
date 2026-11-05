import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { UsageError } from './cli.ts';
import { budgetCut, parseCommand, runCommand, type Command, type LineKind } from './pcbtool-cli.ts';
import { footprintPinRating, loadPinRatings, pinRating, type PinRatings } from './pin-ratings.ts';
import { supplyNets, uncoveredSupplies } from './supply-nets.ts';
import type { Board, Footprint, Pad, Pt, RoutedCopper } from './board-types.ts';
import { dropAllowed, holeInPad, StaleAllowance, viaPadHits, viaPadReport } from './via-pads.ts';

const command: Command = {
  positionals: [{ name: 'board' }, { name: 'x', type: 'float' }],
  options: [{ name: 'r', type: 'float', fallback: 0.3 }, { name: 'allow', count: 'any', fallback: [] }, { name: 'box', type: 'float', count: 2 }, { name: 'done', type: 'flag' }, { name: 'max-nodes', type: 'int', fallback: 7 }],
  budget: { kind: () => [null, null], keepLast: false },
  run: () => 0,
};
const parse = (...argv: string[]) => parseCommand(command, argv, 'usage');
const usage = (...argv: string[]): void => assert.throws(() => parse(...argv), UsageError);

test('values, defaults and a dash in a flag name', () => {
  assert.deepEqual(parse('b', '1'), { board: 'b', x: 1, r: 0.3, allow: [], box: null, done: false, max_nodes: 7, budget: null });
  const args = parse('--r', '2', 'b', '1', '--done', '--max-nodes=9', '--box', '1', '2');
  assert.deepEqual([args.r, args.done, args.max_nodes, args.box], [2, true, 9, [1, 2]]);
});

test('a negative number is a value, not a flag', () => {
  assert.equal(parse('b', '-1.5').x, -1.5);
  assert.deepEqual(parse('b', '1', '--box', '-1', '-.5').box, [-1, -0.5]);
});

test('an any-count option stops at the next flag', () => {
  const args = parse('b', '1', '--allow', 'U1.9', 'U2.1', '--done');
  assert.deepEqual(args.allow, ['U1.9', 'U2.1']);
  assert.equal(args.done, true);
});

test('--budget stands alone or takes a number', () => {
  assert.equal(parse('b', '1', '--budget').budget, 2000);
  assert.equal(parse('b', '1', '--budget', '300').budget, 300);
  assert.equal(parse('--budget', '--done', 'b', '1').budget, 2000);
});

test('a bad line is a usage error', () => {
  usage('b');
  usage('b', 'x');
  usage('b', '1', 'extra');
  usage('b', '1', '--nope');
  usage('b', '1', '--box', '1');
  usage('b', '1', '--max-nodes', '1.5');
  usage('b', '1', '--done=1');
});

const LINES = ['head', ...Array.from({ length: 20 }, (_, i) => `LOW N${i % 3} pair ${i} ${'x'.repeat(20)}`), '20 pairs below'];
const kind: LineKind = line => (line.startsWith('LOW') ? ['pairs below current', line.split(' ')[1]!] : [null, null]);

test('output that fits is unchanged', () => {
  assert.deepEqual(budgetCut(LINES, 10 ** 6, kind, true), LINES);
});

test('a cut keeps the head and the last line and names the rest', () => {
  const out = budgetCut(LINES, 200, kind, true);
  assert.ok(out.join('\n').length + 1 <= 200);
  assert.deepEqual([out[0], out.at(-1)], ['head', '20 pairs below']);
  const shown = out.filter(line => line.startsWith('LOW')).length;
  assert.equal(out.at(-2), `... ${20 - shown} more pairs below current, 3 nets, not shown`);
});

test('unknown lines count as lines', () => {
  const out = budgetCut(Array(5).fill('a'.repeat(10)) as string[], 30, () => [null, null]);
  assert.equal(out.at(-1), `... ${5 - out.length + 1} more lines, not shown`);
  assert.ok(out.join('\n').length + 1 <= 30);
});

test('a budget too small for any line still says what was cut', () => {
  assert.deepEqual(budgetCut(LINES, 1, kind, true), ['... 1 more lines, 20 pairs below current, 3 nets, not shown', '20 pairs below']);
});

test('a budgeted command prints what it held even when it fails', async (t: TestContext) => {
  const printed = t.mock.method(console, 'log', () => {});
  const failing: Command = { ...command, run: (_, print) => { print('kept'); throw new Error('stop'); } };
  await assert.rejects(runCommand(failing, { budget: 500 }), /stop/);
  assert.deepEqual(printed.mock.calls.map(call => call.arguments), [['kept']]);
});

const pt = (x: number, y: number): Pt => ({ x: Math.round(x * 1e6), y: Math.round(y * 1e6) });
const smd = (fields: Partial<Pad>): Pad => ({
  id: 'p', number: '9', kind: 'Smd', shape: 'Rect', net: 'GND', position: pt(10, 10), orientation: 0, size: pt(1, 0.6), drill: pt(0, 0), layers: ['F.Cu'],
  bbox: { left: 0, top: 0, right: 0, bottom: 0 }, zone_connection: null, thermal_spoke_angle: 0, spoke_templates: 0, copper: [], polygons: {}, solder_mask_expansion: 0, clearance_override: null, ...fields,
});
const viaAt = (x: number, y: number): RoutedCopper => ({ Via: { id: 'v', at: pt(x, y), size: 0.6e6, drill: 0.3e6, net: 'GND', locked: false, layers: ['F.Cu', 'B.Cu'] } });
const boardWith = (pads: Pad[], copper: RoutedCopper[], layers = 2): Board => ({
  path: 'x', copper_layers: Array(layers).fill('L') as string[], stackup: [], nets: {}, graphics: [], zones: [], texts: [], groups: [], constraints: { min_clearance: 0, min_track_width: 0, min_via_size: 0, copper_edge_clearance: 0 }, outlines: [], edges_bbox: { left: 0, top: 0, right: 0, bottom: 0 }, copper,
  footprints: [{ reference: 'U1', pads } as Footprint],
});

test('a hole inside or touching a pad is a hit', () => {
  const pad = { cx: 10, cy: 10, width: 1, height: 0.6, degrees: 0, corner: 0 };
  assert.ok(holeInPad({ x: 10.2, y: 10.1, r: 0.15 }, pad));
  assert.ok(holeInPad({ x: 10.6, y: 10, r: 0.15 }, pad));
  assert.ok(!holeInPad({ x: 10.7, y: 10, r: 0.15 }, pad));
});

test('rotation and round corners count', () => {
  const long = { cx: 0, cy: 0, width: 2, height: 0.4, degrees: 90, corner: 0 };
  assert.ok(holeInPad({ x: 0, y: 0.9, r: 0.1 }, long));
  assert.ok(!holeInPad({ x: 0.9, y: 0, r: 0.1 }, long));
  assert.ok(!holeInPad({ x: 0.45, y: 0.45, r: 0.1 }, { cx: 0, cy: 0, width: 1, height: 1, degrees: 0, corner: 0.5 }));
  assert.ok(holeInPad({ x: 0.45, y: 0.45, r: 0.1 }, { cx: 0, cy: 0, width: 1, height: 1, degrees: 0, corner: 0 }));
});

test('a round-rect corner comes from the copper of the pad', () => {
  const square = { size: pt(1, 1), position: pt(0, 0) };
  const corner = viaAt(0.48, 0.48);
  assert.equal(viaPadHits(boardWith([smd({ ...square, shape: 'Rect' })], [corner])).length, 1);
  const rounded = smd({ ...square, shape: 'RoundRect', copper: [{ Polygon: [] }, { Segment: { a: pt(0, 0), b: pt(0, 0), width: 1e6 } }] });
  assert.equal(viaPadHits(boardWith([rounded], [corner])).length, 0);
});

test('a pad with no number, or not SMD, is no hit; a custom pad uses its polygon', () => {
  const via = viaAt(10, 10);
  assert.equal(viaPadHits(boardWith([smd({ number: '' })], [via])).length, 0);
  assert.equal(viaPadHits(boardWith([smd({ kind: 'ThroughHole' })], [via])).length, 0);
  const outline = [pt(9, 9), pt(11, 9), pt(11, 11), pt(9, 11)];
  assert.equal(viaPadHits(boardWith([smd({ shape: 'Custom', polygons: { 'F.Cu': { outline, holes: [] } } })], [via])).length, 1);
});

test('allowed pads are removed, and an allowance that matches nothing is an error', () => {
  const hits = ['U1.9 GND via at (1.000, 2.000)', 'R9.1 VBUS via at (3.000, 4.000)'];
  assert.deepEqual(dropAllowed(hits, ['U1.9']), ['R9.1 VBUS via at (3.000, 4.000)']);
  assert.throws(() => dropAllowed(hits, ['U7.5']), StaleAllowance);
});

const viaReport = (board: Board, allow: string[], filled: boolean): { lines: string[]; code: number } => {
  const lines: string[] = [];
  return { code: viaPadReport(board, allow, filled, line => lines.push(line)), lines };
};

test('the viapads report and its exit codes', () => {
  const board = boardWith([smd({})], [viaAt(10, 10)]);
  assert.deepEqual(viaReport(board, [], false), { code: 1, lines: ['FAIL via in pad U1.9 GND via at (10.000, 10.000)', '1 vias in SMD pads'] });
  assert.deepEqual(viaReport(board, ['U1.9'], false), { code: 0, lines: ['0 vias in SMD pads'] });
  assert.deepEqual(viaReport(board, ['U7.5'], false), { code: 2, lines: ['FAIL allowed pad has no via in it: U7.5'] });
  assert.deepEqual(viaReport(board, [], true), { code: 2, lines: ['FAIL --filled needs a 6+ layer board (JLC POFV), board has 2 layers'] });
  assert.deepEqual(viaReport(boardWith([smd({})], [viaAt(10, 10)], 6), [], true), {
    code: 0, lines: ['INFO filled via in pad U1.9 GND via at (10.000, 10.000)', '0 vias in SMD pads (1 filled + capped via-in-pad, fab note POFV)'],
  });
});

const netBlock = (name: string, netClass: string, ...nodes: [string, string][]): string =>
  `\n\t\t(net\n\t\t\t(code "1")\n\t\t\t(name "${name}")\n\t\t\t(class "${netClass}")${nodes.map(([pin, type]) => `\n\t\t\t(node\n\t\t\t\t(ref "U1")\n\t\t\t\t(pin "1")\n\t\t\t\t(pinfunction "${pin}")\n\t\t\t\t(pintype "${type}")\n\t\t\t)`).join('')}\n\t\t)`;
const NETLIST = `(export\n\t(components)\n\t(nets${[
  netBlock('/SIG', 'Default', ['PA1_12', 'unspecified']), netBlock('/A', 'Default', ['X_3', 'power_in']), netBlock('/B', 'POWER_2A6', ['1_1', 'passive']),
  netBlock('/C', 'SELV', ['AVDD_11', 'unspecified']), netBlock('/LDO/LDO_IN', 'SELV', ['IN_1', 'unspecified']), netBlock('/RB_24V_IN', 'SELV', ['1_1', 'unspecified']),
  netBlock('FIELD_GND', 'POWER', ['GND_2', 'power_in']), netBlock('unconnected-(U8-VP-Pad5)', 'Default', ['VP_5', 'unspecified']),
].join('')}\n\t)\n)`;

test('supply nets are found by pin type, class, pin name or net name', () => {
  assert.deepEqual([...supplyNets(NETLIST).keys()].sort(), ['/A', '/B', '/C', '/LDO/LDO_IN', '/RB_24V_IN']);
  assert.equal(supplyNets(NETLIST).get('/A'), 'pin type power_in');
  assert.equal(supplyNets(NETLIST).get('/B'), 'class POWER_2A6');
  assert.equal(supplyNets(NETLIST).get('/C'), 'pin AVDD');
  assert.equal(supplyNets(NETLIST).get('/RB_24V_IN'), 'net name');
});

test('listed and exempt nets are covered, and an exemption needs a reason', () => {
  const uncovered = uncoveredSupplies(supplyNets(NETLIST), new Set(['/A', '/B']), [{ net: '/C', reason: 'sense input only' }]);
  assert.deepEqual(uncovered.map(([net]) => net), ['/LDO/LDO_IN', '/RB_24V_IN']);
  assert.throws(() => uncoveredSupplies(new Map([['/C', 'pin AVDD']]), new Set(), [{ net: '/C', reason: ' ' }]), /has no reason/);
});

const RATED = { name: 'SW', amps: 2.7, source: 'datasheet page 5', statistic: 'min' };

test('pin ratings refuse bad values and a missing identity', (t: TestContext) => {
  const folder = mkdtempSync(join(tmpdir(), 'ratings-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, 'ratings.json');
  const refused = (mpn: unknown, pin: unknown): void => {
    writeFileSync(file, `{"parts": {"SW": {"mpn": ${JSON.stringify(mpn)}, "pins": {"1": ${JSON.stringify(pin)}}}}}`);
    assert.throws(() => loadPinRatings(file), /pin rating needs/);
  };
  for (const amps of [0, -1, true, null]) refused(['TEST'], { ...RATED, amps });
  for (const field of ['name', 'source', 'statistic']) refused(['TEST'], { ...RATED, [field]: undefined });
  refused([], RATED);
  writeFileSync(file, JSON.stringify({ parts: { SW: { mpn: ['TEST'], pins: { 1: RATED } } } }));
  assert.equal(loadPinRatings(file).SW!.pins[1]!.amps, 2.7);
});

test('an ambiguous part identity has no pin allowance', () => {
  const ratings = { A: { mpn: ['TPS61023*'], pins: { 5: { ...RATED } } }, B: { mpn: ['TPS*'], pins: { 5: { ...RATED, amps: 10 } } } } as PinRatings;
  const { amps, source } = pinRating(ratings, 'TPS61023DRLR', '5');
  assert.equal(amps, null);
  assert.match(source, /ambiguous/);
});

test('the ratings file has a source per pin', () => {
  const ratings = loadPinRatings();
  assert.ok('TPS61023' in ratings);
  for (const part of Object.values(ratings)) for (const value of Object.values(part.pins)) assert.match(value.source, /page/);
  assert.equal(pinRating(ratings, 'TPS61023DRLR', '5').amps, 2.7);
  assert.equal(pinRating(ratings, 'TPS61023DRLR', '1').amps, null);
  assert.equal(pinRating(ratings, 'LM5164', '8').amps, null);
  for (const pin of ['3', '4', '5', '6', '7', '8']) assert.equal(pinRating(ratings, 'TPS259251DRCR', pin).amps, 5);
  assert.equal(pinRating(ratings, 'TPS259251DRCR', '9').amps, null);
});

test('a footprint is rated by its value or a part-number field', () => {
  const ratings = { T: { mpn: ['TEST'], pins: { 1: { ...RATED } } } } as PinRatings;
  const footprint = (value: string, fields: [string, string][]): Footprint => ({ value, fields }) as Footprint;
  assert.equal(footprintPinRating(ratings, footprint('TEST', []), '1').amps, 2.7);
  assert.equal(footprintPinRating(ratings, footprint('10uF', [['mpn', 'TEST']]), '1').amps, 2.7);
  assert.equal(footprintPinRating(ratings, footprint('10uF', [['LCSC', 'TEST']]), '1').source, 'no matched part pin rating');
});
