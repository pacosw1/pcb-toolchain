import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {affectedGates,stagedGateMap,checkStaged} from './staged-gates.mjs';
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
test('partial staging checks the index and preserves unrelated edits',t=>{
 const {root,put}=fixture(t);
 const git=args=>execFileSync('git',['-C',root,...args],{encoding:'utf8'});
 git(['init','-q']);git(['config','user.email','test@example.invalid']);git(['config','user.name','Test']);
 put('tools/gate.mjs',`import {readFileSync,writeFileSync} from 'node:fs';\nconst b=process.argv[2];const p='hardware-design/boards/'+b+'/';const c=JSON.parse(readFileSync(p+'gate.json'));const text=readFileSync(p+c.project+'.kicad_pcb','utf8');if(text!=='staged') process.exit(1);writeFileSync(p+'gate-metrics.json',JSON.stringify({metrics:{drc_errors:0},checked:text}));`);
 put('hardware-design/boards/BASE-PWR/cad/A/A.kicad_pcb','initial');
 put('hardware-design/boards/BASE-PWR-B/gate-metrics.json','{}');
 git(['add','.']);git(['commit','-qm','initial']);
 put('hardware-design/boards/BASE-PWR/cad/A/A.kicad_pcb','staged');git(['add','hardware-design/boards/BASE-PWR/cad/A/A.kicad_pcb']);
 put('hardware-design/boards/BASE-PWR/cad/A/A.kicad_pcb','unstaged');put('unrelated.txt','keep');
 checkStaged(root);
 assert.equal(readFileSync(join(root,'hardware-design/boards/BASE-PWR/cad/A/A.kicad_pcb'),'utf8'),'unstaged');
 assert.equal(JSON.parse(git(['show',':hardware-design/boards/BASE-PWR/gate-metrics.json'])).checked,'staged');
 assert.ok(!git(['diff','--cached','--name-only']).includes('unrelated.txt'));
});
test('failure retains logs and leaves the index unchanged',t=>{
 const {root,put}=fixture(t);
 const git=args=>execFileSync('git',['-C',root,...args],{encoding:'utf8'});
 git(['init','-q']);git(['config','user.email','test@example.invalid']);git(['config','user.name','Test']);
 put('tools/gate.mjs',`import {mkdirSync,writeFileSync} from 'node:fs';const p='hardware-design/boards/'+process.argv[2]+'/.gate';mkdirSync(p,{recursive:true});writeFileSync(p+'/drc.log','checker failed');process.exit(1);`);
 put('hardware-design/boards/BASE-PWR/cad/A/A.kicad_pcb','initial');
 git(['add','.']);git(['commit','-qm','initial']);
 put('hardware-design/boards/BASE-PWR/cad/A/A.kicad_pcb','staged');git(['add','.']);
 const before=git(['write-tree']).trim();
 assert.throws(()=>checkStaged(root));assert.equal(git(['write-tree']).trim(),before);
 const evidence=join(root,'.gate',readdirSync(join(root,'.gate'))[0]);
 assert.equal(readFileSync(join(evidence,'BASE-PWR/drc.log'),'utf8'),'checker failed');
 assert.equal(JSON.parse(readFileSync(join(evidence,'snapshot.json'),'utf8')).indexTree,before);
});
test('index changes during validation stop metric staging',t=>{
 const {root,put}=fixture(t);
 const git=args=>execFileSync('git',['-C',root,...args],{encoding:'utf8'});
 git(['init','-q']);git(['config','user.email','test@example.invalid']);git(['config','user.name','Test']);
 put('tools/gate.mjs',`import {writeFileSync} from 'node:fs';import {execFileSync} from 'node:child_process';const root=${JSON.stringify(root)};writeFileSync(root+'/concurrent.txt','another agent');execFileSync('git',['-C',root,'add','concurrent.txt']);writeFileSync('hardware-design/boards/'+process.argv[2]+'/gate-metrics.json','{}');`);
 put('hardware-design/boards/BASE-PWR/cad/A/A.kicad_pcb','initial');git(['add','.']);git(['commit','-qm','initial']);
 put('hardware-design/boards/BASE-PWR/cad/A/A.kicad_pcb','staged');git(['add','.']);
 assert.throws(()=>checkStaged(root),/index changed during gate checks/);
 assert.ok(git(['diff','--cached','--name-only']).includes('concurrent.txt'));
 assert.ok(!git(['diff','--cached','--name-only']).includes('gate-metrics.json'));
});
// D-129: committed fingerprint inputs decide which boards a changed path gates.
test('a changed path gates only the boards whose recorded inputs or own files include it',t=>{
 const {root,put}=fixture(t);
 put('hardware-design/boards/BASE-PWR/gate-waivers.json','[]');
 const inputs=new Map([
  ['BASE-PWR',new Set(['tools/gate.mjs','tools/si_planes.py','hardware-design/boards/BASE-PWR/cad/A/A.kicad_pcb'])],
  ['BASE-PWR-B',new Set(['tools/gate.mjs','tools/si_planes.py','tools/rf_lines.py'])]]);
 assert.deepEqual(affectedGates(root,['tools/route_live.py'],new Map(),inputs),[]);
 assert.deepEqual(affectedGates(root,['tools/test_pcbtool.py','tools/lib/staged-gates.mjs'],new Map(),inputs),[]);
 assert.deepEqual(affectedGates(root,['tools/si_planes.py'],new Map(),inputs),['BASE-PWR','BASE-PWR-B']);
 assert.deepEqual(affectedGates(root,['tools/rf_lines.py'],new Map(),inputs),['BASE-PWR-B']);
 assert.deepEqual(affectedGates(root,['hardware-design/boards/BASE-PWR/cad/A/A.kicad_pcb'],new Map(),inputs),['BASE-PWR']);
 assert.deepEqual(affectedGates(root,['hardware-design/boards/BASE-PWR/cad/B/B.kicad_pcb'],new Map(),inputs),['BASE-PWR-B']);
 assert.deepEqual(affectedGates(root,['hardware-design/boards/BASE-PWR/gate-waivers.json'],new Map(),inputs),['BASE-PWR']);
 // A board without committed metrics keeps the conservative rule.
 assert.deepEqual(affectedGates(root,['tools/route_live.py'],new Map(),new Map([['BASE-PWR',inputs.get('BASE-PWR')]])),['BASE-PWR-B']);
 const {boards,reasons}=stagedGateMap(root,['tools/si_planes.py','docs/x.md','hardware-design/boards/BASE-PWR/cad/A/A.kicad_pcb'],new Map(),inputs);
 assert.deepEqual(boards,['BASE-PWR','BASE-PWR-B']);
 assert.deepEqual([...reasons],[['tools/si_planes.py',['BASE-PWR','BASE-PWR-B']],['hardware-design/boards/BASE-PWR/cad/A/A.kicad_pcb',['BASE-PWR']]]);
});
