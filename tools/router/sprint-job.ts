#!/usr/bin/env node
// Entrypoint inside one daemon job. The same script is usable in an explicitly local job image.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sprintPolicy } from './sprint-policy.mjs';
import { runPortfolio, type Event } from './sprint-controller.ts';
import { NativeBackend, digest } from './sprint-native.ts';

export async function main(argv: string[]): Promise<number> {
  const [binArg, board, outArg, ...given] = argv;
  if (!binArg || !board || !outArg) throw Error('usage: sprint-job.ts IOTROUTE BOARD OUT --sprints JSON [run options]');
  const args: string[] = []; let config: unknown; let maxPasses=80;
  const flags=new Set(['--return-exempt','--congestion','--checkpoint']);
  const valued=new Set(['--pcb','--lock-from','--iters','--layer','--net','--plane-net','--tools']);
  for(let i=0;i<given.length;i++){
    const k=given[i]!;
    if(k==='--sprints') { if(config!==undefined)throw Error('duplicate --sprints'); config=JSON.parse(given[++i]??''); }
    else if(k==='--json')continue;
    else if(flags.has(k))args.push(k);
    else if(valued.has(k)){ const v=given[++i];if(v===undefined)throw Error(`missing ${k}`);args.push(k,v);if(k==='--iters')maxPasses=Number(v); }
    else throw Error(`sprint jobs do not accept ${k}`);
  }
  const policy=sprintPolicy(config),root=process.cwd(),out=resolve(outArg),bin=resolve(binArg);
  process.env.IOTROUTE_BIN=bin;
  const backend=new NativeBackend({root,board,out,bin,args,policy,maxPasses,emit:()=>{}});
  const start=performance.now(),events=join(backend.work,'portfolio','events.jsonl');
  const emit=(e:Event)=>{appendFileSync(events,JSON.stringify(e)+'\n');console.error(JSON.stringify(e));};
  const abort=new AbortController();const stop=()=>abort.abort('cancelled');
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  let report;
  try { report=await runPortfolio(policy,maxPasses,backend,emit,abort.signal); }
  finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
  writeFileSync(join(backend.work,'portfolio','result.json'),JSON.stringify(report,null,2));
  let record:Record<string,any>;
  if(report.winner){
    const winner=report.winner;
    if(digest(winner.board)!==winner.board_sha256)throw Error('verified winner changed before handoff');
    mkdirSync(dirname(out),{recursive:true});
    const stem=basename(winner.board,'.kicad_pcb'),destStem=basename(out,'.kicad_pcb');
    for(const file of readdirSync(dirname(winner.board)))if(file.startsWith(stem+'.')&&/\.kicad_(pcb|pro|sch|dru|prl)$/.test(file))
      copyFileSync(join(dirname(winner.board),file),join(dirname(out),destStem+file.slice(stem.length)));
    record=JSON.parse(readFileSync(`${winner.board}.iotroute/result.json`,'utf8'));
    copyFileSync(join(`${winner.board}.iotroute`,'route.json'),join(backend.work,'route.json'));
    copyFileSync(backend.prepared!.model,join(backend.work,'model.json'));
    const variant=join(backend.work,'portfolio',winner.variant);
    for(const [source,dest] of [['progress.json','checkpoint.json'],['congestion.json','congestion.json']])
      if(existsSync(join(variant,source!)))copyFileSync(join(variant,source!),join(backend.work,dest!));
    record.board_file=out;record.work=backend.work;record.board_sha256=digest(out);
  }else{
    const p=backend.prepared;
    record={schema:'iot-lab.iotroute-run.v1',status:'ERROR',board_file:out,work:backend.work,board,
      input:p?.src??null,input_sha256:p?.src?digest(p.src):null,iters:maxPasses,seed:null,
      stages:{binary:{path:bin,how:'sprint',sha256:digest(bin)}},drc_errors:null,unconnected:null,parity:null,tracks:null,vias:null};
  }
  record.seconds=(performance.now()-start)/1000;
  record.portfolio={...report,record:join(backend.work,'portfolio','result.json'),runtime:{node:process.version,node_sha256:digest(process.execPath)}};
  record.cause=report.reason;
  writeFileSync(join(backend.work,'result.json'),JSON.stringify(record,null,2));
  const code=report.winner?0:2;
  console.log(code===0?`PASS ${record.drc_errors} ${record.unconnected} ${record.parity} ${record.tracks} ${record.vias} ${record.seconds}`:`ERROR ${record.seconds} ${report.reason}`);
  console.log(JSON.stringify(record));
  return code;
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))
  main(process.argv.slice(2)).then(code=>{process.exitCode=code;},error=>{console.error(String(error?.stack??error));process.exitCode=2;});
