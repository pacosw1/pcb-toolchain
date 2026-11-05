import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DrcFile } from './board-edit.ts';
import { druMentions } from './pcbtool-corridor.ts';
import { netCheck } from './pcbtool-read.ts';
import { netRules, type ProjectFile } from './board-obstacles.ts';

const REPORT: DrcFile = {
  violations: [
    { type: 'clearance', severity: 'error', items: [{ description: 'Track [VBAT] on F.Cu' }, { description: 'Pad 1 [GND] of U1' }] },
    { type: 'clearance', severity: 'error', items: [{ description: 'Track [/SDA] on F.Cu' }, { description: 'Pad 2 [GND] of U1' }] },
    { type: 'silk_overlap', severity: 'warning', items: [{ description: 'x' }] },
  ],
  unconnected_items: [
    { items: [{ description: 'Pad 1 [VBAT] of Q1', pos: { x: 1, y: 2.5 } }, { description: 'Pad 8 [VBAT] of U1' }] },
    { items: [{ description: 'Pad 1 [/SDA] of U2' }, { description: 'Pad 3 [/SDA] of U1' }] },
  ],
  schematic_parity: [{ type: 'x' }],
};

test('one summary line, then the items of the net', () => {
  const { lines, ok } = netCheck(REPORT, 'VBAT');
  assert.equal(lines[0], 'DRC total: 2 errors, 2 unconnected, 1 parity | VBAT: 1 violations, 1 unconnected');
  assert.equal(lines.length, 3);
  assert.match(lines[1]!, /^ {2}E clearance: Track \[VBAT\]/);
  assert.equal(lines[2], '  U Pad 1 [VBAT] of Q1 (1.000, 2.500) | Pad 8 [VBAT] of U1');
  assert.equal(ok, false);
});

test('a clean net is ok', () => {
  const { lines, ok } = netCheck(REPORT, '/SCL');
  assert.equal(ok, true);
  assert.equal(lines.length, 1);
});

test('the net match is exact', () => {
  assert.equal(netCheck(REPORT, 'BAT').ok, true);
});

test('with no limit all the items of the net are listed, and a limit counts both kinds', () => {
  assert.equal(netCheck(REPORT, 'VBAT', null).lines.length, 3);
  assert.equal(netCheck(REPORT, 'VBAT', 1).lines.length, 2);
});

const PROJECT = {
  net_settings: {
    classes: [{ name: 'Default', track_width: 0.2, clearance: 0.2 }, { name: 'CELL', track_width: 1.5, clearance: 0.3 }],
    netclass_patterns: [{ netclass: 'CELL', pattern: 'VBAT*' }],
  },
} as ProjectFile;

test('a net has the class of its pattern, else Default', () => {
  assert.deepEqual(netRules(PROJECT, 'VBAT_F'), { className: 'CELL', trackWidth: 1.5, clearance: 0.3 });
  assert.deepEqual(netRules(PROJECT, '/SDA'), { className: 'Default', trackWidth: 0.2, clearance: 0.2 });
});

test('the .kicad_dru rules that name the net or its class', () => {
  const dru = '(version 1)\n(rule "Cell gap"\n (condition "A.NetClass == \'CELL\'")\n (constraint clearance (min 1mm)))\n'
    + '(rule "Other"\n (condition "A.NetName == \'/SDA\'")\n (constraint clearance (min 0.3mm)))\n';
  assert.deepEqual(druMentions(dru, ['VBAT_F', 'CELL']), ['Cell gap']);
});
