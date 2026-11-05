// Internal collector only. The manager store and Docker control must be service-owned; never accept a client output path.
import fs from 'node:fs';import path from 'node:path';
import {parseEvidenceJson} from './canonical-json.ts';
import {validatePolicyBoundGateEvidence} from './protected-policy-gate.ts';
import {matchesProtectedArchive,protectedVerifierCommand} from './protected-runtime.ts';
import {protectedJobSpecDigest} from './protected-job-spec.ts';
import type {ProtectedVerifierAuthority,VerifierRef} from './protected-verifier-authority.ts';
import type {JobManager} from './manager.ts';
import type {GateInputBinding} from './protected-gate-bindings.ts';

type Obj=Record<string,unknown>;
const object=(v:unknown):v is Obj=>!!v&&typeof v==='object'&&!Array.isArray(v);
function privateOutputRoot(manager:JobManager,jobId:string):string {
 const configured=manager.store.root,uid=process.getuid?.();if(uid===undefined)throw new Error('service ownership is unavailable');
 const stat=fs.lstatSync(configured);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==uid||(stat.mode&0o077)!==0)throw new Error('job store is not service-private');
 const root=fs.realpathSync(configured);let ancestor=path.dirname(root);
 for(;;){const s=fs.lstatSync(ancestor),stickyRoot=s.uid===0&&(s.mode&0o1000)!==0;if(!s.isDirectory()||s.isSymbolicLink()||![0,uid].includes(s.uid)||((s.mode&0o022)!==0&&!stickyRoot))throw new Error('unsafe job store ancestor');const next=path.dirname(ancestor);if(next===ancestor)break;ancestor=next;}
 let current=root;for(const part of ['jobs',jobId,'attempts','1','out']){current=path.join(current,part);const s=fs.lstatSync(current);if(!s.isDirectory()||s.isSymbolicLink())throw new Error('unsafe verifier output directory');
  if(part!=='out'&&(s.uid!==uid||(s.mode&0o022)!==0))throw new Error('unsafe verifier output ancestor');}
 return current;
}
function readOutput(root:string,name:string):Buffer {
 const parts=name.split('/');if(!parts.length||parts.some(p=>!p||p==='.'||p==='..'||p.includes('\\')))throw new Error('invalid verifier output name');
 let parent=root;for(const part of parts.slice(0,-1)){parent=path.join(parent,part);const st=fs.lstatSync(parent);if(!st.isDirectory()||st.isSymbolicLink())throw new Error('unsafe verifier evidence directory');}
 const fd=fs.openSync(path.join(parent,parts.at(-1)!),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{const before=fs.fstatSync(fd);if(!before.isFile()||before.size>16*1024*1024)throw new Error('invalid verifier evidence file');const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd);
  if(bytes.length!==before.size||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Error('verifier evidence changed');return bytes;
 }finally{fs.closeSync(fd);}
}
export interface CollectedVerifierOutput {files:Map<string,Buffer>;evidence:ReturnType<typeof validatePolicyBoundGateEvidence>;runtimeJob:string}
/** Only invoke for the fixed verifier job after manager-observed process exit; no result supplied by clients. */
export async function collectProtectedVerifierOutput(authority:ProtectedVerifierAuthority,manager:JobManager,ref:VerifierRef,runtimeJob:string):Promise<CollectedVerifierOutput> {
 const initial=authority.verificationContextFromTrustedService(ref),expected=authority.verifierIdentityFromTrustedService(ref,runtimeJob),job=manager.jobs.get(runtimeJob),association=job?.protectedVerifierRef;
 if(!expected||!job||!association||association.project!==ref.project||association.board!==ref.board||association.operation!==ref.operation||association.job!==ref.job||association.attempt!==ref.attempt||association.verification!==ref.verification||
   job.spec.maxRetries!==0||job.spec.image!==expected.verifierImage||protectedJobSpecDigest(job.spec)!==expected.specSha256||JSON.stringify(job.spec.command)!==JSON.stringify(protectedVerifierCommand(expected.policySha256))||
   !matchesProtectedArchive(manager.store.inputTar(runtimeJob),expected)||job.state!=='passed'||job.result?.outcome!=='passed'||job.cancelRequested||job.attempts.length!==1||!authority.canRunVerifier(ref,runtimeJob,true))
  throw new Error('protected verifier has not completed successfully');
 await manager.clean();
 const attempt=job.attempts[0];
 if(manager.jobs.get(runtimeJob)!==job||job.state!=='passed'||attempt.n!==1||attempt.container!==`pcbjob-${runtimeJob}-1`||!attempt.endedAt||attempt.trimmed!==true||
   (await manager.runtime.inspect(attempt.container)).status!=='missing')throw new Error('protected verifier cleanup is unconfirmed');
 const root=privateOutputRoot(manager,runtimeJob),material=authority.policyMaterialFromTrustedService(initial.policyDigest),policy=material.policy;
 const names=['scan.json','identity.json','gate/result.json','gate/findings.json','gate/events.jsonl','gate.stdout','gate.stderr',...policy.required_checks.map(id=>`gate/${id}.log`),
  ...(policy.required_checks.includes('erc')?['gate/erc.json']:[]),...(policy.required_checks.includes('drc')?['gate/drc.json']:[])];
 if(new Set(names).size!==names.length||names.length>128)throw new Error('invalid verifier evidence set');
 const files=new Map<string,Buffer>();let total=0;for(const name of names){const bytes=readOutput(root,name);total+=bytes.length;if(total>64*1024*1024)throw new Error('verifier evidence exceeds limit');files.set(name,bytes);}
 const scan=parseEvidenceJson(files.get('scan.json')!);
 if(!object(scan)||Object.keys(scan).length!==8||!['schema','policy_sha256','input_sha256','inputs','tools','configured_checks','gate_exit','terminal_event'].every(k=>Object.hasOwn(scan,k))||scan.schema!=='pcb.verifier-scan.v1'||scan.policy_sha256!==initial.policyDigest||typeof scan.input_sha256!=='string'||!Array.isArray(scan.inputs)||!object(scan.tools)||
   !Array.isArray(scan.configured_checks)||scan.gate_exit!==0||scan.terminal_event!==true)throw new Error('invalid verifier scan');
 const scanTools=scan.tools;if(Object.keys(scanTools).length!==Object.keys(policy.tool_versions).length||Object.entries(policy.tool_versions).some(([k,v])=>scanTools[k]!==v))throw new Error('verifier scan tool versions changed');
 const eventBytes=files.get('gate/events.jsonl')!,lines=new TextDecoder('utf-8',{fatal:true}).decode(eventBytes).trim().split('\n');
 const endings=lines.map(line=>parseEvidenceJson(Buffer.from(line))).filter(event=>object(event)&&(event.type==='gate.end'||event.event==='gate.end'));
 if(endings.length!==1||!object(endings[0])||endings[0].exit!==0||endings[0].changedDuringRun!==false)throw new Error('verifier terminal event is invalid');
 const validated=validatePolicyBoundGateEvidence({result:files.get('gate/result.json')!,findings:files.get('gate/findings.json')!,identity:files.get('identity.json')!,
  ...(files.has('gate/erc.json')?{erc:files.get('gate/erc.json')!}:{}),...(files.has('gate/drc.json')?{drc:files.get('gate/drc.json')!}:{})},
  material.bytes,material.signature,material.key,material.keyId,false,{nowMs:material.nowMs,projectId:ref.project,boardId:ref.board,operation:ref.operation,policySha256:initial.policyDigest,
   workerImageSha256:initial.workerDigest,verifierImageSha256:policy.verifier_image_sha256,toolchainSha256:initial.toolchainDigest,archiveToolSha256:policy.archive_tool_sha256,
   source:initial.source,candidate:initial.candidate,scannedInputs:scan.inputs as unknown as GateInputBinding[],inputSha256:scan.input_sha256,configuredChecks:scan.configured_checks as string[],processExit:0,terminalEvent:true});
 if((await manager.runtime.inspect(attempt.container)).status!=='missing')throw new Error('protected verifier cleanup changed');
 const final=authority.verificationContextFromTrustedService(ref);
 if(final.sourceDigest!==initial.sourceDigest||final.candidateDigest!==initial.candidateDigest||final.policyDigest!==initial.policyDigest||manager.jobs.get(runtimeJob)!==job||job.state!=='passed'||job.cancelRequested||!authority.canRunVerifier(ref,runtimeJob,true))
  throw new Error('protected verification changed during collection');
 authority.recordVerifierCleanupFromTrustedService(ref,runtimeJob);
 return {files,evidence:validated,runtimeJob};
}
