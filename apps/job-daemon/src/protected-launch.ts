// Trusted service entry point only. Not connected to HTTP or production bootstrap.
import fs from 'node:fs';
import { validateSpec } from './manager.ts';
import { prepareAttemptInput } from './protected-input.ts';
import { protectedJobSpecDigest } from './protected-job-spec.ts';
import { matchesProtectedArchive } from './protected-runtime.ts';
import type { JobManager } from './manager.ts';
import type { ProtectedCommitStore } from './protected-commit.ts';
import type { JobSpec } from './types.ts';

type Ref = {project:string;board:string;operation:string;job:string;attempt:string};
type Options = {tarPath:string;tarSha256:string;maxFiles:number;maxBytes:number;maxArchiveBytes:number;timeoutMs:number};
type Result = {state:'SUBMITTED';runtimeJob:string} | {state:'UNKNOWN'};
const sameRef = (a: Ref | undefined, b: Ref): boolean => !!a && a.project===b.project && a.board===b.board && a.operation===b.operation && a.job===b.job && a.attempt===b.attempt;

/** The admission gate is mandatory. A prepared-but-unresolved intent is never submitted a second time. */
export function launchProtectedAttemptFromTrustedService(authority: ProtectedCommitStore, manager: JobManager, ref: Ref, spec: JobSpec,
  parent: string, options: Options): Result {
  if (!manager.protectedAdmission || !manager.protectedContinuation || !manager.protectedAttest) throw new Error('protected runtime is not installed');
  const source = authority.sourceForAttemptFromTrustedService(ref), validated = validateSpec(spec,manager.cfg);
  const specSha256 = protectedJobSpecDigest(validated);
  if (validated.maxRetries !== 0 || validated.image !== `sha256:${source.runtimeDigest}` || specSha256 !== protectedJobSpecDigest(spec)) throw new Error('protected job specification does not match attempt');
  const prior = authority.submissionFromTrustedService(ref);
  if (prior) {
    if (prior.specSha256 !== specSha256 || prior.archiveToolSha256 !== options.tarSha256) throw new Error('protected submission request changed');
    if (prior.runtimeJob && prior.state !== 'ATTACHED') return {state:'UNKNOWN'};
    const jobs = [...manager.jobs.values()].filter(job => sameRef(job.protectedRef,ref));
    if (jobs.length !== 1 || (prior.runtimeJob && prior.runtimeJob !== jobs[0].id) || protectedJobSpecDigest(jobs[0].spec) !== specSha256 ||
        !matchesProtectedArchive(manager.store.inputTar(jobs[0].id),prior)) return {state:'UNKNOWN'};
    if (!prior.runtimeJob) {
      if (prior.state !== 'PREPARED' || jobs[0].state !== 'queued' || jobs[0].attempts.length) return {state:'UNKNOWN'};
      try { authority.associateRuntimeFromTrustedService(ref,jobs[0].id,prior); } catch { return {state:'UNKNOWN'}; }
    }
    return {state:'SUBMITTED',runtimeJob:jobs[0].id};
  }
  const prepared = prepareAttemptInput(authority,ref,parent,options), input = {...prepared,specSha256};
  try {
    // From this point a failure is ambiguous; never blindly retry creation.
    authority.reserveSubmissionFromTrustedService(ref,input);
    const job = manager.submit(validated,prepared.archive,ref);
    authority.associateRuntimeFromTrustedService(ref,job.id,input);
    fs.rmSync(prepared.directory,{recursive:true,force:true});
    return {state:'SUBMITTED',runtimeJob:job.id};
  } catch { return {state:'UNKNOWN'}; }
}
