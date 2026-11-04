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
test('checkout root is not a key input, but sibling paths outside the root are',t=>{
 const parent=mkdtempSync(join(tmpdir(),'check-roots-'));t.after(()=>rmSync(parent,{recursive:true,force:true}));
 for(const d of ['a','b','a-modules','b-modules']) mkdirSync(join(parent,d));
 const saved=process.env.PYTHONPATH;t.after(()=>{if(saved===undefined) delete process.env.PYTHONPATH;else process.env.PYTHONPATH=saved;});
 const key=(r,py)=>{process.env.PYTHONPATH=py;return checkKey({root:join(parent,r),files:[],stage:'erc',config:{},versions:{},externalRoots:{},commands:[]}).key;};
 assert.equal(key('a',join(parent,'a','lib')),key('b',join(parent,'b','lib')));
 assert.notEqual(key('a',join(parent,'a-modules')),key('b',join(parent,'b-modules')));
});
test('a restore that cannot write all artifacts removes what it wrote, so the check can run in the same folder',t=>{
 const {root,key,metrics,cache,evidence}=fixture(t);const first=key();
 storeCheck(cache,'erc',first,metrics,evidence);
 const next=join(root,'next');mkdirSync(next);writeFileSync(join(next,'erc.json'),'from this run');
 const restored=restoreCheck(cache,'erc',first.key,next);
 assert.equal(restored.hit,false);assert.match(restored.reason,/EEXIST/);
 assert.deepEqual(readdirSync(next),['erc.json']);assert.equal(readFileSync(join(next,'erc.json'),'utf8'),'from this run');
});
// Parallel boards and other worktrees share one cache: publication is temp folder + rename; an invalid receipt is
// moved away in one step. Readers see a complete receipt or a miss, never a partial evidence folder.
test('concurrent writers and readers of one key never corrupt the cache or the evidence',async t=>{
 const {root,key,metrics,cache,evidence}=fixture(t);const first=key();
 storeCheck(cache,'erc',first,metrics,evidence);
 writeFileSync(join(cache,'erc',first.key,'erc.json'),'corrupt');
 const module=new URL('./check-cache.mjs',import.meta.url).href;
 const writer=`const {storeCheck}=await import(${JSON.stringify(module)});console.log(JSON.stringify(storeCheck(${JSON.stringify(cache)},'erc',${JSON.stringify(first)},${JSON.stringify(metrics)},${JSON.stringify(evidence)})));`;
 const reader=n=>`const {restoreCheck}=await import(${JSON.stringify(module)});const fs=await import('node:fs');const out=[];
  for(let i=0;i<40;i++){const d=${JSON.stringify(join(root,'read'))}+'-${n}-'+i;fs.mkdirSync(d,{recursive:true});const r=restoreCheck(${JSON.stringify(cache)},'erc',${JSON.stringify(first.key)},d);
   out.push({hit:r.hit,files:fs.readdirSync(d).sort()});}console.log(JSON.stringify(out));`;
 const {spawn}=await import('node:child_process');
 const run=code=>new Promise((resolve,reject)=>{let out='';const c=spawn(process.execPath,['--input-type=module','-e',code]);
  c.stdout.on('data',d=>out+=d);c.stderr.on('data',d=>out+=d);c.on('close',code=>code===0 ? resolve(JSON.parse(out)) : reject(new Error(out)));});
 const results=await Promise.all([...Array.from({length:6},()=>run(writer)),...Array.from({length:3},(_,n)=>run(reader(n)))]);
 const writes=results.slice(0,6),reads=results.slice(6).flat();
 assert.ok(writes.some(w=>w.stored),JSON.stringify(writes));
 for(const r of reads) assert.deepEqual(r.files,r.hit ? ['erc.json','erc.log'] : [],JSON.stringify(r));
 assert.deepEqual(readdirSync(join(cache,'erc')),[first.key]);
 const next=join(root,'next');mkdirSync(next);assert.equal(restoreCheck(cache,'erc',first.key,next).hit,true);
});
