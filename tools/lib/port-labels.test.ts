import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { check, type Exemption } from '../port_labels.ts';

type PadRow = [number: string, kind: string, x: number, y: number, net: string | null];
type TextRow = [text: string, x: number, y: number, layer: string];

const padText = ([number, kind, x, y, net]: PadRow) =>
  `\t\t(pad "${number}" ${kind} circle\n\t\t\t(at ${x} ${y})\n\t\t\t(size 1 1)${net ? `\n\t\t\t(net 1 "${net}")` : ''}\n\t\t)\n`;
const userText = ([text, x, y, layer]: TextRow) =>
  `\t\t(fp_text user "${text}"\n\t\t\t(at ${x} ${y})\n\t\t\t(layer "${layer}")\n\t\t)\n`;
const fp = (ref: string, x: number, y: number, rot: number, pads: PadRow[], texts: TextRow[] = []) =>
  `\t(footprint "iot-lab:C1"\n\t\t(layer "F.Cu")\n\t\t(at ${x} ${y} ${rot})\n` +
  `\t\t(property "Reference" "${ref}"\n\t\t\t(at 0 -3 0)\n\t\t\t(layer "F.SilkS")\n\t\t)\n` +
  `${pads.map(padText).join('')}${texts.map(userText).join('')}\t)\n`;
const gr = (text: string, x: number, y: number, layer = 'F.SilkS') =>
  `\t(gr_text "${text}"\n\t\t(at ${x} ${y} 0)\n\t\t(layer "${layer}")\n\t)\n`;
const board = (...items: string[]) => `(kicad_pcb\n${items.join('')})\n`;

const J1_PADS: PadRow[] = [['1', 'thru_hole', 0, 0, 'A'], ['2', 'thru_hole', 2.5, 0, 'B'],
  ['3', 'thru_hole', 5, 0, 'unconnected-(J1-Pad3)'], ['', 'np_thru_hole', 7, 2, null],
  ['MP', 'smd', -3, 2, 'GND'], ['4', 'thru_hole', 5, 2, null]];
const GOOD = board(fp('J1', 10, 10, 0, J1_PADS), gr('A', 10, 8), gr('B', 12.5, 8), gr('24V IN', 12.5, 5.5),
  fp('U1', 40, 40, 0, [['1', 'smd', 0, 0, 'A']]));
const addToBoard = (text: string) => `${GOOD.slice(0, -2)}${text})\n`;

const limits = (dist = 4) => ({ dist, titleDist: 8, silk: new Set(['F.SilkS']) });
const fails = (text: string, exempt: Exemption[] = [], dist = 4) => check(text, limits(dist), exempt).failures;

test('a labelled connector passes', () => {
  const report = check(GOOD, limits());
  assert.deepEqual(report.failures, []);
  assert.deepEqual([report.connectors, report.pads], [1, 2]);   // U1 is no connector; NC/NPTH/MP/no-net pads skipped
});

test('shield net pads are skipped', () => {
  const pads: PadRow[] = [...J1_PADS, ['15', 'thru_hole', 7, 0, 'CHASSIS'], ['16', 'thru_hole', 7, 1, '/SHIELD']];
  assert.equal(check(GOOD.replace(fp('J1', 10, 10, 0, J1_PADS), fp('J1', 10, 10, 0, pads)), limits()).pads, 2);
});

test('a footprint without checked pads needs no title', () => {
  const text = addToBoard(fp('P7', 60, 60, 0, [['', 'np_thru_hole', 0, 0, null]]) +
    fp('J9', 80, 80, 0, [['SH1', 'thru_hole', 0, 0, 'GND'], ['SH2', 'thru_hole', 5, 0, 'GND']]));
  const report = check(text, limits());
  assert.deepEqual([report.connectors, report.failures], [1, []]);
});

test('a missing pin label fails', () => {
  assert.deepEqual(fails(GOOD.replace(gr('B', 12.5, 8), '')), ['FAIL J1 pad 2 (B): no F.SilkS label within 4.0 mm']);
});

test('a label goes to its nearest pad only', () => {
  const text = GOOD.replace(gr('A', 10, 8), '').replace(gr('B', 12.5, 8), gr('AB', 11, 8));
  assert.deepEqual(fails(text), ['FAIL J1 pad 2 (B): no F.SilkS label within 4.0 mm']);
});

test('the distance is configurable', () => {
  const text = GOOD.replace(gr('B', 12.5, 8), gr('B', 12.5, 5)).replace(gr('24V IN', 12.5, 5.5), gr('24V IN', 12.5, 3));
  assert.equal(fails(text).length, 1);
  assert.deepEqual(fails(text, [], 6), []);
});

test('a title is required and a pin label is not a title', () => {
  assert.deepEqual(fails(GOOD.replace(gr('24V IN', 12.5, 5.5), '')), ['FAIL J1: no title text within 8.0 mm']);
});

test('a reference and back silk do not count', () => {
  assert.equal(fails(GOOD.replace(gr('B', 12.5, 8), gr('J1', 12.5, 8) + gr('B', 12.5, 8.1, 'B.SilkS'))).length, 1);
});

test('a reference text far from its part is a label', () => {
  const far = addToBoard(fp('C1', 40, 40, 0, [['1', 'smd', 0, 0, 'X'], ['2', 'smd', 1, 0, 'Y']]));
  assert.deepEqual(fails(far.replace(gr('B', 12.5, 8), gr('C1', 12.5, 8))), []);
  assert.deepEqual(fails(far.replace(gr('B', 12.5, 8), gr('RTD1 C', 12.5, 8))), []);
  const near = addToBoard(fp('C1', 12.5, 10, 0, [['1', 'smd', 3, 3, 'X']]));
  assert.equal(fails(near.replace(gr('B', 12.5, 8), gr('C1', 12.5, 8))).length, 1);
});

test('fp_text user in a rotated footprint counts', () => {
  const pads: PadRow[] = [['1', 'smd', 0, 0, 'A'], ['2', 'smd', 0, 2.5, 'B']];
  const texts: TextRow[] = [['A', -2, 0, 'F.SilkS'], ['B', -2, 2.5, 'F.SilkS'], ['OUT', -5, 1.25, 'F.SilkS']];
  assert.deepEqual(fails(board(fp('J2', 10, 10, 90, pads, texts))), []);
});

test('an exemption with a reason passes and a stale one fails', () => {
  const text = GOOD.replace(gr('B', 12.5, 8), '');
  const exempt = [{ ref: 'J1', pads: ['2'], reason: 'only "1" fits' }];
  assert.deepEqual(fails(text, exempt), []);
  assert.deepEqual(fails(GOOD, exempt), ['STALE exempt J1 pad 2: the pad has a label']);
  assert.throws(() => check(text, limits(), [{ ref: 'J1', pads: ['2'] }]), /without a reason/);
});

test('skip removes a mounting pad before labels are assigned', () => {
  const pads: PadRow[] = [...J1_PADS, ['5', 'smd', 2.5, -6, 'GND']];
  const text = GOOD.replace(fp('J1', 10, 10, 0, J1_PADS), fp('J1', 10, 10, 0, pads));
  assert.deepEqual(fails(text), ['FAIL J1: no title text within 8.0 mm']);
  const exempt = [{ ref: 'J1', skip: ['5'], reason: 'mounting pad' }];
  assert.deepEqual(fails(text, exempt), []);
  assert.deepEqual(fails(GOOD, exempt), ['STALE exempt J1 skip 5: no such pad with a net']);
});

test('exempt all pads and the title', () => {
  const exempt = [{ ref: 'J1', pads: 'all' as const, reason: 'RJ45' }, { ref: 'J1', title: true, reason: 'x' }];
  assert.deepEqual(fails(board(fp('J1', 10, 10, 0, J1_PADS)), exempt), []);
});

test('pad failures sort by reference, then by number with digit runs as numbers', () => {
  const pads: PadRow[] = [['A10', 'smd', 0, 0, 'N1'], ['A9', 'smd', 30, 0, 'N2'], ['A2', 'smd', 60, 0, 'N3']];
  const failures = fails(board(fp('J1', 10, 10, 0, pads), gr('T', 11, 5)));
  assert.deepEqual(failures.map(line => line.split(' ')[3]), ['A2', 'A9', 'A10']);
});

test('the command gives exit 1, then finds the board exemption file and prints JSON', t => {
  const dir = mkdtempSync(join(tmpdir(), 'port-labels-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cad = join(dir, 'boards', 'X', 'cad', 'X');
  mkdirSync(cad, { recursive: true });
  const pcb = join(cad, 'X.kicad_pcb');
  writeFileSync(pcb, GOOD.replace(gr('B', 12.5, 8), ''));
  const tool = new URL('../port_labels.ts', import.meta.url).pathname;
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', tool, ...args], { encoding: 'utf8' });
  const failed = run(pcb);
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /^FAIL J1 pad 2 \(B\).*\nport_labels: 1 connectors, 2 pads, 1 failures\n$/);
  const file = join(dir, 'boards', 'X', 'port-labels.json');
  writeFileSync(file, JSON.stringify({ exempt: [{ ref: 'J1', pads: ['2'], reason: 'r' }] }));
  const passed = run(pcb, '--json');
  assert.equal(passed.status, 0);
  assert.equal(passed.stdout, `{\n  "connectors": 1,\n  "pads": 2,\n  "failures": [],\n  "exempt_file": ${JSON.stringify(file)}\n}\n`);
  assert.equal(run().status, 1);
});
