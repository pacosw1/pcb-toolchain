import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runDirectory,runTool,readReport,checkedText,readHappyResult} from './gate-runtime.mjs';
test('old clean reports cannot rescue a failed invocation',async t=>{
 const root=mkdtempSync(join(tmpdir(),'gate-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(join(root,'drc.json'),JSON.stringify({violations:[],schematic_parity:[],unconnected_items:[]}));
 const dir=runDirectory(root);const failed=await runTool(dir,'drc',process.execPath,['-e','process.exit(2)']);
 assert.equal(readReport(join(root,'drc.json'),'drc',failed),null);assert.equal(readReport(join(dir,'drc.json'),'drc',{code:0}),null);
});
test('concurrent invocations have independent reports and logs',async t=>{
 const root=mkdtempSync(join(tmpdir(),'gate-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const dirs=[runDirectory(root),runDirectory(root)];assert.notEqual(...dirs);
 await Promise.all(dirs.map((d,i)=>runTool(d,'drc',process.execPath,['-e',`console.log(${i})`])));
 dirs.forEach((d,i)=>assert.match(readFileSync(join(d,'drc.log'),'utf8'),new RegExp(`^${i}`)));
});
test('tool output and events are observable before process exit',async t=>{
 const root=mkdtempSync(join(tmpdir(),'gate-live-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const release=join(root,'release');
 const work=runTool(root,'live',process.execPath,['-e',`const fs=require('node:fs'); console.log('live evidence'); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);process.exit(0)}},10);setTimeout(()=>process.exit(2),3000)`]);
 try {
  const deadline=Date.now()+2000;
  while((!existsSync(join(root,'live.log')) || !readFileSync(join(root,'live.log'),'utf8').includes('live evidence')) && Date.now()<deadline) await new Promise(r=>setTimeout(r,10));
  assert.match(readFileSync(join(root,'live.log'),'utf8'),/live evidence/);
  const rows=readFileSync(join(root,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.some(r=>r.type==='tool.output' && r.text.includes('live evidence')));
  assert.ok(!rows.some(r=>r.type==='tool.exit'));
 } finally {writeFileSync(release,'release');}
 assert.equal((await work).code,0);
});
test('streamed stderr is recorded once and preserves checker results',async t=>{
 const root=mkdtempSync(join(tmpdir(),'gate-streams-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const result=await runTool(root,'failure',process.execPath,['-e',"process.stdout.write('partial count\\n');process.stderr.write('checker diagnostic\\n');process.exit(2)"]);
 assert.deepEqual(result,{stdout:'partial count\n',stderr:'checker diagnostic\n',code:2});
 const log=readFileSync(join(root,'failure.log'),'utf8');
 assert.equal(log.split('checker diagnostic').length-1,1);
 assert.match(log,/\[exit 2\]/);
});
test('malformed and incomplete KiCad JSON fail; complete reports pass',t=>{
 const root=mkdtempSync(join(tmpdir(),'gate-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const p=join(root,'report.json');
 for(const content of ['{','{}','{"violations":[]}']) {writeFileSync(p,content);assert.equal(readReport(p,'drc',{code:0}),null);}
 writeFileSync(p,JSON.stringify({violations:[],schematic_parity:[],unconnected_items:[]}));assert.ok(readReport(p,'drc',{code:0}));
 writeFileSync(p,JSON.stringify({sheets:[{violations:[]}]}));assert.ok(readReport(p,'erc',{code:0}));
});
test('text count emitted before tool crash cannot pass',()=>{
 assert.equal(checkedText({code:2,stdout:'0 vias in SMD pads',stderr:''}),'');assert.equal(checkedText({code:1,stdout:'0 vias in SMD pads',stderr:'Traceback'}),'');
 assert.match(checkedText({code:1,stdout:'3 vias in SMD pads',stderr:''}),/gate-check-exit:1/);
});
test('happy completion distinguishes stale exemptions from a checker failure',t=>{
 const root=mkdtempSync(join(tmpdir(),'gate-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const p=join(root,'happy.json');
 writeFileSync(p,JSON.stringify({schema_version:1,completed:true,findings:23,stale_exemptions:16,exit:2}));
 assert.equal(readHappyResult(p,{code:2}),39);
 assert.equal(readHappyResult(p,{code:0}),null);
 writeFileSync(p,'{}');assert.equal(readHappyResult(p,{code:2}),null);
 writeFileSync(p,JSON.stringify({schema_version:1,completed:true,findings:-1,stale_exemptions:0,exit:0}));assert.equal(readHappyResult(p,{code:0}),null);
});
