// Internal verifier preparation. This does not start or authenticate a verifier job.
import fs from 'node:fs';
import { prepareProtectedInput } from './protected-input.ts';
import { protectedJobSpecDigest } from './protected-job-spec.ts';
import type { ProtectedCommitStore } from './protected-commit.ts';
import type { JobManager } from './manager.ts';

type Ref={project:string;board:string;operation:string;job:string;attempt:string};
/** Package candidate + original board + signed policy only after the worker is terminal and its container is gone. */
export async function prepareVerifierInput(authority:ProtectedCommitStore,manager:JobManager,ref:Ref,parent:string,
  options:{tarPath:string;maxFiles:number;maxBytes:number;maxArchiveBytes:number;timeoutMs:number}):Promise<
    {directory:string;archive:string;sha256:string;size:number;sourceManifest:string;candidateManifest:string;policySha256:string;verifierImage:string}> {
  const initial=authority.verificationContextFromTrustedService(ref),job=manager.jobs.get(initial.runtimeJob),expected=authority.runtimeInputIdentity(ref,initial.runtimeJob),r=job?.protectedRef;
  if(!job||!r||!expected||r.project!==ref.project||r.board!==ref.board||r.operation!==ref.operation||r.job!==ref.job||r.attempt!==ref.attempt||
      job.spec.maxRetries!==0||job.spec.image!==expected.image||protectedJobSpecDigest(job.spec)!==expected.specSha256||job.state!=='passed'||job.result?.outcome!=='passed'||job.cancelRequested||job.attempts.length!==1)
    throw new Error('protected worker has not completed successfully');
  await manager.clean();
  const attempt=job.attempts[0];
  if(manager.jobs.get(job.id)!==job||job.state!=='passed'||attempt.n!==1||attempt.container!==`pcbjob-${job.id}-1`||!attempt.endedAt||attempt.trimmed!==true||
      (await manager.runtime.inspect(attempt.container)).status!=='missing')throw new Error('protected worker cleanup is unconfirmed');
  const current=authority.verificationContextFromTrustedService(ref);
  if(current.sourceDigest!==initial.sourceDigest||current.candidateDigest!==initial.candidateDigest||current.policyDigest!==initial.policyDigest||current.runtimeJob!==job.id)
    throw new Error('protected verification inputs changed');
  if(current.candidate.nodes.some(node=>node.path.split('/')[0].toLowerCase()==='__pcb_verify'))throw new Error('snapshot overlaps verifier control files');
  const sourceBoard=current.source.rootManifest.entries.find(node=>node.kind==='file'&&node.path===current.policy.board_path);
  if(!sourceBoard||sourceBoard.kind!=='file')throw new Error('protected source board unavailable');
  const policyBytes=authority.read(current.policyDigest);
  if(!authority.approvedArtifactFromTrustedService('archive-tool',current.policy.archive_tool_sha256))throw new Error('verifier archive tool is not approved');
  const closure={...current.candidate,nodes:[...current.candidate.nodes,
    {kind:'file' as const,path:'__pcb_verify/source.kicad_pcb',sha256:sourceBoard.sha256,size:sourceBoard.size,executable:false},
    {kind:'file' as const,path:'__pcb_verify/policy.json',sha256:current.policyDigest,size:policyBytes.length,executable:false}]};
  const prepared=prepareProtectedInput(parent,closure,sha=>authority.read(sha),{...options,tarSha256:current.policy.archive_tool_sha256});
  try {
    const finalState=await manager.runtime.inspect(attempt.container);
    const final=authority.verificationContextFromTrustedService(ref);
    if(final.sourceDigest!==current.sourceDigest||final.candidateDigest!==current.candidateDigest||final.policyDigest!==current.policyDigest||final.runtimeJob!==job.id||
      manager.jobs.get(job.id)!==job||job.state!=='passed'||job.cancelRequested||finalState.status!=='missing')
      throw new Error('protected verification inputs changed during packaging');
    return {...prepared,sourceManifest:current.sourceDigest,candidateManifest:current.candidateDigest,policySha256:current.policyDigest,verifierImage:`sha256:${current.policy.verifier_image_sha256}`};
  } catch(error){fs.rmSync(prepared.directory,{recursive:true,force:true});throw error;}
}
