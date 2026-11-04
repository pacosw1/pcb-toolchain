// tools/router/route-dispatch.mjs: the job daemon when it answers, local otherwise. Stand-ins for the daemon's /status,
// the client, run.py, git and the toolchain tree. No network beyond localhost.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,utimesSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import test from 'node:test';

const SCRIPT=new URL('../router/route-dispatch.mjs',import.meta.url).pathname;
const BOARD='hardware-design/boards/DEMO';
const sha=text=>createHash('sha256').update(text).digest('hex');
const put=(file,text,mode)=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text);if(mode)chmodSync(file,mode);};
const exe=(file,text)=>put(file,text,0o755);

// A daemon that answers /status, or nothing on a closed port.
async function daemon(t,status=200){
  const server=createServer((req,res)=>{res.statusCode=status;res.end('{}');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>server.close());
  return`http://127.0.0.1:${server.address().port}`;
}

// The stand-in client plays one job. `job`: the record `status` prints; `out`: files of out/route, by name.
// `queuedMs`, then the job's running line, then `runMs`: the time it waits and the time it runs.
function clientSource(root,{job,exit,out={},stdout='',noId=false,stderr='',hang=false,queuedMs=0,runMs=0}){
  return`import fs from 'node:fs';
const root=${JSON.stringify(root)};
const a=process.argv.slice(2);
fs.appendFileSync(root+'/client.log',JSON.stringify({a,lab:process.env.IOT_LAB,tc:process.env.PCB_TOOLCHAIN_ROOT})+'\\n');
if(a[0]==='cancel')process.exit(0);
if(a[0]==='status'){${job?`console.log(${JSON.stringify(JSON.stringify(job))});process.exit(0);`:'process.exit(1);'}}
const k=f=>a[a.indexOf(f)+1];
const ins=a.flatMap((x,i)=>x==='--in'?[a[i+1]]:[]);
fs.writeFileSync(root+'/inputs.json',JSON.stringify(ins.map(f=>({f,mtime:fs.statSync(f).mtimeMs,mode:fs.statSync(f).mode}))));
${noId?'':`console.error('pcb-job: job J1');`}
${stderr?`console.error(${JSON.stringify(stderr)});`:''}
${queuedMs||runMs?`const pause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
pause(${queuedMs});console.error('[2026-11-04T16:59:08.408Z] running: attempt 1, after 333 s queued');pause(${runMs});`:''}
${hang?'setInterval(()=>{},1000);':`
for(const [n,text] of Object.entries(${JSON.stringify(out)})){
  const f=k('--results')+'/out/route/'+n;fs.mkdirSync(f.slice(0,f.lastIndexOf('/')),{recursive:true});fs.writeFileSync(f,text);
}
process.stdout.write(${JSON.stringify(stdout)});
process.exit(${exit});`}
`;
}

const INPUT='board input';
const record=(status,extra={})=>({schema:'iot-lab.iotroute-run.v1',status,board_file:'/job/out/route/DEMO.kicad_pcb',work:'/job/out/route/DEMO.kicad_pcb.iotroute',
  input:`/job/${BOARD}/DEMO.kicad_pcb`,input_sha256:sha(INPUT),board_sha256:sha('routed'),drc_errors:status==='PASS'?0:1,
  stages:{binary:{path:'/job/in/iotroute-linux-x86_64',how:'explicit'},lock:{source:`/job/${BOARD}/DEMO.kicad_pcb`}},
  notes:['see /job/out/route/DEMO.kicad_pcb.iotroute/route.log'],...extra});
const files=(rec,extra={})=>({'DEMO.kicad_pcb':'routed','DEMO.kicad_pro':'{}','DEMO.kicad_pcb.iotroute/result.json':JSON.stringify(rec),...extra});
const jobOf=(state,outcome,exitCode,attempts=[{outcome}])=>({id:'J1',state,attempts,spec:{image:'iot-lab-route:10.0'},result:{outcome,exitCode,detail:`${outcome} detail`}});

function project(t,{client={exit:0},withBinary=true,sourcesEqual=true,binaryAge=0,pin='a6bba1a0'}={}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'route-dispatch-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const ws=join(root,'ws'),tc=join(root,'tc');
  put(join(ws,BOARD,'DEMO.kicad_pcb'),INPUT);
  for(const r of [ws,tc])put(join(r,'tools/router/core/Cargo.toml'),'x');
  put(join(ws,'tools/router/core/src/main.rs'),'fn main(){}');
  put(join(tc,'tools/router/core/src/main.rs'),sourcesEqual?'fn main(){}':'fn main(){ changed }');
  if(withBinary){
    exe(join(tc,'bin/iotroute-linux-x86_64'),'linux router');
    const when=new Date(Date.now()+binaryAge*1000+1000);utimesSync(join(tc,'bin/iotroute-linux-x86_64'),when,when);
  }
  put(join(ws,'tools/pcb-job/client.ts'),clientSource(root,client));
  put(join(root,'token'),'tok\n');
  mkdirSync(join(root,'happy/.git'),{recursive:true});
  put(join(root,'happy/skills.txt'),'happy');
  exe(join(root,'bin/git'),`#!/bin/sh\necho ${pin}\n`);
  // run.py's stand-in: what the local path runs, exit 5 so that a local run cannot pass as a job.
  exe(join(root,'bin/fake-python'),`#!/bin/sh\necho "$@" > "${root}/local.log"\necho "LOCAL OUT"\nexit 5\n`);
  return{root,ws,tc};
}

function dispatch(p,env={},{args=[],timeout='60',wait=true}={}){
  const out=join(p.ws,'run/router/DEMO.kicad_pcb'),pcb=join(p.ws,BOARD,'DEMO.kicad_pcb');
  const cmd=['fake-python','tools/router/run.py','DEMO',out,'--pcb',pcb,'--json','--iters','5','--lock-from',pcb,...args];
  const child=spawn(process.execPath,[SCRIPT,'--timeout',timeout,'--',...cmd],{cwd:p.ws,stdio:['ignore','pipe','pipe'],
    env:{PCB_HOST_PLATFORM:'linux',PATH:`${join(p.root,'bin')}:${process.env.PATH}`,HOME:p.root,JOBD_TOKEN_FILE:join(p.root,'token'),PCB_TOOLCHAIN_ROOT:p.tc,KICAD_HAPPY_DIR:join(p.root,'happy'),...env}});
  let stdout='',stderr='';
  child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
  const done=new Promise(r=>child.on('close',(status,signal)=>r({status,signal,stdout,stderr,out,record:()=>JSON.parse(readFileSync(out+'.iotroute/result.json','utf8'))})));
  return wait?done:{child,done,get stderr(){return stderr;}};
}
const calls=p=>existsSync(join(p.root,'client.log'))?readFileSync(join(p.root,'client.log'),'utf8').trim().split('\n').map(l=>JSON.parse(l)):[];
const ranLocally=p=>existsSync(join(p.root,'local.log'));

test('a daemon that answers gets the job: workspace tools, Linux router, kicad-happy, relative paths',async t=>{
  const p=project(t,{client:{exit:0,job:jobOf('passed','passed',0),out:files(record('PASS')),stdout:'PASS 0 0 0 1 1 3\n'}});
  const r=await dispatch(p,{JOBD_URL:await daemon(t),IOTROUTE_CONGESTION:'1'});
  assert.equal(r.status,0,r.stderr);
  assert.ok(!ranLocally(p));
  const [{a,lab,tc}]=calls(p);
  assert.deepEqual([a[0],a[1]],['run',BOARD]);
  assert.deepEqual([lab,tc],[p.ws,p.ws]);
  assert.equal(a[a.indexOf('--timeout')+1],'60');
  assert.deepEqual([a[a.indexOf('--cpus')+1],a[a.indexOf('--mem')+1]],['2','4']);
  const inputs=JSON.parse(readFileSync(join(p.root,'inputs.json'),'utf8'));
  assert.deepEqual(inputs.map(i=>i.f.split('/').pop()),['iotroute-linux-x86_64','kicad-happy.tar.gz']);
  assert.ok(inputs[0].mode&0o100);
  const job=a.slice(a.indexOf('--')+1);
  assert.deepEqual(job.slice(0,2),['bash','-c']);
  assert.match(job[2],/KICAD_HAPPY_DIR=\$PWD\/\.happy KICAD_CLI=kicad-cli/);
  assert.match(job[2],/exec python3 "\$@"/);
  assert.deepEqual(job.slice(4),['tools/router/run.py',BOARD,'out/route/DEMO.kicad_pcb','--bin','in/iotroute-linux-x86_64','--iters','5',
    '--pcb',`${BOARD}/DEMO.kicad_pcb`,'--lock-from',`${BOARD}/DEMO.kicad_pcb`,'--congestion']);
});

test('--seed, --stall-passes and --checkpoint stay on the daemon and reach run.py',async t=>{
  const p=project(t,{client:{exit:0,job:jobOf('passed','passed',0),out:files(record('PASS')),stdout:'PASS 0 0 0 1 1 3\n'}});
  const r=await dispatch(p,{JOBD_URL:await daemon(t)},{args:['--seed','7','--stall-passes','12','--checkpoint']});
  assert.equal(r.status,0,r.stderr);
  assert.ok(!ranLocally(p));
  const job=calls(p)[0].a;
  assert.deepEqual(job.slice(job.indexOf('--iters')),['--iters','5','--seed','7','--stall-passes','12','--checkpoint',
    '--pcb',`${BOARD}/DEMO.kicad_pcb`,'--lock-from',`${BOARD}/DEMO.kicad_pcb`]);
});

test('a snapshot source newer than the binary passes run.py: the staged copy gets a new mtime',async t=>{
  const p=project(t,{client:{exit:0,job:jobOf('passed','passed',0),out:files(record('PASS'))}});
  const before=Date.now();
  utimesSync(join(p.ws,'tools/router/core/src/main.rs'),new Date(before),new Date(before));
  const r=await dispatch(p,{JOBD_URL:await daemon(t)});
  assert.equal(r.status,0,r.stderr);
  assert.ok(JSON.parse(readFileSync(join(p.root,'inputs.json'),'utf8'))[0].mtime>=before-1000);
});

test('results come back next to OUT, the record holds local paths, stdout is run.py\'s',async t=>{
  const p=project(t,{client:{exit:0,job:jobOf('passed','passed',0),out:files(record('PASS')),stdout:'PASS 0 0 0 1 1 3\n'}});
  const r=await dispatch(p,{JOBD_URL:await daemon(t)});
  assert.equal(r.status,0,r.stderr);
  assert.equal(readFileSync(r.out,'utf8'),'routed');
  assert.ok(existsSync(join(dirname(r.out),'DEMO.kicad_pro')));
  assert.deepEqual(readdirSync(dirname(r.out)).filter(n=>n.startsWith('.job-')),[]);
  const rec=r.record();
  assert.equal(rec.board_file,r.out);
  assert.equal(rec.work,r.out+'.iotroute');
  assert.equal(rec.input,join(p.ws,BOARD,'DEMO.kicad_pcb'));
  assert.equal(rec.stages.binary.path,join(p.tc,'bin/iotroute-linux-x86_64'));
  assert.equal(rec.stages.lock.source,join(p.ws,BOARD,'DEMO.kicad_pcb'));
  assert.equal(rec.notes[0],`see ${r.out}.iotroute/route.log`);
  assert.doesNotMatch(JSON.stringify(rec),/"\/job|\s\/job/);
  assert.deepEqual([rec.remote.job,rec.remote.platform],['J1','linux-x86_64']);
  const lines=r.stdout.trim().split('\n');
  assert.equal(lines[0],'PASS 0 0 0 1 1 3');
  assert.deepEqual(JSON.parse(lines[1]),rec);
});

for(const [name,status,code,outcome,state] of [['FAIL','FAIL',1,'command','failed'],['no verdict','ERROR',2,'command','failed']])
  test(`run.py's ${name} comes back with its exit code ${code}, and no local run`,async t=>{
    const rec=record(status,status==='ERROR'?{board_sha256:undefined,cause:'iotroute model failed, see /job/out/route/DEMO.kicad_pcb.iotroute/model.log'}:{});
    const p=project(t,{client:{exit:code,job:jobOf(state,outcome,code),out:status==='ERROR'?{'DEMO.kicad_pcb.iotroute/result.json':JSON.stringify(rec)}:files(rec),stdout:`${status} 1 0 0 1 1 3\n`}});
    const r=await dispatch(p,{JOBD_URL:await daemon(t)});
    assert.equal(r.status,code,r.stderr);
    assert.equal(r.record().status,status);
    assert.ok(!ranLocally(p));
    if(status==='ERROR')assert.equal(r.record().cause,`iotroute model failed, see ${r.out}.iotroute/model.log`);
  });

for(const [name,setup,env,args=[]] of [
  ['REMOTE_NO_DAEMON is set',{},{REMOTE_NO_DAEMON:'1'}],
  ['there is no daemon URL',{},{JOBD_URL:''}],
  ['the token file is missing',{},{JOBD_TOKEN_FILE:'/nonexistent/token'}],
  ['the Linux router is missing',{withBinary:false},{}],
  ['the toolchain root is not set',{},{PCB_TOOLCHAIN_ROOT:''}],
  ['the router is older than its sources',{binaryAge:-3600},{}],
  ['the router belongs to other sources',{sourcesEqual:false},{}],
  ['kicad-happy is off its pin',{pin:'deadbeef'},{}],
  ['an option has no daemon form',{},{},['--reuse','prev.kicad_pcb']],
]) test(`local when ${name}: the command runs unchanged and stderr says why`,async t=>{
  const p=project(t,setup);
  const r=await dispatch(p,{JOBD_URL:await daemon(t),...env},{args});
  assert.equal(r.status,5,r.stderr);
  assert.match(r.stdout,/^LOCAL OUT$/m);
  assert.match(r.stderr,/route: local run: \S/);
  assert.match(readFileSync(join(p.root,'local.log'),'utf8'),/^tools\/router\/run\.py DEMO \S+ --pcb \S+ --json --iters 5 --lock-from \S+/);
  assert.deepEqual(calls(p),[]);
});

test('local when the daemon does not answer: a closed port, and an answer that is not 200',async t=>{
  for(const url of ['http://127.0.0.1:9',await daemon(t,401)]){
    const p=project(t);
    const r=await dispatch(p,{JOBD_URL:url});
    assert.equal(r.status,5,r.stderr);
    assert.match(r.stderr,/does not answer/);
    assert.deepEqual(calls(p),[]);
  }
});

test('the project setting above the workspace names the daemon',async t=>{
  const p=project(t,{client:{exit:0,job:jobOf('passed','passed',0),out:files(record('PASS'))}});
  writeFileSync(join(p.root,'.pcb-toolchain.env'),`REMOTE_HOST=x\nJOBD_URL=${await daemon(t)}\n`);
  assert.equal((await dispatch(p)).status,0);
  assert.equal(calls(p).length,2);
});

test('a candidate outside the shipped board folder stays local',async t=>{
  const p=project(t);
  put(join(p.ws,'hardware-design/boards/OTHER/X.kicad_pcb'),INPUT);
  const url=await daemon(t),out=join(p.ws,'run/router/X.kicad_pcb'),pcb=join(p.ws,'hardware-design/boards/OTHER/X.kicad_pcb');
  const child=spawn(process.execPath,[SCRIPT,'--',join(p.root,'bin/fake-python'),'tools/router/run.py','DEMO',out,'--pcb',pcb,'--json'],{cwd:p.ws,
    env:{PCB_HOST_PLATFORM:'linux',PATH:`${join(p.root,'bin')}:${process.env.PATH}`,HOME:p.root,JOBD_URL:url,JOBD_TOKEN_FILE:join(p.root,'token'),PCB_TOOLCHAIN_ROOT:p.tc,KICAD_HAPPY_DIR:join(p.root,'happy')}});
  let stderr='';child.stderr.on('data',d=>stderr+=d);
  const status=await new Promise(r=>child.on('close',r));
  assert.equal(status,5);
  assert.match(stderr,/outside the shipped folder/);
});

// Partway: never a second run, unless the job provably never started.
for(const [name,client,cause] of [
  ['a timeout',{exit:124,job:jobOf('failed','timeout',124)},/job J1 failed: timeout detail/],
  ['out of memory',{exit:137,job:jobOf('failed','oom',137)},/oom detail/],
  ['lost infrastructure after retries',{exit:1,job:jobOf('failed','infra',null)},/infra detail/],
  ['a cancelled job',{exit:130,job:jobOf('cancelled','cancelled',null)},/job J1 cancelled/],
  ['a daemon gone for good',{exit:3},/job J1 goes on/],
  ['no status after the job',{exit:1},/no status for job J1/],
  ['a job still running when the client ended',{exit:1,job:{id:'J1',state:'running',attempts:[{}],spec:{}}},/job J1 running: no result yet, not rerun/],
  ['a passed job without results',{exit:0,job:jobOf('passed','passed',0)},/brought back no result.json/],
  ['a record that disagrees with the exit',{exit:0,job:jobOf('passed','passed',0),out:files(record('FAIL'))},/exited 0 but its record says FAIL/],
  ['a board that is not the record\'s',{exit:0,job:jobOf('passed','passed',0),out:files(record('PASS',{board_sha256:sha('other')}))},/not the board of its record/],
  ['another input than ours',{exit:0,job:jobOf('passed','passed',0),out:files(record('PASS',{input_sha256:sha('other')}))},/routed another input/],
  ['a submit with no answer',{exit:1,noId:true},/no job id: the job may exist/],
  ['HTTP 500 at submit',{exit:2,noId:true,stderr:'pcb-job: 500: internal'},/no job id: the job may exist/],
  ['an attempt that ran before one that could not start',{exit:1,job:jobOf('failed','start',null,[{outcome:'infra'},{outcome:'start'}])},/start detail/],
]) test(`partway, ${name}: exit 2, a cause in result.json, no local run`,async t=>{
  const p=project(t,{client});
  const r=await dispatch(p,{JOBD_URL:await daemon(t)});
  assert.equal(r.status,2,r.stderr);
  assert.ok(!ranLocally(p),'ran locally');
  assert.equal(r.record().status,'ERROR');
  assert.match(r.record().cause,cause);
  assert.match(r.stdout,/^ERROR \d+ /);
  assert.ok(JSON.parse(r.stdout.trim().split('\n')[1]).remote);
});

for(const [name,client] of [
  ['the daemon refused the submit',{exit:2,noId:true,stderr:'pcb-job: 429: queue full'}],
  ['every attempt ended start',{exit:1,job:jobOf('failed','start',null,[{outcome:'start'}])}],
]) test(`partway, ${name}: the job never started, so the run is local on a clean folder`,async t=>{
  const p=project(t,{client});
  const r=await dispatch(p,{JOBD_URL:await daemon(t)});
  assert.equal(r.status,5,r.stderr);
  assert.ok(ranLocally(p));
  assert.ok(!existsSync(r.out+'.iotroute'));
  assert.deepEqual(readdirSync(dirname(r.out)),[]);
});

const HELD='[2026-11-04T16:53:40.000Z] queued for 5 s: host cpu: 90 % busy, job adds 25 %, limit 95 %';
const QUEUE_CAUSE='queued for 300 s: host cpu: 90 % busy, job adds 25 %, limit 95 %';
const queueFailed={id:'J1',state:'failed',attempts:[],spec:{image:'iot-lab-route:10.0'},result:{outcome:'queue',exitCode:null,detail:QUEUE_CAUSE}};

test('the job gets the queue bound: 300 s, or PCB_QUEUE_WAIT_S',async t=>{
  const after=(c,k)=>c.a[c.a.indexOf(k)+1];
  for(const [env,want] of [[{},'300'],[{PCB_QUEUE_WAIT_S:'45'},'45']]){
    const p=project(t,{client:{exit:0,job:jobOf('passed','passed',0),out:files(record('PASS'))}});
    await dispatch(p,{JOBD_URL:await daemon(t),...env});
    assert.equal(after(calls(p)[0],'--queue-wait'),want);
  }
});

test('the default bound is the one tools/pcb_cli.py credits',()=>{
  const number=(file,re)=>re.exec(readFileSync(new URL(file,import.meta.url),'utf8'))?.[1];
  const node=number('../router/route-dispatch.mjs',/^const QUEUE_WAIT_S=(\d+);/m);
  assert.ok(node);
  assert.equal(number('../pcb_cli.py',/^QUEUE_WAIT_S = (\d+)/m),node);
});

test('macOS: a run the daemon cannot take stops with no verdict and never runs locally',async t=>{
  const p=project(t);
  const r=await dispatch(p,{JOBD_URL:'',PCB_HOST_PLATFORM:'darwin'});
  assert.equal(r.status,2,r.stderr);
  assert.ok(!ranLocally(p));
  assert.match(r.stderr,/route: no run: no JOBD_URL\. This Mac does not route locally/);
  assert.match(r.stdout,/^ERROR 0 no run: no JOBD_URL$/m);
});

test('macOS: a job that never started stops with no verdict and never runs locally',async t=>{
  const p=project(t,{client:{exit:75,job:queueFailed,stderr:HELD}});
  const r=await dispatch(p,{JOBD_URL:await daemon(t),PCB_HOST_PLATFORM:'darwin'});
  assert.equal(r.status,2,r.stderr);
  assert.ok(!ranLocally(p));
  assert.match(r.stderr,/route: no run: the job never started/);
});

test('macOS: REMOTE_NO_DAEMON=1 asks for the local run',async t=>{
  const p=project(t);
  const r=await dispatch(p,{JOBD_URL:await daemon(t),REMOTE_NO_DAEMON:'1',PCB_HOST_PLATFORM:'darwin'});
  assert.equal(r.status,5,r.stderr);
  assert.ok(ranLocally(p));
});

test('a job the daemon gave up on in the queue never started: the run is local, and says why',async t=>{
  const p=project(t,{client:{exit:75,job:queueFailed,stderr:HELD}});
  const r=await dispatch(p,{JOBD_URL:await daemon(t)});
  assert.equal(r.status,5,r.stderr);
  assert.ok(ranLocally(p));
  assert.match(r.stderr,/queued for 5 s: host cpu: 90 % busy/,'the client\'s hold lines reach the user');
  assert.match(r.stderr,/route: job J1 never started: queued for 300 s: host cpu/);
  assert.deepEqual(readdirSync(dirname(r.out)),[]);
});

test('an attempt on record is not a queue timeout: no local run',async t=>{
  const p=project(t,{client:{exit:1,job:{...queueFailed,attempts:[{outcome:'infra'}]}}});
  const r=await dispatch(p,{JOBD_URL:await daemon(t)});
  assert.equal(r.status,2);
  assert.ok(!ranLocally(p));
});

test('the queue clock counts from the job id to the running line, and stops there',async t=>{
  const p=project(t,{client:{exit:0,job:jobOf('passed','passed',0),out:files(record('PASS')),queuedMs:1300,runMs:1500}});
  const clock=join(p.root,'run/operation/queue-wait.json');
  const r=await dispatch(p,{JOBD_URL:await daemon(t),PCB_QUEUE_CLOCK:clock});
  assert.equal(r.status,0,r.stderr);
  const {seconds}=JSON.parse(readFileSync(clock,'utf8'));
  assert.ok(seconds>=1.2&&seconds<2.5,String(seconds));
  assert.deepEqual(readdirSync(dirname(clock)),['queue-wait.json']);
});

test('the clock moves while the job waits, so a run deadline cannot pass it by',async t=>{
  const p=project(t,{client:{hang:true}});
  const clock=join(p.root,'run/operation/queue-wait.json');
  const run=dispatch(p,{JOBD_URL:await daemon(t),PCB_QUEUE_CLOCK:clock},{wait:false});
  for(let i=0;i<300&&!existsSync(clock);i++)await new Promise(r=>setTimeout(r,20));
  t.after(()=>run.child.kill('SIGKILL'));
  const first=JSON.parse(readFileSync(clock,'utf8')).seconds;
  await new Promise(r=>setTimeout(r,1300));
  assert.ok(JSON.parse(readFileSync(clock,'utf8')).seconds>first);
  run.child.kill('SIGTERM');
  await run.done;
});

test('a job the daemon ended in the queue stops the clock at the bound, and the local run keeps it',async t=>{
  const p=project(t,{client:{exit:75,job:queueFailed,stderr:'[t] failed: '+QUEUE_CAUSE}});
  const clock=join(p.root,'run/operation/queue-wait.json');
  const r=await dispatch(p,{JOBD_URL:await daemon(t),PCB_QUEUE_CLOCK:clock});
  assert.equal(r.status,5,r.stderr);
  assert.ok(existsSync(clock));
});

test('SIGTERM cancels the job',async t=>{
  const p=project(t,{client:{hang:true}});
  const run=dispatch(p,{JOBD_URL:await daemon(t)},{wait:false});
  while(!run.stderr.includes('pcb-job: job J1'))await new Promise(r=>setTimeout(r,20));
  run.child.kill('SIGTERM');
  const r=await run.done;
  assert.equal(r.status,143);
  assert.ok(calls(p).some(c=>c.a[0]==='cancel'&&c.a[1]==='J1'));
});
