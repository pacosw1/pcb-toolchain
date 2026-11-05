// Internal adapter, not yet wired into job submission, server startup or a public API.
import type { JobManager } from './manager.ts';
import type { ProtectedCommitStore } from './protected-commit.ts';

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
  if (manager.protectedAdmission || manager.protectedContinuation || manager.protectedBeforeTick) throw new Error('protected runtime is already installed');
  manager.protectedAdmission = job => !!job.protectedRef && authority.canDispatchProtected(job.protectedRef, job.id);
  manager.protectedContinuation = job => !!job.protectedRef && authority.canDispatchProtected(job.protectedRef, job.id, true);
  manager.protectedBeforeTick = () => { reconcileProtectedCancellations(authority, manager); };
}
