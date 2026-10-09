import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inspectPackets,parseCsv,FULL_PACKET} from './board-packets.mjs';

function fixture(t) {
 const root=mkdtempSync(join(tmpdir(),'packets-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(p,v)=>{mkdirSync(join(root,'hardware-design/boards',p,'..'),{recursive:true});writeFileSync(join(root,'hardware-design/boards',p),v);};
 put('CELLULAR/SPEC.md','# CELLULAR specification');
 const registry={schema_version:1,boards:[{id:'CELLULAR',directory:'CELLULAR',kind:'board',lifecycle:'active',packet:'full',revisions:[{revision:'A',spec:'SPEC.md',state:'design-complete-not-ordered'}]}]};
 return {root,put,registry};
}
test('new active boards cannot pass with only a SPEC',t=>{
 const {root,registry}=fixture(t);const r=inspectPackets(root,registry);
 assert.equal(r.ok,false);assert.ok(r.findings.some(f=>f.detail.includes('CELLULAR/BOM-VERIFIED.csv')));assert.equal(r.checked.length,1);
});
test('full packet with component rows passes; empty verified BOM fails',t=>{
 const {root,put,registry}=fixture(t);
 for(const p of FULL_PACKET) put('CELLULAR/'+p,p==='BOM-VERIFIED.csv'?'Designator,Function block,MPN/value,LCSC\nU1,"LTE, GNSS",EG912U,C123\n':'content');
 assert.equal(inspectPackets(root,registry).ok,true);
 put('CELLULAR/BOM-VERIFIED.csv','Designator,Function block,MPN/value,LCSC\n');
 assert.ok(inspectPackets(root,registry).findings.some(f=>f.check==='bom_empty'));
});
test('gate-only revision resolves owner without demanding a second packet',t=>{
 const {root,put,registry}=fixture(t);
 registry.boards[0].lifecycle='planned';registry.boards[0].revisions.push({revision:'B',spec:'SPEC.md',state:'layout',gate:'CELLULAR-B',project:'cad/B/B'});
 registry.boards.push({id:'CELLULAR-B',directory:'CELLULAR-B',kind:'gate-only',lifecycle:'active',owner:'CELLULAR',revision:'B'});
 put('CELLULAR-B/gate.json',JSON.stringify({project:'../CELLULAR/cad/B/B'}));
 assert.equal(inspectPackets(root,registry).ok,true);
 registry.boards[1].revision='X';assert.ok(inspectPackets(root,registry).findings.some(f=>f.check==='gate_owner'));
});
test('population variants share a board and reject unknown fit names',t=>{
 const {root,put,registry}=fixture(t);registry.boards[0].lifecycle='planned';
 registry.boards[0].variants={file:'variants.json',names:['VIB','AIR','ALL']};
 put('CELLULAR/variants.json',JSON.stringify({variants:['VIB','AIR','ALL'],fit:{U1:['ALL','AIR']}}));
 assert.equal(inspectPackets(root,registry).ok,true);
 put('CELLULAR/variants.json',JSON.stringify({variants:['VIB','AIR','ALL'],fit:{U1:['UNKNOWN']}}));
 assert.ok(inspectPackets(root,registry).findings.some(f=>f.check==='variants'));
 registry.boards.push({id:'CELLULAR-V',directory:null,kind:'variant',lifecycle:'planned',variant_of:'CELLULAR',source:'CELLULAR/SPEC.md'});
 assert.equal(inspectPackets(root,registry).checked.length,2);
});
test('unregistered board directories are findings',t=>{
 const {root,put,registry}=fixture(t);put('NEW/SPEC.md','new');
 assert.ok(inspectPackets(root,registry).findings.some(f=>f.check==='unregistered_board'));
});
test('CSV quoted comma, escaped quote and newline preserve exact columns',()=>{
 assert.deepEqual(parseCsv('Ref,MPN,LCSC\r\nU1,"Part, \"\"A\"\"\nB",C123\r\n'),[['Ref','MPN','LCSC'],['U1','Part, "A"\nB','C123']]);
 assert.throws(()=>parseCsv('U1,"unfinished,C123'));
});
