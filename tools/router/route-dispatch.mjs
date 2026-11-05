#!/usr/bin/env node
// tools/router/run.py on the job daemon. The candidate's verdict stays the gate on the Mac.
//
// A run the daemon cannot take stops on macOS with exit 2 and says why: a route is Python, and it does not start on the Mac
// by surprise (a local route there ran for minutes unnoticed, 2026-11-04). REMOTE_NO_DAEMON=1 asks for it. Elsewhere, on a
// Linux host or in CI, the run is local as before. Below, "local" means that case.
//
//   node tools/router/route-dispatch.mjs [--timeout S] -- PYTHON tools/router/run.py BOARD OUT --pcb IN [run.py options]
//
// Run from the workspace that holds tools/ and hardware-design/. The local path runs the command unchanged.
//
// The daemon path needs what tools/remote.sh needs (REMOTE_NO_DAEMON not 1, JOBD_URL from the environment or
// .pcb-toolchain.env, a readable token, a client, /status within 3 s) and also: bin/iotroute-linux-x86_64 under
// PCB_TOOLCHAIN_ROOT built from these core sources, kicad-happy at its pin, and the input boards in the shipped board
// folder. When one is missing the run is local and stderr says why. The job gets the workspace's own tools/ and board.
//
// Exit: run.py's. 0 PASS, 1 FAIL, 2 no verdict, also for what only the daemon can do: timeout, out of memory, lost job.
//
// A daemon failure partway. A job that may have run is never run again here, because the same route would run twice:
// after an unclear submit, a lost connection, a timeout or a lost result the exit is 2 and result.json names the job.
// Local runs only when the job provably never started: the daemon refused the submit, the submit never left this Mac
// (client exit 2 and no job id, except HTTP 500, which may come after the record), every attempt ended `start`, or the
// job reached its queue bound (PCB_QUEUE_WAIT_S). The daemon ends that job itself, so no start can race the local run.
//
// The wait does not spend the run's time. --timeout starts when the job runs, and under `pcb` the seconds spent queued
// go to PCB_QUEUE_CLOCK, which the supervisor adds to the run deadline (tools/pcb_cli.py). A local run after the bound
// therefore still has its whole budget.
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pinnedRepos} from '../lib/env.mjs';

const BIN='iotroute-linux-x86_64';
const HAPPY='kicad-happy';
const RECORD_SCHEMA='iot-lab.iotroute-run.v1';
const DEFAULT_TIMEOUT_S=600;   // tools/pcb's --timeout default
const CANCEL_MS=1500;          // lean_owned sends SIGKILL 2 s after SIGTERM
// To tune. A wait this long has a good chance to end: 90 % of the host's busy spells were over in 210 s (guard log,
// 17 days to 2026-11-04), and the local run is there. tools/pcb_cli.py has the same number; a test keeps them equal.
const QUEUE_WAIT_S=300;
const QUEUE_CLOCK_MS=1000;     // how far the credit may lag; the supervisor checks 10 times a second
// To tune. What a route job reserves; without these it takes the daemon default of 8 CPUs and 8 GB. The core is one thread;
// DRC uses about 3 cores for a few seconds. Largest board (MC-MAIN, 2026-11-04): whole route on the Mac peaks at 2.8 GB in one
// process; refill and DRC on Linux at 2 CPUs and 4 GB peak at 0.45 GB. A live core on H7-CORE held 0.6 GB.
const ROUTE_CPUS=2;
const ROUTE_MEM_GB=4;
const VALUE_OPTIONS=new Set(['--iters','--max-time','--seed','--stall-passes']);
const FLAGS=new Set(['--congestion','--return-exempt','--checkpoint']);
const FILE_OPTIONS=new Set(['--pcb','--lock-from']);
// The image has no kicad-happy, and run.py's KICAD_CLI default is the Mac path.
const JOB_SCRIPT=`set -e
mkdir .happy
tar -xzf in/${HAPPY}.tar.gz -C .happy
export KICAD_HAPPY_DIR=$PWD/.happy KICAD_CLI=kicad-cli
exec python3 "$@"`;

const say=text=>console.error(`route: ${text}`);
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const isFile=file=>fs.statSync(file,{throwIfNoEntry:false})?.isFile()??false;
const isDir=dir=>fs.statSync(dir,{throwIfNoEntry:false})?.isDirectory()??false;
const inside=(rel)=>rel&&!rel.startsWith('..')&&!path.isAbsolute(rel);

/** PCB_HOST_PLATFORM: what the tests pass, so they cover macOS on a Linux runner. */
const localAllowed=()=>process.env.REMOTE_NO_DAEMON==='1'||(process.env.PCB_HOST_PLATFORM??process.platform)!=='darwin';

function localOrStop(command,why){
  if(localAllowed()){say(`local run: ${why}`);return runLocal(command);}
  say(`no run: ${why}. This Mac does not route locally; REMOTE_NO_DAEMON=1 asks for it.`);
  console.log(`ERROR 0 no run: ${why}`);
  return 2;
}

function runLocal(command){
  return new Promise(resolve=>{
    const child=spawn(command[0],command.slice(1),{stdio:'inherit'});
    child.on('error',e=>{say(`cannot start ${command[0]}: ${e.message}`);resolve(2);});
    child.on('close',(code,signal)=>resolve(code??128+os.constants.signals[signal]));
  });
}

/** The project setting, from .pcb-toolchain.env in this folder or above: a run's workspace sits below the project. */
function projectSetting(key){
  for(let dir=process.cwd();;dir=path.dirname(dir)){
    const file=path.join(dir,'.pcb-toolchain.env');
    if(isFile(file))return fs.readFileSync(file,'utf8').split('\n').filter(l=>l.startsWith(key+'=')).at(-1)?.slice(key.length+1)??'';
    if(dir===path.dirname(dir))return'';
  }
}

/** run.py's arguments as job arguments -> {board, out, pcb, json, args}, or a string: why they stay local. */
function jobArguments(argv,cwd){
  const positional=[],args=[],files={};
  let json=false;
  for(let i=0;i<argv.length;i++){
    const a=argv[i];
    if(a==='--json')json=true;
    else if(FLAGS.has(a))args.push(a);
    else if(VALUE_OPTIONS.has(a))args.push(a,argv[++i]);
    else if(FILE_OPTIONS.has(a))files[a]=argv[++i];
    else if(a.startsWith('-'))return`${a} is not sent to the daemon`;
    else positional.push(a);
  }
  if(positional.length!==2)return'BOARD and OUT are not plain arguments';
  if(!files['--pcb'])return'no --pcb input';
  const [board,outArg]=positional;
  const boardDir=path.relative(cwd,path.resolve(isDir(board)?board:path.join('hardware-design/boards',board)));
  if(!inside(boardDir)||!isDir(boardDir))return`board folder ${boardDir} is not in the workspace`;
  for(const [option,file] of Object.entries(files)){
    if(!isFile(file))return`${option} ${file} is not a file`;
    const rel=path.relative(path.join(cwd,boardDir),fs.realpathSync(file));
    // BASE-PWR-B and -C: the project sits in another board's folder and the client ships one folder.
    if(!inside(rel))return`${option} ${file} is outside the shipped folder ${boardDir}`;
    args.push(option,path.join(boardDir,rel));
  }
  const out=path.resolve(outArg);
  if(fs.existsSync(out)||fs.existsSync(out+'.iotroute'))return'OUT or its work folder exists';
  if(process.env.IOTROUTE_CONGESTION==='1'&&!args.includes('--congestion'))args.push('--congestion');
  return{board:boardDir,out,pcb:path.resolve(files['--pcb']),json,args};
}

function coreSources(root){
  const core=path.join(root,'tools/router/core');
  const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);
  return['Cargo.toml','Cargo.lock'].map(n=>path.join(core,n)).filter(isFile).concat(isDir(path.join(core,'src'))?walk(path.join(core,'src')):[]).map(f=>path.relative(core,f));
}

/**
 * Why this binary cannot route these sources, or null. run.py --bin compares mtimes, which mean nothing in a snapshot
 * (its copies are all new). So: run.py's rule against the toolchain tree, and the snapshot's core equal to that tree.
 */
function binaryProblem(toolchain,cwd,bin){
  if(!isFile(bin))return`no Linux router at ${bin}`;
  const sources=coreSources(toolchain),here=coreSources(cwd);
  if(!sources.length)return`no router core sources under ${toolchain}`;
  const core=root=>path.join(root,'tools/router/core');
  const differs=sources.find(f=>!isFile(path.join(core(cwd),f))||sha(path.join(core(cwd),f))!==sha(path.join(core(toolchain),f)))??here.find(f=>!sources.includes(f));
  if(differs)return`the workspace's router core differs from ${bin}'s sources (${differs})`;
  const newest=sources.reduce((a,f)=>Math.max(a,fs.statSync(path.join(core(toolchain),f)).mtimeMs),0);
  if(fs.statSync(bin).mtimeMs<newest)return`${bin} is older than its sources: rebuild it`;
  return null;
}

/** Why kicad-happy cannot ship, or null. Its .git goes along: tools/kicad_happy_gate.py check_pinned reads HEAD. */
function happyProblem(repo){
  if(!repo?.dir||!isDir(path.join(repo.dir,'.git')))return`no ${HAPPY} checkout at ${repo?.dir}`;
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_')));
  const head=spawnSync('git',['-C',repo.dir,'rev-parse','HEAD'],{encoding:'utf8',env}).stdout?.trim()??'';
  return head.startsWith(repo.commit)?null:`${HAPPY} at ${repo.dir} is at ${head.slice(0,12)||'no commit'}, not the pinned ${repo.commit}`;
}

async function daemonAnswers(url,tokenFile){
  try{
    const headers={authorization:`Bearer ${fs.readFileSync(tokenFile,'utf8').trim()}`};
    return(await fetch(`${url.replace(/\/$/,'')}/status`,{headers,signal:AbortSignal.timeout(3000)})).ok;
  }catch{return false;}
}

/** Everything a daemon run needs, or a string: why this run stays local. */
async function daemonPlan(command){
  if(process.env.REMOTE_NO_DAEMON==='1')return'REMOTE_NO_DAEMON=1';
  const url=process.env.JOBD_URL||projectSetting('JOBD_URL');
  if(!url)return'no JOBD_URL';
  const tokenFile=process.env.JOBD_TOKEN_FILE||path.join(os.homedir(),'.config/pcb-job/token');
  try{fs.accessSync(tokenFile,fs.constants.R_OK);}catch{return`no readable token at ${tokenFile}`;}
  const cwd=process.cwd(),toolchain=process.env.PCB_TOOLCHAIN_ROOT;
  if(!toolchain)return'PCB_TOOLCHAIN_ROOT is not set: no Linux router to ship';
  const client=[path.join(cwd,'tools/pcb-job/client.ts'),path.join(toolchain,'tools/pcb-job/client.ts'),path.join(toolchain,'apps/job-daemon/src/client.ts')].find(isFile);
  if(!client)return'no job client';
  const job=jobArguments(command.slice(2),cwd);
  if(typeof job==='string')return job;
  const bin=path.join(toolchain,'bin',BIN),repo=pinnedRepos.find(r=>r.name===HAPPY);
  const problem=binaryProblem(toolchain,cwd,bin)??happyProblem(repo);
  if(problem)return problem;
  if(!await daemonAnswers(url,tokenFile))return`the daemon at ${url} does not answer`;
  return{...job,url,tokenFile,cwd,client,bin,happy:repo.dir,happyCommit:repo.commit,started:Date.now()};
}

function clientProcess(plan,args,stdio){
  const env={...process.env,JOBD_URL:plan.url,JOBD_TOKEN_FILE:plan.tokenFile,IOT_LAB:plan.cwd,PCB_TOOLCHAIN_ROOT:plan.cwd};
  return[process.execPath,['--no-warnings','--experimental-strip-types',plan.client,...args],{env,stdio}];
}

/** The binary and the kicad-happy tar for --in. The binary's new mtime passes run.py's check; binaryProblem did the real one. */
function stageInputs(plan,stage){
  const bin=path.join(stage,BIN),tar=path.join(stage,`${HAPPY}.tar.gz`);
  fs.copyFileSync(plan.bin,bin);
  const now=new Date();fs.utimesSync(bin,now,now);
  fs.copyFileSync(happyTar(plan),tar);
  return[bin,tar];
}

/** One tar per pinned commit: a tar made again differs in its gzip time, so its hash misses the daemon's file cache. */
function happyTar(plan){
  const dir=path.join(process.env.XDG_CACHE_HOME||path.join(os.homedir(),'.cache'),'pcb-toolchain');
  const file=path.join(dir,`${HAPPY}-${plan.happyCommit}.tar.gz`);
  if(isFile(file))return file;
  fs.mkdirSync(dir,{recursive:true});
  const tmp=`${file}.${process.pid}`;
  const r=spawnSync('tar',['--no-xattrs','-czf',tmp,'-C',plan.happy,'.'],{env:{...process.env,COPYFILE_DISABLE:'1'},stdio:['ignore','ignore','inherit']});
  if(r.status!==0)throw Error(`tar of ${plan.happy} failed`);
  fs.renameSync(tmp,file);
  return file;
}

/**
 * Seconds in the daemon's queue, for the run deadline: from the job id to its first state past `queued`. The file is
 * replaced whole, because the supervisor reads it at any moment, and every second, because it must stay ahead of the
 * deadline while the job waits.
 */
function queueClock(file){
  let since=0,timer=null;
  const write=()=>{
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file+'.tmp',JSON.stringify({seconds:(Date.now()-since)/1000}));
    fs.renameSync(file+'.tmp',file);
  };
  return{
    start(){if(!file||since)return;since=Date.now();write();timer=setInterval(write,QUEUE_CLOCK_MS);},
    stop(){if(!timer)return;clearInterval(timer);timer=null;write();},
  };
}

/** `client run`: streams the job to stderr, fills `results`. -> {code, id, refused500, stdout}. */
function submitAndWatch(plan,inputs,timeoutS,results){
  const name=path.basename(plan.out,'.kicad_pcb');
  const jobScript=process.env.PCB_LIVE_ROUTE_FILE ? JOB_SCRIPT.replace('exec python3', 'export IOTROUTE_LIVE_FILE=/job/out/live-route.json\nexec python3') : JOB_SCRIPT;
  const cmd=['bash','-c',jobScript,'_','tools/router/run.py',plan.board,`out/route/${name}.kicad_pcb`,'--bin',`in/${BIN}`,...plan.args];
  const queueWait=process.env.PCB_QUEUE_WAIT_S||String(QUEUE_WAIT_S);
  const args=['run',plan.board,...inputs.flatMap(f=>['--in',f]),'--timeout',String(timeoutS),'--cpus',String(ROUTE_CPUS),'--mem',String(ROUTE_MEM_GB),'--queue-wait',queueWait,'--results',results,'--name',`route-${name}`];
  if(process.env.REMOTE_IMAGE)args.push('--image',process.env.REMOTE_IMAGE);
  const [exe,argv,opts]=clientProcess(plan,[...args,'--',...cmd],['ignore','pipe','pipe']);
  return new Promise(resolve=>{
    const child=spawn(exe,argv,opts),seen={id:null,stdout:'',stderr:''},clock=queueClock(process.env.PCB_QUEUE_CLOCK);
    const preview=process.env.PCB_LIVE_ROUTE_FILE;
    let pulling=false,lastHash='',lastBaseHash='',timer=null,bound=false;
    const pull=async()=>{
      if(!preview||!seen.id||pulling)return;
      pulling=true;
      try{
        // Bind the durable remote job to its originating live run so the coordinator can continue
        // publishing progress even if this client disconnects. The index appears once the guard knows the run ID.
        if(!bound&&process.env.PCB_LIVE_SOURCE&&process.env.PCB_LIVE_HOST&&process.env.PCB_LIVE_BOARD&&process.env.PCB_LIVE_COORDINATOR&&process.env.PCB_LIVE_TOKEN_FILE){
          try{
            const index=JSON.parse(fs.readFileSync(path.join(path.dirname(preview),'run.json'),'utf8'));
            if(typeof index.runId==='string'){
              const token=fs.readFileSync(process.env.PCB_LIVE_TOKEN_FILE,'utf8').trim();
              const response=await fetch(`${process.env.PCB_LIVE_COORDINATOR}/live/events`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},
                body:JSON.stringify({source:process.env.PCB_LIVE_SOURCE,eventId:`job-binding:${seen.id}`,host:process.env.PCB_LIVE_HOST,board:process.env.PCB_LIVE_BOARD,run:index.runId,kind:'job.binding',data:{jobId:seen.id}}),signal:AbortSignal.timeout(4000),redirect:'error'});
              bound=response.ok;
            }
          }catch{/* retry without changing the job */}
        }
        const token=fs.readFileSync(plan.tokenFile,'utf8').trim();
        const base=await fetch(`${plan.url}/jobs/${encodeURIComponent(seen.id)}/live?kind=route-base`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(4000),redirect:'error'});
        if(base.ok){
          const bytes=Buffer.from(await base.arrayBuffer());
          if(bytes.length<=20*1024*1024){
            const digest=createHash('sha256').update(bytes).digest('hex');
            if(digest!==lastBaseHash){
              const dest=path.join(path.dirname(preview),'live-route-base.kicad_pcb');
              fs.writeFileSync(`${dest}.tmp`,bytes);fs.renameSync(`${dest}.tmp`,dest);lastBaseHash=digest;
            }
          }
        }
        const response=await fetch(`${plan.url}/jobs/${encodeURIComponent(seen.id)}/live`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(4000),redirect:'error'});
        if(!response.ok)return;
        const bytes=Buffer.from(await response.arrayBuffer());
        if(bytes.length>20*1024*1024)return;
        const digest=createHash('sha256').update(bytes).digest('hex');
        if(digest===lastHash)return;
        const data=JSON.parse(bytes.toString('utf8'));
        if(data.schema!=='iot-lab.route-preview.v1')return;
        const tmp=`${preview}.tmp`;
        fs.writeFileSync(tmp,bytes);fs.renameSync(tmp,preview);lastHash=digest;
      }catch{/* preview is best effort; routing and its verdict do not depend on it */}
      finally{pulling=false;}
    };
    if(preview)timer=setInterval(pull,2000);
    child.stdout.on('data',d=>{seen.stdout+=d;process.stderr.write(d);});
    child.stderr.on('data',d=>{
      seen.stderr+=d;process.stderr.write(d);
      seen.id??=seen.stderr.match(/^pcb-job: job (\S+)$/m)?.[1]??null;
      if(seen.id){clock.start();void pull();}
      if(/^\[\S+\] (running|passed|failed|cancelled): /m.test(seen.stderr))clock.stop();
    });
    // A stopped `pcb route` must not leave its job holding the budget until the job's own time limit.
    for(const [signal,number] of [['SIGTERM',15],['SIGINT',2]])process.on(signal,()=>{
      if(seen.id){const [e,a,o]=clientProcess(plan,['cancel',seen.id],'ignore');spawnSync(e,a,{...o,timeout:CANCEL_MS});}
      child.kill();process.exit(128+number);
    });
    child.on('error',e=>{if(timer)clearInterval(timer);say(`cannot start the client: ${e.message}`);resolve({code:1,...seen});});
    child.on('close',code=>{if(timer)clearInterval(timer);clock.stop();resolve({code,...seen});});
  });
}

function jobRecord(plan,id){
  const [exe,argv,opts]=clientProcess(plan,['status',id],['ignore','pipe','inherit']);
  const r=spawnSync(exe,argv,{...opts,encoding:'utf8'});
  try{return r.status===0?JSON.parse(r.stdout):null;}catch{return null;}
}

/** Job paths in a string or a JSON value -> local ones. `map` is ordered [job path, local path]. */
function localPaths(value,map){
  if(typeof value==='string')return map.reduce((text,[from,to])=>text.replace(new RegExp(`(?<![\\w./-])${from.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?![\\w-])`,'g'),()=>to),value);
  if(Array.isArray(value))return value.map(v=>localPaths(v,map));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,localPaths(v,map)]));
  return value;
}

function remoteFacts(plan,id,job){
  return{url:plan.url,job:id,state:job?.state??null,outcome:job?.result?.outcome??null,exit_code:job?.result?.exitCode??null,
    attempts:job?.attempts?.length??null,image:job?.spec?.image??null,platform:'linux-x86_64'};
}

function report(plan,record,line,code){
  fs.mkdirSync(record.work,{recursive:true});
  fs.writeFileSync(path.join(record.work,'result.json'),JSON.stringify(record,null,1));
  console.log(line);
  if(plan.json)console.log(JSON.stringify(record));
  return code;
}

function noVerdict(plan,cause,id,job){
  say(cause);
  const seconds=Math.round((Date.now()-plan.started)/100)/10;
  const record={schema:RECORD_SCHEMA,status:'ERROR',board_file:plan.out,work:plan.out+'.iotroute',stages:{},drc_errors:null,
    unconnected:null,parity:null,tracks:null,vias:null,cause,seconds,remote:remoteFacts(plan,id,job)};
  return report(plan,record,`ERROR ${seconds.toFixed(0)} ${cause}`,2);
}

/** The job's folder, moved next to OUT and read back with local paths. Its exit code and its record must agree. */
function adopt(plan,results,id,job,stdout){
  const code=job.result.exitCode,want={0:'PASS',1:'FAIL',2:'ERROR'}[code];
  const from=path.join(results,'out/route');
  const name=path.basename(plan.out);
  if(!isFile(path.join(from,`${name}.iotroute/result.json`)))return noVerdict(plan,`job ${id} (exit ${code}) brought back no result.json`,id,job);
  fs.cpSync(from,path.dirname(plan.out),{recursive:true});
  const map=[[`/job/out/route/${name}`,plan.out],['/job/out/route',path.dirname(plan.out)],[`/job/in/${BIN}`,plan.bin],['/job/.happy',plan.happy],['/job',plan.cwd]];
  let raw;
  try{raw=JSON.parse(fs.readFileSync(`${plan.out}.iotroute/result.json`,'utf8'));}
  catch(e){return noVerdict(plan,`job ${id}: result.json does not parse: ${e.message}`,id,job);}
  const record={...localPaths(raw,map),remote:remoteFacts(plan,id,job)};
  if(record.status!==want)return noVerdict(plan,`job ${id} exited ${code} but its record says ${record.status}`,id,job);
  if(code!==2){
    if(!isFile(plan.out)||record.board_sha256!==sha(plan.out))return noVerdict(plan,`job ${id}: the board that came back is not the board of its record`,id,job);
    if(record.input_sha256!==sha(plan.pcb))return noVerdict(plan,`job ${id} routed another input than ${plan.pcb}`,id,job);
  }
  const line=localPaths(stdout.split('\n').filter(l=>/^(PASS|FAIL|ERROR) /.test(l)).at(-1)??record.status,map);
  return report(plan,record,line,code);
}

/** -> the exit code, or null: the job provably never started, run locally. */
async function runOnDaemon(plan,timeoutS){
  const stage=fs.mkdtempSync(path.join(os.tmpdir(),'route-dispatch-'));
  fs.mkdirSync(path.dirname(plan.out),{recursive:true});
  const results=fs.mkdtempSync(path.join(path.dirname(plan.out),'.job-'));
  try{
    say(`job goes to the daemon ${plan.url}`);
    const {code,id,stdout,stderr}=await submitAndWatch(plan,stageInputs(plan,stage),timeoutS,results);
    if(!id){
      if(code===2&&!/^pcb-job: 500:/m.test(stderr)){say('the daemon took no job');return null;}
      return noVerdict(plan,`submit ended with exit ${code} and no job id: the job may exist, not rerun`,null,null);
    }
    if(code===3)return noVerdict(plan,`daemon unreachable, job ${id} goes on: pcb-job watch ${id}`,id,null);
    const job=jobRecord(plan,id);
    if(!job)return noVerdict(plan,`no status for job ${id}: pcb-job status ${id}`,id,null);
    const queueBound=job.result?.outcome==='queue'&&!job.attempts.length;
    if(job.state==='failed'&&(queueBound||job.attempts.length&&job.attempts.every(a=>a.outcome==='start'))){
      say(`job ${id} never started: ${job.result?.detail}`);return null;
    }
    const verdict=job.state==='passed'||(job.result?.outcome==='command'&&[1,2].includes(job.result.exitCode));
    if(!verdict)return noVerdict(plan,`job ${id} ${job.state}: ${job.result?.detail??'no result yet'}, not rerun`,id,job);
    return adopt(plan,results,id,job,stdout);
  }finally{
    fs.rmSync(stage,{recursive:true,force:true});
    fs.rmSync(results,{recursive:true,force:true});
  }
}

async function main(argv){
  const split=argv.indexOf('--');
  const options=argv.slice(0,split),command=argv.slice(split+1);
  const timeoutS=options[0]==='--timeout'?Math.ceil(Number(options[1])):DEFAULT_TIMEOUT_S;
  if(split<0||command.length<3||!(timeoutS>0)){say('usage: route-dispatch.mjs [--timeout S] -- PYTHON tools/router/run.py BOARD OUT ...');return 2;}
  const plan=await daemonPlan(command);
  if(typeof plan==='string')return localOrStop(command,plan);
  const code=await runOnDaemon(plan,timeoutS);
  return code??localOrStop(command,'the job never started');
}

main(process.argv.slice(2)).then(code=>{process.exitCode=code;},e=>{say(String(e?.stack??e));process.exitCode=2;});
