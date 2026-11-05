// Reproduction harness for the bounded #1318 experiment; not a routing policy.
import fs from 'node:fs';
import path from 'node:path';
import {startOwned} from '../../lib/owned-stage.ts';
import {copyVerificationWorkspace,semanticChecks,digest} from '../sprint-native.ts';
import {main as sprint} from '../sprint-job.ts';
const [mode,secondsArg,board="ENV-SENSE"]=process.argv.slice(2),seconds=Number(secondsArg);
if(!["ENV-SENSE","FIELD-24V-BUS","ESP32-CORE"].includes(board))throw Error("board outside the three-board benchmark");
const measuring=mode==='measure';
if(measuring ? seconds!==0||board!=='ESP32-CORE' : !['single','sprint'].includes(mode!)||!Number.isSafeInteger(seconds)||seconds<=30)throw Error('single|sprint SECONDS>30, or measure 0 ESP32-CORE');
const root=process.cwd(),bin=path.resolve('in/iotroute-linux-x86_64');
const config=JSON.parse(fs.readFileSync(path.resolve(`hardware-design/boards/${board}/gate.json`),"utf8"));
const src=path.resolve(`hardware-design/boards/${board}`,`${config.project}.kicad_pcb`);
const out=path.resolve(`out/route/${board}.kicad_pcb`),dir=path.resolve('out/benchmark');
fs.mkdirSync(dir,{recursive:true});
const read=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'));
const cg=()=>{try{return Object.fromEntries(fs.readFileSync('/sys/fs/cgroup/cpu.stat','utf8').trim().split('\n').map(x=>{const[k,v]=x.split(' ');return[k,Number(v)]}));}catch{return null}};
const began=performance.now(),cpuStart=cg(),stages:unknown[]=[];
const env={...process.env,IOTROUTE_BIN:bin,OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',RAYON_NUM_THREADS:'1'};
const abort=new AbortController(),timer=measuring?undefined:setTimeout(()=>abort.abort('budget'),(seconds-3)*1000);
const stop=()=>abort.abort('signal');process.once('SIGTERM',stop);process.once('SIGINT',stop);
async function owned(command:string[],label:string,cwd=root,extra=env){
 if(abort.signal.aborted)throw Error('budget exhausted');
 const fd=fs.openSync(path.join(dir,label+'.log'),'w');let stage;try{stage=startOwned(command,{cwd,env:extra,stdout:fd,stderr:fd});}finally{fs.closeSync(fd)}
 const cancel=()=>{void stage.cancel()};abort.signal.addEventListener('abort',cancel,{once:true});const at=performance.now();
 try{const result=await stage.settled;stages.push({command,label,elapsed_s:(performance.now()-at)/1000,...result});if(!result.cleanup.complete)throw Error('unconfirmed cleanup');if(result.returncode!==0)throw Error(label+' exit '+result.returncode);}
 finally{abort.signal.removeEventListener('abort',cancel)}
}
let status='ERROR',error:string|null=null;
try{
 if(mode==='sprint'){
  // The controller owns and verifies all sprint candidates, including child cleanup.
  const code=await sprint([bin,board,out,'--pcb',src,'--lock-from',src,'--return-exempt','--iters','80','--sprints',JSON.stringify({seeds:[0,1,2,3],via_costs:[3],parallelism:2,slice_passes:2,deadline_s:seconds,verify_reserve_s:30,mem_gb:4})]);
  if(code!==0)throw Error('sprint exit '+code);
 }else{
  await owned([bin,'run',board,out,'--pcb',src,'--lock-from',src,'--return-exempt','--iters','80','--seed','0',...(measuring?[]:['--max-time',String(seconds-30)]),'--json'],'native');
  const rec=read(out+'.iotroute/result.json');
  if(rec.status!=='PASS'||rec.drc_errors!==0||rec.unconnected!==0||rec.parity!==0||rec.board_sha256!==digest(out))throw Error('native rejected');
  const workspace=path.join(dir,'workspace');fs.mkdirSync(workspace);copyVerificationWorkspace(root,workspace);
  const candidate=path.join(workspace,path.relative(root,src));fs.copyFileSync(out,candidate);
  const verifyEnv={...env,IOT_LAB:workspace};const gate=path.join(dir,'gate');
  await owned([process.execPath,path.join(workspace,'tools/gate.mjs'),board,'--fresh','--evidence-dir',gate],'gate',workspace,verifyEnv);
  const g=read(path.join(gate,'result.json'));if(g.exit!==0||g.changedDuringRun)throw Error('gate rejected');
  for(const h of semanticChecks(config.post_verify,dir,candidate,process.execPath,verifyEnv))await owned(h.command,h.stage,workspace,h.env as typeof env);
  if(digest(candidate)!==rec.board_sha256)throw Error('verification changed candidate');
  fs.writeFileSync(path.join(dir,'verified.json'),JSON.stringify({board:out,sha256:rec.board_sha256,gate_sha256:digest(path.join(gate,'result.json'))}));
  fs.rmSync(workspace,{recursive:true});
 }
 status='PASS';
}catch(e){error=String(e);console.error(error)}finally{
 clearTimeout(timer);process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);
 const cpuEnd=cg();const report={schema:'pcb.benchmark-1318.v1',board,mode,seconds,calibration:measuring,max_passes:80,status,error,elapsed_s:(performance.now()-began)/1000,cpu_start:cpuStart,cpu_end:cpuEnd,cgroup_cpu_s:cpuStart&&cpuEnd?(cpuEnd.usage_usec-cpuStart.usage_usec)/1e6:null,source_sha256:digest(src),binary_sha256:digest(bin),node:process.version,stages};
 fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
process.exitCode=status==='PASS'?0:2;
