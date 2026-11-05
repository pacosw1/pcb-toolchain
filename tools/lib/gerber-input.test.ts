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

test('native inventory rejects duplicate UUIDs and omitted custom pads', async () => {
 const {validatePadInventory} = await import('../gerber_netcheck.ts');
 const source = '(kicad_pcb (footprint "f" (uuid "f1") (pad "1" smd custom (uuid "p1")) (pad "2" smd rect (uuid "p2"))))';
 const doc = (pads: unknown[]) => ({board:{footprints:[{id:'f1',pads}]}} as unknown as BoardDocument);
 const pads = [{id:'p1',number:'1'}, {id:'p2',number:'2'}];
 assert.doesNotThrow(() => validatePadInventory(source,doc(pads)));
 assert.throws(() => validatePadInventory(source,doc(pads.slice(1))), /pad inventory mismatch/);
 assert.throws(() => validatePadInventory(source.replace('"p2"','"p1"'),doc(pads)), /duplicate native UUID/);
 assert.throws(() => validatePadInventory(source,doc([{id:'p1',number:'2'},pads[1]])), /pad inventory mismatch/);
});
