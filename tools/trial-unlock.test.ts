import test from 'node:test';
import assert from 'node:assert/strict';
import { unlockBoard } from './trial-unlock.ts';

const part = (ref: string) => `\t(footprint "x"\n\t\t(locked yes)\n\t\t(layer "F.Cu")\n\t\t(property "Reference" "${ref}")\n\t\t(pad "1" smd rect\n\t\t\t(locked yes)\n\t\t)\n\t)\n`;
const board = (...refs: string[]) => `(kicad_pcb\n${refs.map(part).join('')})\n`;

test('a trial start unlocks each part except the kept refs; pads keep their own lock', () => {
  const text = unlockBoard(board('C1', 'J1', 'U1'), new Set(['J1']));
  const form = (ref: string) => text.slice(text.lastIndexOf('(footprint', text.indexOf(`"${ref}"`)), text.indexOf(`"${ref}"`));
  assert.doesNotMatch(form('C1'), /locked/);
  assert.doesNotMatch(form('U1'), /locked/);
  assert.match(form('J1'), /\(locked yes\)/);
  assert.equal(text.match(/\t\t\t\(locked yes\)/g)?.length, 3);
});

test('a trial start unlocks tracks and vias, so that unroute can remove them', () => {
  const copper = '\t(segment\n\t\t(start 0 0)\n\t\t(locked yes)\n\t\t(net "/RF")\n\t)\n\t(via\n\t\t(at 1 1)\n\t\t(locked yes)\n\t\t(net "GND")\n\t)\n';
  const text = unlockBoard(`(kicad_pcb\n${copper})\n`, new Set());
  assert.doesNotMatch(text, /locked/);
  assert.match(text, /\(net "\/RF"\)/);
});

test('a trial start removes the block drawings of User.1: they hold the stored layout', () => {
  const drawings = '\t(gr_line\n\t\t(start 0 0)\n\t\t(end 1 0)\n\t\t(layer "User.1")\n\t)\n\t(gr_text "U1 BLOCK"\n\t\t(at 1 1 0)\n\t\t(layer "User.1")\n\t)\n\t(gr_text "SIM"\n\t\t(at 2 2 0)\n\t\t(layer "F.SilkS")\n\t)\n';
  const text = unlockBoard(`(kicad_pcb\n${drawings})\n`, new Set());
  assert.doesNotMatch(text, /User\.1/);
  assert.match(text, /"SIM"/);
});

test('a kept ref that the board does not hold is an error', () => {
  assert.throws(() => unlockBoard(board('C1'), new Set(['J9'])), /J9/);
});
