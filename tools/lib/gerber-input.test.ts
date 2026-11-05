import assert from 'node:assert/strict';
import {test} from 'node:test';
import {padsOf} from '../gerber_netcheck.ts';
import type {BoardDocument} from './board-types.ts';

test('Gerber pad extraction refuses incomplete native reader output', () => {
 const doc = (board: unknown) => ({board} as unknown as BoardDocument);
 assert.throws(() => padsOf(doc({})), /copper layers or footprints/);
 assert.throws(() => padsOf(doc({copper_layers:['F.Cu'],footprints:[{reference:'U1'}]})), /footprint/);
 assert.throws(() => padsOf(doc({copper_layers:['F.Cu'],footprints:[{reference:'U1',pads:[{number:'1',position:{x:0,y:NaN},layers:['F.Cu']}]}]})), /pad data/);
 assert.deepEqual(padsOf(doc({copper_layers:['F.Cu','B.Cu'],footprints:[{reference:'U1',pads:[{number:'1',position:{x:1000000,y:2000000},layers:['F.Cu','F.Mask']}]}]})),
  [{ref:'U1',pin:'1',x:1,y:-2,layers:['F.Cu']}]);
});
