import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {affectedGates,stagedGateMap,checkStaged,recordedInputs,pinnedRelease} from './staged-gates.mjs';
const fixture=t=>{
 const root=mkdtempSync(join(tmpdir(),'staged-gate-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(p,v)=>{mkdirSync(join(root,p,'..'),{recursive:true});writeFileSync(join(root,p),v);};
 put('hardware-design/boards/BASE-PWR/gate.json',JSON.stringify({project:'cad/A/A',checks:{erc:true,drc:true}}));
 put('hardware-design/boards/BASE-PWR-B/gate.json',JSON.stringify({project:'../BASE-PWR/cad/B/B',checks:{erc:true,drc:true}}));
 return {root,put};
};
test('rev B maps to its separate gate; deleted/shared assets map conservatively',t=>{
 const {root}=fixture(t);
 assert.deepEqual(affectedGates(root,['hardware-design/boards/BASE-PWR/cad/B/B.kicad_pcb']),['BASE-PWR-B']);
 for(const p of ['hardware-design/registry/cad-assets/C123/C123.kicad_mod','hardware-design/blocks/iot-lab.pretty/C123.kicad_mod','hardware-design/registry/courtyard-bodies.json','tools/gate.mjs']) assert.deepEqual(affectedGates(root,[p]),['BASE-PWR','BASE-PWR-B']);
 const old=new Map([['BASE-PWR',JSON.parse(readFileSync(join(root,'hardware-design/boards/BASE-PWR/gate.json'),'utf8'))]]);
 rmSync(join(root,'hardware-design/boards/BASE-PWR/gate.json'));
 assert.ok(affectedGates(root,['hardware-design/boards/BASE-PWR/gate.json'],old).includes('BASE-PWR'));
});
test('partial staging checks the index and preserves unrelated edits',async t=>{
 const {root,put}=fixture(t);
 const git=args=>execFileSync('git',['-C',root,...args],{encoding:'utf8'});
 git(['init','-q']);git(['config','user.email','test@example.invalid']);git(['config','user.name','Test']);
 put('tools/gate.mjs',`import {readFileSync,writeFileSync} from 'node:fs';\nconst b=process.argv[2];const p='hardware-design/boards/'+b+'/';const c=JSON.parse(readFileSync(p+'gate.json'));const text=readFileSync(p+c.project+'.kicad_pcb','utf8');if(text!=='staged') process.exit(1);writeFileSync(p+'gate-metrics.json',JSON.stringify({metrics:{drc_errors:0},checked:text}));`);
 put('hardware-design/boards/BASE-PWR/cad/A/A.kicad_pcb','initial');
 put('hardware-design/boards/BASE-PWR-B/gate-metrics.json','{}');
 git(['add','.']);git(['commit','-qm','initial']);
 put('hardware-design/boards/BASE-PWR/cad/A/A.kicad_pcb','staged');git(['add','hardware-design/boards/BASE-PWR/cad/A/A.kicad_pcb']);
 put('hardware-design/boards/BASE-PWR/cad/A/A.kicad_pcb','unstaged');put('unrelated.txt','keep');
 await checkStaged(root);
 assert.equal(readFileSync(join(root,'hardware-design/boards/BASE-PWR/cad/A/A.kicad_pcb'),'utf8'),'unstaged');
 assert.equal(JSON.parse(git(['show',':hardware-design/boards/BASE-PWR/gate-metrics.json'])).checked,'staged');
 assert.ok(!git(['diff','--cached','--name-only']).includes('unrelated.txt'));
});
test('failure retains logs and leaves the index unchanged',async t=>{
 const {root,put}=fixture(t);
 const git=args=>execFileSync('git',['-C',root,...args],{encoding:'utf8'});
 git(['init','-q']);git(['config','user.email','test@example.invalid']);git(['config','user.name','Test']);
 put('tools/gate.mjs',`import {mkdirSync,writeFileSync} from 'node:fs';const p='hardware-design/boards/'+process.argv[2]+'/.gate';mkdirSync(p,{recursive:true});writeFileSync(p+'/drc.log','checker failed');process.exit(1);`);
 put('hardware-design/boards/BASE-PWR/cad/A/A.kicad_pcb','initial');
 git(['add','.']);git(['commit','-qm','initial']);
 put('hardware-design/boards/BASE-PWR/cad/A/A.kicad_pcb','staged');git(['add','.']);
 const before=git(['write-tree']).trim();
 await assert.rejects(checkStaged(root));assert.equal(git(['write-tree']).trim(),before);
 const evidence=join(root,'.gate',readdirSync(join(root,'.gate'))[0]);
 assert.equal(readFileSync(join(evidence,'BASE-PWR/drc.log'),'utf8'),'checker failed');
 assert.equal(JSON.parse(readFileSync(join(evidence,'snapshot.json'),'utf8')).indexTree,before);
});
test('index changes during validation stop metric staging',async t=>{
 const {root,put}=fixture(t);
 const git=args=>execFileSync('git',['-C',root,...args],{encoding:'utf8'});
 git(['init','-q']);git(['config','user.email','test@example.invalid']);git(['config','user.name','Test']);
 put('tools/gate.mjs',`import {writeFileSync} from 'node:fs';import {execFileSync} from 'node:child_process';const root=${JSON.stringify(root)};writeFileSync(root+'/concurrent.txt','another agent');execFileSync('git',['-C',root,'add','concurrent.txt']);writeFileSync('hardware-design/boards/'+process.argv[2]+'/gate-metrics.json','{}');`);
 put('hardware-design/boards/BASE-PWR/cad/A/A.kicad_pcb','initial');git(['add','.']);git(['commit','-qm','initial']);
 put('hardware-design/boards/BASE-PWR/cad/A/A.kicad_pcb','staged');git(['add','.']);
 await assert.rejects(checkStaged(root),/index changed during gate checks/);
 assert.ok(git(['diff','--cached','--name-only']).includes('concurrent.txt'));
 assert.ok(!git(['diff','--cached','--name-only']).includes('gate-metrics.json'));
});
// D-129: committed fingerprint inputs decide which boards a changed path gates.
test('a changed path gates only the boards whose recorded inputs or own files include it',t=>{
 const {root,put}=fixture(t);
 put('hardware-design/boards/BASE-PWR/gate-waivers.json','[]');
 const inputs=new Map([
  ['BASE-PWR',new Set(['tools/gate.mjs','tools/si_planes.ts','hardware-design/boards/BASE-PWR/cad/A/A.kicad_pcb'])],
  ['BASE-PWR-B',new Set(['tools/gate.mjs','tools/si_planes.ts','tools/rf_lines.ts'])]]);
 assert.deepEqual(affectedGates(root,['tools/route_live.py'],new Map(),inputs),[]);
 assert.deepEqual(affectedGates(root,['tools/test_pcbtool.py','tools/lib/staged-gates.mjs'],new Map(),inputs),[]);
 assert.deepEqual(affectedGates(root,['tools/si_planes.ts'],new Map(),inputs),['BASE-PWR','BASE-PWR-B']);
 assert.deepEqual(affectedGates(root,['tools/rf_lines.ts'],new Map(),inputs),['BASE-PWR-B']);
 assert.deepEqual(affectedGates(root,['hardware-design/boards/BASE-PWR/cad/A/A.kicad_pcb'],new Map(),inputs),['BASE-PWR']);
 assert.deepEqual(affectedGates(root,['hardware-design/boards/BASE-PWR/cad/B/B.kicad_pcb'],new Map(),inputs),['BASE-PWR-B']);
 assert.deepEqual(affectedGates(root,['hardware-design/boards/BASE-PWR/gate-waivers.json'],new Map(),inputs),['BASE-PWR']);
 // A board without committed metrics keeps the conservative rule.
 assert.deepEqual(affectedGates(root,['tools/route_live.py'],new Map(),new Map([['BASE-PWR',inputs.get('BASE-PWR')]])),['BASE-PWR-B']);
 const {boards,reasons}=stagedGateMap(root,['tools/si_planes.ts','docs/x.md','hardware-design/boards/BASE-PWR/cad/A/A.kicad_pcb'],new Map(),inputs);
 assert.deepEqual(boards,['BASE-PWR','BASE-PWR-B']);
 assert.deepEqual([...reasons],[['tools/si_planes.ts',['BASE-PWR','BASE-PWR-B']],['hardware-design/boards/BASE-PWR/cad/A/A.kicad_pcb',['BASE-PWR']]]);
});
// Audit #802: metrics without a nonempty provenance.inputs list must not disable the conservative fallback.
test('missing, empty or malformed provenance keeps the conservative rule for deleted shared inputs',t=>{
 const {root}=fixture(t);const deleted='tools/lib/shared-helper.mjs';
 for(const text of ['{"metrics":{}}','{"provenance":{}}','{"provenance":{"inputs":[]}}','{"provenance":{"inputs":[{"sha256":null}]}}','{"provenance":{"inputs":"tools/gate.mjs"}}','not json',null]) {
  const recorded=recordedInputs(text);assert.equal(recorded,null,String(text));
  const head=recorded ? new Map([['BASE-PWR',recorded]]) : new Map();
  assert.deepEqual(affectedGates(root,[deleted],new Map(),head),['BASE-PWR','BASE-PWR-B']);
 }
 // An empty Set passed directly is also not a recorded input list.
 assert.deepEqual(affectedGates(root,[deleted],new Map(),new Map([['BASE-PWR',new Set()],['BASE-PWR-B',new Set()]])),['BASE-PWR','BASE-PWR-B']);
 const valid=recordedInputs(JSON.stringify({provenance:{inputs:[{path:'tools/gate.mjs',sha256:'x'}]}}));
 assert.deepEqual([...valid],['tools/gate.mjs']);
 assert.deepEqual(affectedGates(root,[deleted],new Map(),new Map([['BASE-PWR',valid],['BASE-PWR-B',valid]])),[]);
});
// Boards run in a bounded pool. The staged metrics are the same bytes as a serial run; a failed board stops new boards.
test('parallel boards give the same staged metrics as serial; a failure names the board and stages nothing',async t=>{
 const {root,put}=fixture(t);
 const git=args=>execFileSync('git',['-C',root,...args],{encoding:'utf8'});
 git(['init','-q']);git(['config','user.email','test@example.invalid']);git(['config','user.name','Test']);
 put('hardware-design/boards/C/gate.json',JSON.stringify({project:'cad/C/C',checks:{erc:true}}));
 put('hardware-design/boards/D/gate.json',JSON.stringify({project:'cad/D/D',checks:{erc:true}}));
 // Fake gate: record overlap with other boards, fail when the board file says so.
 put('tools/gate.mjs',`import {readFileSync,writeFileSync,mkdirSync,readdirSync,rmSync} from 'node:fs';const b=process.argv[2];const p='hardware-design/boards/'+b+'/';
  const live=process.env.LIVE;mkdirSync(live,{recursive:true});writeFileSync(live+'/'+b,'');writeFileSync(live+'-started-'+b,'');const seen=readdirSync(live).length;
  await new Promise(r=>setTimeout(r,300));let wait=0;// BARRIER: wait (at most 10 s) until that many boards started.
  const started=()=>readdirSync(live+'/..').filter(n=>n.startsWith(live.split('/').pop()+'-started-')).length;
  while(started()<Number(process.env.BARRIER ?? 0) && wait++<500) await new Promise(r=>setTimeout(r,20));
  writeFileSync(live+'-max-'+b,String(Math.max(seen,readdirSync(live).length)));rmSync(live+'/'+b);
  const c=JSON.parse(readFileSync(p+'gate.json'));const text=readFileSync(p+c.project+'.kicad_pcb','utf8');
  if(text.includes('fail')) {writeFileSync(process.env.LIVE+'-failed',String(process.pid));process.exit(1);}
  // In the failure case a passing board is still in progress when the other board fails: it finishes only after
  // the hook has reaped the failed gate, so the pool knows the failure before a lane is free (deterministic order).
  if(process.env.WAIT_FAIL) {
   const mark=process.env.LIVE+'-failed';let pid=0;
   while(!pid) {try{pid=Number(readFileSync(mark,'utf8'));}catch{} await new Promise(r=>setTimeout(r,20));}
   const alive=()=>{try{process.kill(pid,0);return true;}catch{return false;}};
   while(alive()) await new Promise(r=>setTimeout(r,20));
   await new Promise(r=>setTimeout(r,200));
  }
  writeFileSync(p+'gate-metrics.json',JSON.stringify({metrics:{erc_errors:0},board:b,checked:text})+'\\n');`);
 for(const b of ['A','B','C','D']) put(`hardware-design/boards/${b==='A'?'BASE-PWR':b==='B'?'BASE-PWR-B':b}/${b==='A'?'cad/A/A':b==='B'?'../BASE-PWR/cad/B/B':`cad/${b}/${b}`}.kicad_pcb`,'initial');
 git(['add','.']);git(['commit','-qm','initial']);
 put('tools/gate.mjs',readFileSync(join(root,'tools/gate.mjs'),'utf8')+'\n');git(['add','.']);// a shared tool change gates every board
 const env={...process.env};t.after(()=>{for(const k of ['IOT_LAB_GATE_JOBS','LIVE','IOT_LAB_GATE_CACHE','WAIT_FAIL','BARRIER']) if(env[k]===undefined) delete process.env[k];else process.env[k]=env[k];});
 process.env.IOT_LAB_GATE_CACHE=join(root,'.cache');
 const staged=()=>['BASE-PWR','BASE-PWR-B','C','D'].map(b=>git(['show',`:hardware-design/boards/${b}/gate-metrics.json`]));
 const maxOverlap=live=>Math.max(...['BASE-PWR','BASE-PWR-B','C','D'].map(b=>Number(readFileSync(`${live}-max-${b}`,'utf8'))));
 const base=git(['write-tree']).trim();
 process.env.IOT_LAB_GATE_JOBS='1';process.env.LIVE=join(root,'.live1');await checkStaged(root);const serial=staged();
 assert.equal(maxOverlap(process.env.LIVE),1);
 git(['read-tree',base]);
 process.env.IOT_LAB_GATE_JOBS='3';process.env.LIVE=join(root,'.live3');process.env.BARRIER='3';await checkStaged(root);
 assert.deepEqual(staged(),serial);assert.equal(maxOverlap(process.env.LIVE),3);delete process.env.BARRIER;
 git(['read-tree',base]);
 put('hardware-design/boards/BASE-PWR/cad/A/A.kicad_pcb','fail');git(['add','.']);const before=git(['write-tree']).trim();
 process.env.IOT_LAB_GATE_JOBS='2';process.env.LIVE=join(root,'.live2');process.env.WAIT_FAIL='1';
 await assert.rejects(checkStaged(root),/gate failed: BASE-PWR \(exit 1\); not run: C, D/);
 assert.equal(git(['write-tree']).trim(),before);
});

test('pinned release: none without a lock, error when not installed, the bundle when installed',t=>{
 const dir=mkdtempSync(join(tmpdir(),'pinned-release-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const snap=join(dir,'snap'),home=join(dir,'home');mkdirSync(snap);
 assert.equal(pinnedRelease(snap,home),null);
 writeFileSync(join(snap,'toolchain.lock'),JSON.stringify({version:'9.9.9',sha256:'x'}));
 assert.throws(()=>pinnedRelease(snap,home),/pins pcb-toolchain 9\.9\.9, not installed/);
 const bundle=join(home,'.local/share/pcb-toolchain/9.9.9');mkdirSync(bundle,{recursive:true});
 writeFileSync(join(bundle,'VERSION'),'9.9.9 abc\n');
 assert.deepEqual(pinnedRelease(snap,home),{bundle,version:'9.9.9'});
});
