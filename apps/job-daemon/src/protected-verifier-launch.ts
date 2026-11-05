// Trusted service entry point only. This does not authenticate outputs or issue a verification receipt.
import fs from 'node:fs';
import { validateSpec } from './manager.ts';
import { prepareVerifierInput } from './protected-verifier-input.ts';
import { matchesProtectedArchive, protectedVerifierCommand } from './protected-runtime.ts';
import { protectedJobSpecDigest } from './protected-job-spec.ts';
import type { ProtectedVerifierAuthority, VerifierRef } from './protected-verifier-authority.ts';
import type { JobManager } from './manager.ts';
import type { JobRecord } from './types.ts';

type Limits={cpus?:number;memGb?:number;diskGb?:number;timeoutS?:number;queueWaitS?:number};
type Options={tarPath:string;maxFiles:number;maxBytes:number;maxArchiveBytes:number;timeoutMs:number};
type Result={state:'SUBMITTED';runtimeJob:string}|{state:'UNKNOWN'};
const same=(a:JobRecord['protectedVerifierRef'],b:VerifierRef):boolean=>!!a&&a.project===b.project&&a.board===b.board&&a.operation===b.operation&&a.job===b.job&&a.attempt===b.attempt&&a.verification===b.verification;

/** Reserve before queue creation; ambiguous prior submissions are never automatically duplicated. */
export async function launchProtectedVerifierFromTrustedService(authority:ProtectedVerifierAuthority,manager:JobManager,ref:VerifierRef,
  parent:string,options:Options,limits:Limits={}):Promise<Result> {
  if(!manager.verifierAdmission||!manager.verifierContinuation||!manager.verifierAttest)throw new Error('protected verifier runtime is not installed');
  if(!limits||Object.keys(limits).some(key=>!['cpus','memGb','diskGb','timeoutS','queueWaitS'].includes(key)))throw new Error('invalid verifier resource limits');
  const context=authority.verificationContextFromTrustedService(ref);
  const spec=validateSpec({...limits,name:'protected-verifier',command:protectedVerifierCommand(context.policyDigest),image:`sha256:${context.policy.verifier_image_sha256}`,maxRetries:0},manager.cfg),specSha256=protectedJobSpecDigest(spec);
  const prior=authority.verifierSubmissionFromTrustedService(ref);
  if(prior){
    if(prior.sourceManifest!==context.sourceDigest||prior.candidateManifest!==context.candidateDigest||prior.policySha256!==context.policyDigest||prior.specSha256!==specSha256||prior.verifierImage!==spec.image||prior.archiveToolSha256!==context.policy.archive_tool_sha256)
      throw new Error('protected verifier submission changed');
    if(prior.runtimeJob&&prior.state!=='ATTACHED')return {state:'UNKNOWN'};
    const jobs=[...manager.jobs.values()].filter(job=>same(job.protectedVerifierRef,ref));
    if(jobs.length!==1||(prior.runtimeJob&&prior.runtimeJob!==jobs[0].id)||protectedJobSpecDigest(jobs[0].spec)!==specSha256||!matchesProtectedArchive(manager.store.inputTar(jobs[0].id),prior))return {state:'UNKNOWN'};
    if(!prior.runtimeJob){
      if(prior.state!=='PREPARED'||jobs[0].state!=='queued'||jobs[0].attempts.length)return {state:'UNKNOWN'};
      try{authority.associateVerifierFromTrustedService(ref,jobs[0].id);}catch{return {state:'UNKNOWN'};}
    }
    return {state:'SUBMITTED',runtimeJob:jobs[0].id};
  }
  const prepared=await prepareVerifierInput(authority,manager,ref,parent,options),identity={...prepared,specSha256};
  try{
    authority.reserveVerifierFromTrustedService(ref,identity);
    const job=manager.submit(spec,prepared.archive,undefined,ref);
    authority.associateVerifierFromTrustedService(ref,job.id);
    fs.rmSync(prepared.directory,{recursive:true,force:true});
    return {state:'SUBMITTED',runtimeJob:job.id};
  }catch{return {state:'UNKNOWN'};}
}
