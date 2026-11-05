import assert from 'node:assert/strict';
import {test} from 'node:test';
import {padsCheck} from '../silk_jlc.ts';
import {gerberCheck} from '../fp_keepouts.ts';
import type {Board} from './board-types.ts';
const g='%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,1*%\nD10*\nX000000Y000000D03*\nM02*';
const files=new Map([['B-F_Silkscreen.gbr',g],['B-F_Mask.gbr',g],['B-B_Silkscreen.gbr',g],['B-B_Mask.gbr',g],['B-F_Cu.gbr',g]]);
test('silk check reports uncertainty near threshold and keeps a clearly separated pass',()=>{
 const seen:string[]=[];
 const check=(near:number, guard:number)=>padsCheck(files,req=>{seen.push(req.operation+':'+(req.offset_nm??0));return req.offset_nm===150900 ? guard/2 : req.operation==='intersection'?0:near/2});
 assert.equal(check(0,0).verdict,'PASS');
 assert.equal(check(0,1e-8).verdict,'UNCERTAIN');
 assert.equal(check(0.000000999,0).verdict,'UNCERTAIN');
 assert.equal(check(0.000001,0).verdict,'UNCERTAIN');
 assert.equal(check(0.000101,0).verdict,'FAIL');
 assert.ok(seen.includes('buffer_intersection:149900'));
 assert.ok(seen.includes('buffer_intersection:150900'));
});
test('keepout checks area, uncertainty and absent areas',()=>{
 const area={name:'U1 KO test',layers:['F.Cu'],rule_area:{tracks:true,pour:true,vias:false},outline:[{outline:[{x:0,y:0},{x:1000000,y:0},{x:1000000,y:1000000},{x:0,y:1000000}],holes:[]}]};
 const board={zones:[area]} as unknown as Board;
 assert.equal(gerberCheck(board,'U1',files,()=>0).verdict,'PASS');
 assert.equal(gerberCheck(board,'U1',files,req=>req.operation==='intersection'?0:1e-8).verdict,'UNCERTAIN');
 assert.equal(gerberCheck(board,'U1',files,()=>0.000000999).verdict,'UNCERTAIN');
 assert.equal(gerberCheck(board,'U1',files,()=>0.000001).verdict,'UNCERTAIN');
 assert.equal(gerberCheck(board,'U1',files,()=>0.000101).verdict,'FAIL');
 assert.equal(gerberCheck(board,'U2',files,()=>0).verdict,'FAIL');
});
