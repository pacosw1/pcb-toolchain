import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Footprint, Pad } from './board-types.ts';
import { easyedaPads, easyedaPins, footprintPads, frameVerdict, pinVerdict, schematicParts, type EasyedaPart, type PadPlaces, type PinNames } from './easyeda-audit.ts';

const places = (entries: Record<string, [number, number][]>): PadPlaces => new Map(Object.entries(entries));
const pins = (entries: Record<string, string>): PinNames => new Map(Object.entries(entries));
const TWO = places({ 1: [[-1, 0]], 2: [[1, 0]] });

test('EasyEDA pads are in mm about the footprint origin, in tens of mil', () => {
  const pad = (x: number, y: number, n: string): string => `PAD~RECT~${x}~${y}~1~1~1~~${n}`;
  const part = { dataStr: {}, packageDetail: { dataStr: { head: { x: '100', y: 200 }, shape: [pad(110, 200, '1'), pad(90, 195, '1'), 'TRACK~x', pad(100, 210, '2')] } } } as EasyedaPart;
  const pads = easyedaPads(part);
  assert.equal(pads.get('1')!.length, 2);
  assert.ok(Math.abs(pads.get('1')![0]![0] - 2.54) < 1e-9);
  assert.ok(Math.abs(pads.get('2')![0]![1] - 2.54) < 1e-9);
});

test('a pin number comes from the number segment, else the spice number, over all sub-parts', () => {
  const pin = (spice: string, name: string, number: string): string => `P~show~0~${spice}~0~0~0~id^^dot^^path^^1~2~3~4~${name}^^1~2~3~4~${number}^^x`;
  const part = { dataStr: { shape: [pin('43', 'VCC', '4'), 'T~x'] }, subparts: [{ dataStr: { shape: [pin('7', 'GND', '')] } }, {}], packageDetail: { dataStr: { head: { x: 0, y: 0 }, shape: [] } } } as EasyedaPart;
  assert.deepEqual([...easyedaPins(part)], [['4', 'VCC'], ['7', 'GND']]);
});

test('board pads return to the frame at rotation 0, numbered ones only', () => {
  const pad = (number: string, x: number, y: number): Pad => ({ number, position: { x, y } }) as Pad;
  const footprint = { position: { x: 10_000_000, y: 20_000_000 }, orientation: 90, pads: [pad('1', 10_000_000, 19_000_000), pad('', 0, 0)] } as Footprint;
  assert.deepEqual([...footprintPads(footprint)], [['1', [[1, 0]]]]);
});

test('frame verdicts', () => {
  assert.deepEqual(frameVerdict(null, TWO), { status: 'NO_SOURCE', note: '' });
  assert.deepEqual(frameVerdict(new Map(), TWO), { status: 'NO_SOURCE', note: '' });
  assert.deepEqual(frameVerdict(TWO, TWO), { status: 'FRAME_OK', note: 'max 0.000 mm' });
  assert.deepEqual(frameVerdict(TWO, places({ 1: [[-1.04, 0]], 2: [[1, 0]] })), { status: 'FRAME_OK', note: 'max 0.040 mm' });
  assert.deepEqual(frameVerdict(TWO, places({ 1: [[1, 0]], 2: [[-1, 0]] })), { status: 'ROTATED', note: '180 deg (max 0.000 mm)' });
  assert.deepEqual(frameVerdict(TWO, places({ 1: [[-0.5, 0.25]], 2: [[1.5, 0.25]] })), { status: 'OFFSET', note: 'rot 0, origin moved by (0.500, 0.250) mm' });
});

test('other pad numbers are NUMBERING, listed as Python lists', () => {
  assert.deepEqual(frameVerdict(TWO, places({ 1: [[0, 0]], 3: [[1, 0]] })), { status: 'NUMBERING', note: "pad numbers board ['1', '3'] EasyEDA ['1', '2']" });
});

test('pads that fit no rotation report the best one', () => {
  const verdict = frameVerdict(TWO, places({ 1: [[-1, 0]], 2: [[3, 0]] }));
  assert.equal(verdict.status, 'NUMBERING');
  assert.match(verdict.note, /^pads do not line up: best rot \d+ max \d+\.\d{3} mm$/);
});

test('extra board pads of a number are thermal vias', () => {
  const board = places({ 1: [[-1, 0], [0, 3]], 2: [[1, 0]] });
  assert.deepEqual(frameVerdict(TWO, board), { status: 'FRAME_OK', note: "max 0.000 mm; extra board pads (thermal vias) {'1': 1}" });
});

test('fewer board pads than EasyEDA pads fit no rotation', () => {
  const easyeda = places({ 1: [[-1, 0], [0, 3]], 2: [[1, 0]] });
  assert.equal(frameVerdict(easyeda, TWO).note, 'pads do not line up: best rot 0 max 99.000 mm');
});

test('pin verdicts', () => {
  assert.deepEqual(pinVerdict(new Map(), pins({ 1: 'A' })), { status: 'PINS_SKIP', note: 'no pin list' });
  assert.deepEqual(pinVerdict(pins({ 1: '~', 2: '~' }), pins({ 1: 'A', 2: 'K' })), { status: 'PINS_SKIP', note: 'two-pin part without pin names' });
  assert.deepEqual(pinVerdict(pins({ 1: 'V_CC', 2: 'gnd', 3: 'X' }), pins({ 1: 'VCC', 2: 'GND', 3: 'X' })), { status: 'PINS_OK', note: '' });
});

test('K and A swapped is a NAME_SWAP', () => {
  assert.deepEqual(pinVerdict(pins({ 1: 'K', 2: 'A' }), pins({ 1: 'A', 2: 'K' })), { status: 'NAME_SWAP', note: 'K/A swapped: board K=pin 1, EasyEDA K=pin 2' });
});

test('other names are NAME_DIFF, by length then text, with a missing pin as None', () => {
  assert.deepEqual(pinVerdict(pins({ 10: 'A', 2: 'B', 3: 'C' }), pins({ 10: 'X', 2: 'B' })),
    { status: 'NAME_DIFF', note: 'pin 3: board "C" EasyEDA "None"; pin 10: board "A" EasyEDA "X"' });
  const many = pinVerdict(new Map([...Array(10).keys()].map(i => [String(i), `A${i}`])), new Map([...Array(10).keys()].map(i => [String(i), `B${i}`])));
  assert.match(many.note, / \(\+2\)$/);
});

test('the netlist gives each reference its symbol and pins', () => {
  const netlist = `(export (version "E")
    (components (comp (ref "U1") (value "x") (libsource (lib "L") (part "P") (description "d"))) (comp (ref "J1") (libsource (lib "L") (part "Q"))))
    (libparts (libpart (lib "L") (part "P") (pins (pin (num "1") (name "VCC") (type "power_in")) (pin (num "2") (name "GND") (type "power_in"))))))`;
  const parts = schematicParts(netlist);
  assert.equal(parts.get('U1')!.symbol, 'L:P');
  assert.deepEqual([...parts.get('U1')!.pins], [['1', 'VCC'], ['2', 'GND']]);
  assert.deepEqual([...parts.get('J1')!.pins], []);
});
