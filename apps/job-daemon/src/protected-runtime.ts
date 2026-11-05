// Internal adapter, not yet wired into job submission, server startup or a public API.
import type { JobManager } from './manager.ts';
import type { ProtectedCommitStore } from './protected-commit.ts';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { protectedJobSpecDigest } from './protected-job-spec.ts';
import { isTerminal } from './types.ts';

export function matchesProtectedArchive(file: string, expected: {sha256:string;size:number}): boolean {
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch { return false; }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== expected.size || (process.getuid && stat.uid !== process.getuid())) return false;
    const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024); let n: number;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0,n));
    return digest.digest('hex') === expected.sha256;
  } catch { return false; } finally { fs.closeSync(fd); }
}

/** Reapply durable cancellation after crashes or transient manager failures. Never infer worker cleanup here. */
export function reconcileProtectedCancellations(authority: ProtectedCommitStore, manager: Pick<JobManager, 'jobs' | 'cancel'>):
  { requested: string[]; unavailable: string[] } {
  const requested: string[] = [], unavailable: string[] = [];
  for (const item of authority.pendingRuntimeCancellations()) {
    if (!manager.jobs.has(item.runtimeJob)) { unavailable.push(item.runtimeJob); continue; }
    try { manager.cancel(item.runtimeJob); requested.push(item.runtimeJob); }
    catch { unavailable.push(item.runtimeJob); }
  }
  return { requested, unavailable };
}

/** Trusted bootstrap only. Protected jobs remain held when the adapter is absent or the authority rejects admission. */
export function installProtectedRuntime(authority: ProtectedCommitStore, manager: JobManager): void {
  if (manager.protectedAdmission || manager.protectedContinuation || manager.protectedAttest || manager.protectedBeforeTick) throw new Error('protected runtime is already installed');
  manager.protectedAdmission = job => {
    if (!job.protectedRef || !authority.canDispatchProtected(job.protectedRef, job.id)) return false;
    const expected = authority.runtimeInputIdentity(job.protectedRef, job.id);
    return !!expected && expected.image === job.spec.image && expected.specSha256 === protectedJobSpecDigest(job.spec) && matchesProtectedArchive(manager.store.inputTar(job.id), expected);
  };
  manager.protectedContinuation = job => !!job.protectedRef && authority.canDispatchProtected(job.protectedRef, job.id, true);
  manager.protectedAttest = (job,image) => !!job.protectedRef && authority.recordRuntimeAttestationFromTrustedService(job.protectedRef,job.id,image);
  manager.protectedBeforeTick = () => { reconcileProtectedCancellations(authority, manager); };
}

/** Abandon a protected attempt only after the daemon confirms its exact job is terminal and every container is gone. */
export async function recoverAbandonedProtectedAttempt(authority: ProtectedCommitStore, manager: JobManager,
  ref: {project:string;board:string;operation:string;job:string;attempt:string}): Promise<'PENDING' | 'CLEANED'> {
  if (authority.recoveryStatusFromTrustedService(ref) === 'CLEANED') return 'CLEANED';
  const recovery = authority.beginAbandonFromTrustedService(ref);
  const job = manager.jobs.get(recovery.runtimeJob), association = job?.protectedRef;
  const expected = authority.runtimeInputIdentity(ref,recovery.runtimeJob);
  if (!job || !association || !expected || job.spec.maxRetries !== 0 ||
      association.project !== ref.project || association.board !== ref.board || association.operation !== ref.operation || association.job !== ref.job || association.attempt !== ref.attempt ||
      job.spec.image !== expected.image || protectedJobSpecDigest(job.spec) !== expected.specSha256) return 'PENDING';
  if (!isTerminal(job.state)) { manager.cancel(job.id); await manager.tick(); }
  if (!isTerminal(job.state)) return 'PENDING';
  await manager.clean();
  if (manager.jobs.get(job.id) !== job || job.attempts.length > 1) return 'PENDING';
  for (const attempt of job.attempts) {
    if (attempt.n !== 1 || attempt.container !== `pcbjob-${job.id}-1` || !attempt.endedAt || attempt.trimmed !== true) return 'PENDING';
    try { if ((await manager.runtime.inspect(attempt.container)).status !== 'missing') return 'PENDING'; }
    catch { return 'PENDING'; }
  }
  authority.finishAbandonFromTrustedService(ref,recovery.runtimeJob,recovery.generation);
  return 'CLEANED';
}

/** Reconcile the crash window between durable intent and runtime association without admitting a queued job. */
export async function recoverUnassociatedProtectedSubmission(authority: ProtectedCommitStore, manager: JobManager,
  ref: {project:string;board:string;operation:string;job:string;attempt:string}): Promise<'PENDING' | 'CLEANED'> {
  if (authority.recoveryStatusFromTrustedService(ref) === 'CLEANED') return 'CLEANED';
  const intent = authority.submissionFromTrustedService(ref);
  if (!intent) return 'PENDING';
  if (intent.runtimeJob) return recoverAbandonedProtectedAttempt(authority,manager,ref);
  if (intent.state !== 'PREPARED') return 'PENDING';
  const jobs = [...manager.jobs.values()].filter(job => {
    const r = job.protectedRef;
    return !!r && r.project === ref.project && r.board === ref.board && r.operation === ref.operation && r.job === ref.job && r.attempt === ref.attempt;
  });
  if (jobs.length !== 1) return 'PENDING';
  const job = jobs[0];
  if (!['queued','cancelled','failed'].includes(job.state) || job.attempts.length !== 0 || job.spec.maxRetries !== 0 ||
      protectedJobSpecDigest(job.spec) !== intent.specSha256 || !matchesProtectedArchive(manager.store.inputTar(job.id),intent)) return 'PENDING';
  authority.associateOrphanForRecoveryFromTrustedService(ref,job.id);
  return recoverAbandonedProtectedAttempt(authority,manager,ref);
}
