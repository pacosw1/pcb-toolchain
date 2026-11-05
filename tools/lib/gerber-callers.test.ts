import assert from 'node:assert/strict';
import {test} from 'node:test';
import {padsCheck} from '../silk_jlc.ts';
import {gerberCheck} from '../fp_keepouts.ts';
import type {Board} from './board-types.ts';
const g='%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,1*%\nD10*\nX000000Y000000D03*\nM02*';
const files=new Map([['B-F_Silkscreen.gbr',g],['B-F_Mask.gbr',g],['B-B_Silkscreen.gbr',g],['B-B_Mask.gbr',g],['B-F_Cu.gbr',g]]);
test('silk check keeps the 1e-6 mm2 threshold and buffer margin',()=>{
 const seen:string[]=[];
 const check=(near:number)=>padsCheck(files,req=>{seen.push(req.operation+':'+(req.offset_nm??0));return req.operation==='intersection'?0:near/2});
 assert.match(check(0.000000999).lines.at(-1)!,/^PASS/);
 assert.match(check(0.000001).lines.at(-1)!,/^FAIL/);
 assert.ok(seen.includes('buffer_intersection:149900'));
});
test('keepout checks copper area and does not pass an absent area',()=>{
 const area={name:'U1 KO test',layers:['F.Cu'],rule_area:{tracks:true,pour:true,vias:false},outline:[{outline:[{x:0,y:0},{x:1000000,y:0},{x:1000000,y:1000000},{x:0,y:1000000}],holes:[]}]};
 const board={zones:[area]} as unknown as Board;
 assert.match(gerberCheck(board,'U1',files,()=>0.000000999).lines.at(-1)!,/^PASS/);
 assert.match(gerberCheck(board,'U1',files,()=>0.000001).lines.at(-1)!,/^FAIL/);
 assert.match(gerberCheck(board,'U2',files,()=>0).lines.at(-1)!,/^FAIL/);
});
