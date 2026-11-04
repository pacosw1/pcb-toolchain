// The run deadline of `pcb`: time a job spent in the daemon's queue is not the run's own. The real supervisor
// (tools/pcb _worker) over a stand-in operation. The stand-in plays route-dispatch: it writes the queue clock.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

const PCB=new URL('../pcb',import.meta.url).pathname;
const ROOT=new URL('../..',import.meta.url).pathname;

const STANDIN=`import fs from 'node:fs';
const [folder,queued,runMs]=process.argv.slice(2);
fs.writeFileSync(folder+'/seen.json',JSON.stringify({clock:process.env.PCB_QUEUE_CLOCK??null,wait:process.env.PCB_QUEUE_WAIT_S??null,
  deadline:process.env.IOT_LEAN_DEADLINE,at:Date.now()}));
if(queued!=='0'&&process.env.PCB_QUEUE_CLOCK)fs.writeFileSync(process.env.PCB_QUEUE_CLOCK,queued==='broken'?'{"seconds"':JSON.stringify({seconds:Number(queued)}));
setTimeout(()=>{
  fs.writeFileSync(folder+'/operation/result.json',JSON.stringify({status:'passed',exit_code:0,cause:'stand-in'}));
  process.exit(0);
},Number(runMs));`;

function supervise(t,{router='iotroute',timeout=1,queued=0,runMs=2000,wait}={}){
  const base=realpathSync(mkdtempSync(join(tmpdir(),'pcb-queue-')));
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  const folder=join(base,'run-x');
  mkdirSync(join(folder,'operation'),{recursive:true});
  writeFileSync(join(base,'standin.mjs'),STANDIN);
  writeFileSync(join(folder,'run.json'),JSON.stringify({schema_version:1,run_id:'run-x',board:'X',project:'cad/X',root:ROOT,timeout_s:timeout,
    heartbeat_s:60,operation:'route',router,node:process.execPath,command:[process.execPath,join(base,'standin.mjs'),folder,String(queued),String(runMs)]}));
  writeFileSync(join(folder,'state.json'),JSON.stringify({schema_version:1,run_id:'run-x',board:'X',status:'starting',seq:0,elapsed_s:0,active_stages:[]}));
  const env={...process.env};delete env.IOT_LEAN_DEADLINE;delete env.PCB_QUEUE_WAIT_S;
  if(wait!==undefined)env.PCB_QUEUE_WAIT_S=String(wait);
  const r=spawnSync('python3',[PCB,'_worker','run-x','--runs-dir',base],{encoding:'utf8',env,cwd:ROOT,timeout:30000});
  assert.equal(r.error,undefined);
  const read=name=>JSON.parse(readFileSync(join(folder,name),'utf8'));
  return{result:read('result.json'),seen:read('seen.json'),folder};
}

test('no queue wait: the deadline holds as before',t=>{
  assert.equal(supervise(t).result.status,'timeout');
});

test('a queue wait moves the run deadline by that wait',t=>{
  assert.equal(supervise(t,{queued:3}).result.status,'passed');
});

test('the credit is capped at the queue bound, so the run stays bounded',t=>{
  assert.equal(supervise(t,{queued:1e9,wait:0.1}).result.status,'timeout');
});

test('only an iotroute run has a queue: another router gets no clock and no credit',t=>{
  const {result,seen}=supervise(t,{router:'fastroute',queued:3});
  assert.equal(result.status,'timeout');
  assert.equal(seen.clock,null);
});

test('the run tells route-dispatch where the clock goes and what the bound is',t=>{
  const {seen,folder}=supervise(t,{runMs:0});
  assert.equal(seen.clock,join(folder,'operation/queue-wait.json'));
  assert.equal(seen.wait,'300');
});

test('children see the deadline with the bound added: a stage after a long wait must not read it as spent',t=>{
  const left=({deadline,at})=>Number(deadline.split(':').pop())-at/1000;
  const plain=supervise(t,{router:'fastroute',runMs:0}).seen,routed=supervise(t,{wait:7,runMs:0}).seen;
  assert.ok(Math.abs(left(routed)-left(plain)-7)<1,`${left(routed)} ${left(plain)}`);
});

test('a broken clock file is no credit, not a crash',t=>{
  assert.equal(supervise(t,{queued:'broken'}).result.status,'timeout');
});
