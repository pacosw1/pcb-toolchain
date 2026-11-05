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
 assert.equal(check(0,1e-8).verdict,'PASS');
 assert.equal(check(0.000000999,0).verdict,'PASS');
 assert.equal(check(0.000001,0).verdict,'UNCERTAIN');
 assert.equal(check(0.000101,0).verdict,'FAIL');
 assert.ok(seen.includes('buffer_intersection:149900'));

});
test('keepout checks area, uncertainty and absent areas',()=>{
 const area={name:'U1 KO test',layers:['F.Cu'],rule_area:{tracks:true,pour:true,vias:false},outline:[{outline:[{x:0,y:0},{x:1000000,y:0},{x:1000000,y:1000000},{x:0,y:1000000}],holes:[]}]};
 const board={zones:[area]} as unknown as Board;
 assert.equal(gerberCheck(board,'U1',files,()=>0).verdict,'PASS');
 assert.equal(gerberCheck(board,'U1',files,req=>req.operation==='intersection'?0:1e-8).verdict,'PASS');
 assert.equal(gerberCheck(board,'U1',files,()=>0.000000999).verdict,'PASS');
 assert.equal(gerberCheck(board,'U1',files,()=>0.000001).verdict,'UNCERTAIN');
 assert.equal(gerberCheck(board,'U1',files,()=>0.000101).verdict,'FAIL');
 assert.equal(gerberCheck(board,'U2',files,()=>0).verdict,'FAIL');
});

test('keepout board check tests fill and pad overlaps and refuses missing pad geometry', async()=>{
 const {checkBoard}=await import('../fp_keepouts.ts');
 const points=[{x:0,y:0},{x:1_000_000,y:0},{x:1_000_000,y:1_000_000},{x:0,y:1_000_000}];
 const polygon={outline:points,holes:[]};
 const area={name:'U1 KO test',layers:['F.Cu'],rule_area:{tracks:false,pour:true,pads:true,vias:false},outline:[polygon]};
 const filled={name:'fill',net:'GND',rule_area:null,filled:[{layer:'F.Cu',polygons:[polygon]}]};
 const pad={number:'1',layers:['F.Cu'],polygons:{'F.Cu':polygon}};
 const board={zones:[area,filled],copper:[],footprints:[{reference:'U1',pads:[pad]}]} as unknown as Board;
 assert.equal(checkBoard(board,'U1',()=>[0,0]).verdict,'PASS');
 assert.equal(checkBoard(board,'U1',()=>[0.01,0]).verdict,'FAIL');
 assert.equal(checkBoard(board,'U1',()=>[0,0.01]).verdict,'FAIL');
 assert.equal(checkBoard(board,'U1',()=>[0,1e-6]).verdict,'UNCERTAIN');
 assert.equal(checkBoard(board,'U2',()=>[]).verdict,'FAIL');
 const missing={...board,footprints:[{reference:'U1',pads:[{...pad,polygons:{}}]}]} as unknown as Board;
 assert.throws(()=>checkBoard(missing,'U1',()=>[]),/missing copper polygon/);
});

test('keepout check rejects an omitted zone or saved fill from native board data', async()=>{
 const {validateZoneInventory}=await import('../fp_keepouts.ts');
 const text='(kicad_pcb (zone (uuid "z1") (filled_polygon (layer "F.Cu") (pts (xy 0 0) (xy 1 0) (xy 0 1)))))';
 const board={zones:[{id:'z1',filled:[{layer:'F.Cu',polygons:[{}]}]}]} as unknown as Board;
 assert.doesNotThrow(()=>validateZoneInventory(text,board));
 assert.throws(()=>validateZoneInventory(text,{zones:[]} as unknown as Board),/zone inventory/);
 assert.throws(()=>validateZoneInventory(text,{zones:[{id:'z1',filled:[]}]} as unknown as Board),/missing saved fill/);
});
