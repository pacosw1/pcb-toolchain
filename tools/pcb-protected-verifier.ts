// Fixed verifier subprocess for an isolated snapshot. Output is evidence, never authorization by itself.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { verifyProtectedBoardIdentity } from './lib/protected-board-identity.ts';

type Policy={schema:string;board_path:string;gate_board:string;gate_project:string;required_checks:string[];tool_versions:Record<string,string>;allowed_pours:{name:string;net:string;layer:string}[]};
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const safeRelative=(s:string):boolean=>typeof s==='string'&&s.length>0&&!s.startsWith('/')&&!s.includes('\\')&&!/[\u0000-\u001f\u007f]/u.test(s)&&s.split('/').every(x=>x&&x!=='.'&&x!=='..');
function readRegular(file:string,max:number):Buffer {
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{const st=fs.fstatSync(fd);if(!st.isFile()||st.size<1||st.size>max)throw new Error('invalid verifier input');return fs.readFileSync(fd);}finally{fs.closeSync(fd);}
}
function writeNew(file:string,data:string):void {fs.writeFileSync(file,data,{flag:'wx',mode:0o600});}

async function main():Promise<number>{
  const [snapshotArg,sourceArg,policyArg,policySha,outArg]=process.argv.slice(2);
  if(process.argv.length!==7||!snapshotArg||!sourceArg||!policyArg||!outArg||!/^[0-9a-f]{64}$/.test(policySha??''))throw new Error('usage: pcb-protected-verifier SNAPSHOT SOURCE POLICY POLICY_SHA256 OUTPUT');
  const snapshot=fs.realpathSync(snapshotArg),out=fs.realpathSync(outArg),source=fs.realpathSync(sourceArg),policyFile=fs.realpathSync(policyArg);
  if(!fs.statSync(snapshot).isDirectory()||!fs.statSync(out).isDirectory()||fs.lstatSync(sourceArg).isSymbolicLink()||source===snapshot||!source.startsWith(snapshot+path.sep)||out===snapshot||(out.startsWith(snapshot+path.sep)&&out!==path.join(snapshot,'out')))throw new Error('invalid verifier workspace');
  if(source!==path.join(snapshot,'__pcb_verify','source.kicad_pcb')||policyFile!==path.join(snapshot,'__pcb_verify','policy.json')||fs.lstatSync(policyArg).isSymbolicLink())throw new Error('invalid verifier control inputs');
  const policyBytes=readRegular(policyArg,8*1024*1024);if(sha(policyBytes)!==policySha)throw new Error('verifier policy hash mismatch');
  const p=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(policyBytes)) as Policy;
  if(p.schema!=='pcb.verification-policy.v1'||!safeRelative(p.board_path)||!safeRelative(p.gate_project)||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(p.gate_board)||
     !Array.isArray(p.required_checks)||!p.required_checks.length||new Set(p.required_checks).size!==p.required_checks.length||!p.required_checks.every(x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(x))||
     !p.tool_versions||typeof p.tool_versions!=='object'||Array.isArray(p.tool_versions)||!Array.isArray(p.allowed_pours)||p.allowed_pours.length>10000)throw new Error('invalid verifier policy');
  const board=path.join(snapshot,p.board_path),boardReal=fs.realpathSync(board);
  if(!boardReal.startsWith(snapshot+path.sep)||fs.lstatSync(board).isSymbolicLink())throw new Error('invalid verifier board path');
  const configPath=path.join(snapshot,'hardware-design','boards',p.gate_board,'gate.json'),cfg=JSON.parse(readRegular(configPath,1024*1024).toString('utf8')) as {project:string;checks:Record<string,unknown>};
  const configured=Object.keys(cfg.checks??{}).filter(k=>!!cfg.checks[k]);
  if(cfg.project!==p.gate_project||configured.length!==p.required_checks.length||configured.some(k=>!p.required_checks.includes(k)))throw new Error('gate configuration differs from policy');
  if(p.board_path!==`hardware-design/boards/${p.gate_board}/${p.gate_project}.kicad_pcb`)throw new Error('gate board path differs from signed policy');
  const pours=new Set<string>();for(const x of p.allowed_pours){if(!x||![x.name,x.net,x.layer].every(v=>typeof v==='string'&&v.length>0&&Buffer.byteLength(v)<=256))throw new Error('invalid policy pour');const key=JSON.stringify([x.name,x.net,x.layer]);if(pours.has(key))throw new Error('duplicate policy pour');pours.add(key);}
  process.env.IOT_LAB=snapshot;
  const {gateInputs,fingerprint}=await import('./lib/gate-inputs.mjs');
  const {root,kicadShared,kicadConfig,pinnedRepos}=await import('./lib/env.mjs');
  if(fs.realpathSync(root)!==snapshot)throw new Error('gate root differs from snapshot');
  const environment={configDir:kicadConfig,variables:{KICAD10_FOOTPRINT_DIR:path.join(kicadShared,'footprints'),KICAD10_SYMBOL_DIR:path.join(kicadShared,'symbols')},repositories:cfg.checks.kicad_happy?pinnedRepos.filter(r=>r.needed==='gate').map(r=>r.dir):[]};
  const externalRoots={kicad:kicadShared,kicad_config:kicadConfig,...Object.fromEntries(pinnedRepos.map(r=>[r.name,r.dir]))};
  const scan=()=>fingerprint(snapshot,gateInputs(snapshot,p.gate_board,'gate.json',environment).files,p.tool_versions,externalRoots);
  const before=scan(),identity=verifyProtectedBoardIdentity(source,board,pours);
  if(!identity.identityPreserved)throw new Error('candidate changes protected board identity');
  writeNew(path.join(out,'identity.json'),JSON.stringify({schema:'pcb.board-identity.v1',...identity})+'\n');
  const gate=path.join(snapshot,'tools','gate.mjs'),gateDir=path.join(out,'gate');
  const run=spawnSync(process.execPath,[gate,p.gate_board,'--fresh','--evidence-dir',gateDir],{env:process.env,encoding:'utf8',timeout:3_600_000,maxBuffer:4*1024*1024});
  writeNew(path.join(out,'gate.stdout'),run.stdout??'');writeNew(path.join(out,'gate.stderr'),run.stderr??'');
  if(run.error||run.status===null)throw new Error('fresh gate did not complete');
  const after=scan();if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('verifier inputs changed during gate');
  if(sha(readRegular(source,64*1024*1024))!==identity.sourceSha256||sha(readRegular(board,64*1024*1024))!==identity.candidateSha256||sha(readRegular(policyFile,8*1024*1024))!==policySha)throw new Error('verifier control inputs changed during gate');
  const events=readRegular(path.join(gateDir,'events.jsonl'),16*1024*1024).toString('utf8').trim().split('\n').map(line=>JSON.parse(line) as {event?:string;type?:string;exit?:number;changedDuringRun?:boolean});
  const ended=events.filter(event=>event.event==='gate.end'||event.type==='gate.end');
  const terminal=ended.length===1&&ended[0].exit===run.status&&ended[0].changedDuringRun===false;
  writeNew(path.join(out,'scan.json'),JSON.stringify({schema:'pcb.verifier-scan.v1',policy_sha256:policySha,input_sha256:after.input_sha256,inputs:after.inputs,tools:after.tools,configured_checks:configured,gate_exit:run.status,terminal_event:terminal})+'\n');
  return run.status===0&&terminal?0:1;
}
try{process.exitCode=await main();}catch(error){console.error(`protected verifier: ${error instanceof Error?error.message:String(error)}`);process.exitCode=2;}
