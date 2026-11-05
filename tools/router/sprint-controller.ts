// One parent deadline, bounded concurrency, and verified winners. Backends own child cleanup.
import { sprintPolicy, sprintVariants } from './sprint-policy.mjs';

export type Policy = ReturnType<typeof sprintPolicy>;
export type Progress = { pass: number; unrouted: number; conflicts: number; wire_mm: number; vias: number };
export type Variant = { id: string; seed: number; via_cost: number; state: 'pending' | 'yielded' | 'complete' | 'failed' | 'stopped';
  pass: number; cpu_s: number | null; checkpoint?: string; route?: string; progress?: Progress; reason?: string };
export type Slice = { kind: 'yielded' | 'complete'; pass: number; cpu_s: number | null; checkpoint?: string; route?: string; progress?: Progress };
export type Candidate = { variant: string; board: string; board_sha256: string; wire_mm: number; vias: number; receipt: string };
export interface Backend {
  prepare(signal: AbortSignal): Promise<void>;
  slice(v: Variant, signal: AbortSignal, progress: (p: Progress) => void): Promise<Slice>;
  /** Must run native checks and the configured board gate. null means a verified rejection. */
  verify(v: Variant, signal: AbortSignal): Promise<Candidate | null>;
  /** All registered process groups must settle, even after an exception. */
  settle(): Promise<void>;
}
export type Event = { type: string; elapsed_s: number; variant?: string; [key: string]: unknown };
export type Portfolio = { schema: string; status: 'PASS' | 'FAIL' | 'ERROR'; reason: string; elapsed_s: number;
  cpu_s: number | null; cpu_scope: string; policy: Policy; variants: Variant[]; candidates: Candidate[]; winner: Candidate | null };

/** No cross-seed predictive culling: that policy needs evidence from #1318. */
export async function runPortfolio(policy: Policy, maxPasses: number, backend: Backend,
  emit: (event: Event) => void = () => {}, parentSignal?: AbortSignal): Promise<Portfolio> {
  if (!Number.isSafeInteger(maxPasses) || maxPasses < 1 || maxPasses > 1000) throw Error('sprint pass limit must be 1..1000');
  const start = performance.now();
  const elapsed = () => (performance.now() - start) / 1000;
  const variants: Variant[] = sprintVariants(policy).map(v => ({ ...v, state: 'pending', pass: 0, cpu_s: 0 }));
  const candidates: Candidate[] = [];
  const all = new AbortController(), search = new AbortController();
  // Leave the broker time to terminate and reap children inside the parent's hard bound.
  const cleanupReserve = 8;
  const stopWorkAt = policy.deadline_s - cleanupReserve;
  const hardTimer = setTimeout(() => all.abort('deadline'), stopWorkAt * 1000);
  const searchTimer = setTimeout(() => search.abort('search-deadline'), (policy.deadline_s - policy.verify_reserve_s) * 1000);
  const abort = () => { all.abort('cancelled'); search.abort('cancelled'); };
  const stopSearch = () => search.abort(all.signal.reason);
  all.signal.addEventListener('abort', stopSearch, { once: true });
  parentSignal?.addEventListener('abort', abort, { once: true });
  if (parentSignal?.aborted) abort();
  const event = (type: string, data: Record<string, unknown> = {}) => emit({ type, elapsed_s: elapsed(), ...data });
  const verified = new Set<string>();
  let longestVerification = 0;
  let verification = Promise.resolve();
  const verify = (v: Variant) => {
    verification = verification.then(async () => {
      if (verified.has(v.id) || all.signal.aborted) return;
      verified.add(v.id);
      // Keep the verified incumbent instead of starting native work whose measured
      // cost no longer fits. This is budget admission, not a claim about seed quality.
      if(candidates.length&&longestVerification>0&&stopWorkAt-elapsed()<longestVerification*1.2){
        v.reason='verification deferred: remaining budget below measured verification cost';
        event('sprint.verify.deferred',{variant:v.id,remaining_s:Math.max(0,stopWorkAt-elapsed()),reserve_s:longestVerification*1.2});
        search.abort('verification-budget');
        return;
      }
      event('sprint.verify.start', { variant: v.id });
      const verificationStart=elapsed();
      try {
        const candidate = await backend.verify(v, all.signal);
        if (candidate) {
          if (candidate.variant !== v.id || !Number.isFinite(candidate.wire_mm) || candidate.wire_mm < 0 || !Number.isSafeInteger(candidate.vias) || candidate.vias < 0)
            throw Error('invalid verified-candidate score');
          candidates.push(candidate);
        }
        event('sprint.verify.end', { variant: v.id, passed: candidate !== null });
      } catch (error) { event('sprint.verify.end', { variant: v.id, passed: false, reason: String(error) }); }
      finally { longestVerification=Math.max(longestVerification,elapsed()-verificationStart); }
    });
    return verification;
  };
  let problem: string | null = null;
  try {
    event('sprint.start', { policy, max_passes: maxPasses });
    await backend.prepare(all.signal);
    const queue = [...variants];
    const worker = async () => {
      while (queue.length && !search.signal.aborted) {
        const v = queue.shift()!;
        event('sprint.slice.start', { variant: v.id, seed: v.seed, via_cost: v.via_cost, after_pass: v.pass });
        try {
          const slice = await backend.slice(v, search.signal, progress => {
            if (!Number.isSafeInteger(progress.pass) || progress.pass <= v.pass || progress.pass > maxPasses
                || [progress.unrouted,progress.conflicts,progress.wire_mm,progress.vias].some(n=>!Number.isFinite(n)||n<0)) return;
            v.progress = progress;
            event('sprint.checkpoint', { variant: v.id, ...progress });
          });
          if (!Number.isSafeInteger(slice.pass) || slice.pass <= v.pass || slice.pass > maxPasses || (slice.cpu_s !== null && (!Number.isFinite(slice.cpu_s) || slice.cpu_s < 0)))
            throw Error('invalid or non-advancing slice receipt');
          if (slice.kind === 'yielded' && !slice.checkpoint) throw Error('yield has no durable checkpoint');
          if (slice.kind === 'complete' && !slice.route) throw Error('completed slice has no route');
          const {progress,...receipt}=slice;
          Object.assign(v, receipt, { state: slice.kind, cpu_s: v.cpu_s === null || slice.cpu_s === null ? null : v.cpu_s + slice.cpu_s });
          if(progress?.pass===slice.pass)v.progress=progress;
          if (slice.kind === 'yielded' && v.pass < maxPasses) queue.push(v);
          event('sprint.slice.end', { variant: v.id, state: v.state, pass: v.pass, cpu_s: v.cpu_s });
          // Verification occupies this worker slot and is serialized across variants.
          if (slice.kind === 'complete') await verify(v);
        } catch (error) {
          v.state = search.signal.aborted ? 'stopped' : 'failed';
          v.cpu_s = null;
          v.reason = String(error);
          event('sprint.slice.end', { variant: v.id, state: v.state, reason: v.reason });
        }
      }
    };
    await Promise.all(Array.from({ length: policy.parallelism }, worker));
    clearTimeout(searchTimer);
    // An earlier valid checkpoint remains useful even if a later slice hit its deadline.
    const eligible = variants.filter(v => v.route || v.checkpoint);
    const key = (v: Variant) => [v.progress?.unrouted ?? Infinity, v.progress?.conflicts ?? Infinity, v.progress?.wire_mm ?? Infinity];
    eligible.sort((a,b) => { const x=key(a),y=key(b); return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]! || a.id.localeCompare(b.id); });
    for (const v of eligible) {
      if (all.signal.aborted) break;
      await verify(v);
    }
  } catch (error) { problem = String(error); }
  finally {
    clearTimeout(hardTimer); clearTimeout(searchTimer);
    parentSignal?.removeEventListener('abort', abort);
    all.signal.removeEventListener('abort', stopSearch);
    try { await backend.settle(); } catch (error) { problem = `cleanup unconfirmed: ${String(error)}`; }
  }
  candidates.sort((a,b) => a.wire_mm-b.wire_mm || a.vias-b.vias || a.variant.localeCompare(b.variant));
  const winner = !problem && all.signal.reason !== 'cancelled' ? candidates[0] ?? null : null;
  const status = winner ? 'PASS' : problem || all.signal.aborted || search.signal.aborted ? 'ERROR' : 'FAIL';
  const reason = winner ? 'winner passed native checks and configured gate' : problem ?? String(all.signal.reason ?? 'no verified candidate within the budget');
  event('sprint.end', { status, reason, winner: winner?.variant ?? null });
  return { schema: 'iot-lab.route-sprints.v1', status, reason, elapsed_s: elapsed(), cpu_s: variants.some(v=>v.cpu_s===null) ? null : variants.reduce((n,v)=>n+v.cpu_s!,0),
    cpu_scope: 'owned core slice CPU only; native verification is separately recorded', policy, variants, candidates, winner };
}
