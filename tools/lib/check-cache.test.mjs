import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkInputs,checkKey,restoreCheck,storeCheck} from './check-cache.mjs';
import {gateTools} from './gate-inputs.mjs';

function fixture(t) {
 const root=mkdtempSync(join(tmpdir(),'check-cache-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(path,text)=>{mkdirSync(join(root,path,'..'),{recursive:true});writeFileSync(join(root,path),text);};
 put('rule','original');put('runtime','runtime');mkdirSync(join(root,'evidence'));
 put('evidence/erc.log','clean\n[exit 0]');put('evidence/erc.json',JSON.stringify({sheets:[{violations:[]}]}));
 const key=()=>checkKey({root,files:[join(root,'rule')],stage:'erc',config:{},versions:{kicad:'10.0.6'},externalRoots:{},commands:[join(root,'runtime')]});
 const metrics={erc_errors:0,erc_warnings:0};const cache=join(root,'cache'),evidence=join(root,'evidence');
 return {root,put,key,metrics,cache,evidence};
}
test('cache restores completed findings, with matching artifact hashes and inputs',t=>{
 const {root,put,key,metrics,cache,evidence}=fixture(t);const first=key();
 assert.equal(storeCheck(cache,'erc',first,metrics,evidence).stored,true);
 const next=join(root,'next');mkdirSync(next);
 assert.deepEqual(restoreCheck(cache,'erc',first.key,next).metrics,metrics);
 assert.equal(readFileSync(join(next,'erc.log'),'utf8'),'clean\n[exit 0]');
 put('rule','changed');assert.notEqual(key().key,first.key);
 assert.equal(restoreCheck(cache,'erc',key().key,next).hit,false);
 put('rule','original');put('runtime','different runtime with same reported version');assert.notEqual(key().key,first.key);
});
test('corrupt cache artifacts are rejected before copying and can be replaced',t=>{
 const {root,key,metrics,cache,evidence}=fixture(t);const first=key();
 storeCheck(cache,'erc',first,metrics,evidence);
 writeFileSync(join(cache,'erc',first.key,'erc.json'),'corrupt');
 const next=join(root,'next');mkdirSync(next);
 const rejected=restoreCheck(cache,'erc',first.key,next);
 assert.equal(rejected.hit,false);assert.equal(rejected.rejected,true);assert.deepEqual(readdirSync(next),[]);
 assert.equal(storeCheck(cache,'erc',first,metrics,evidence).stored,true);
 assert.equal(restoreCheck(cache,'erc',first.key,next).hit,true);
});
test('null metrics, missing reports and incomplete receipts cannot become cache hits',t=>{
 const {root,key,metrics,cache,evidence}=fixture(t);const first=key();
 assert.equal(storeCheck(cache,'erc',first,{erc_errors:null,erc_warnings:0},evidence).stored,false);
 rmSync(join(evidence,'erc.json'));assert.equal(storeCheck(cache,'erc',first,metrics,evidence).stored,false);
 writeFileSync(join(evidence,'erc.json'),'{}');assert.equal(storeCheck(cache,'erc',first,metrics,evidence).stored,false);
 writeFileSync(join(evidence,'erc.json'),JSON.stringify({sheets:[{violations:[]}]}));assert.equal(storeCheck(cache,'erc',first,metrics,evidence).stored,true);
 const folder=join(cache,'erc',first.key),receipt=JSON.parse(readFileSync(join(folder,'receipt.json')));
 receipt.completed=false;const text=JSON.stringify(receipt);
 writeFileSync(join(folder,'receipt.json'),text);writeFileSync(join(folder,'receipt.sha256'),createHash('sha256').update(text).digest('hex'));
 const next=join(root,'next');mkdirSync(next);
 assert.match(restoreCheck(cache,'erc',first.key,next).reason,/incomplete/);
});
test('a checker key excludes unrelated Python implementations but retains its own imports and libraries',t=>{
 const {root,put}=fixture(t);
 put('tools/gate.mjs',"const a=tool('a.py'), b=tool('b.py');");put('tools/a.py','import helper\n');put('tools/helper.py','rule=1');put('tools/b.py','rule=1');
 put('board.kicad_pcb','pcb');put('shared.kicad_sym','library');
 const files=[...gateTools(root),join(root,'board.kicad_pcb'),join(root,'shared.kicad_sym')];
 const key=()=>checkKey({root,files:checkInputs(root,files,'planes','a.py'),stage:'planes',config:{},versions:{},externalRoots:{},commands:[]}).key;
 const first=key();put('tools/b.py','rule=2');assert.equal(key(),first);
 put('tools/helper.py','rule=2');assert.notEqual(key(),first);const second=key();
 put('shared.kicad_sym','library changed');assert.notEqual(key(),second);
});
