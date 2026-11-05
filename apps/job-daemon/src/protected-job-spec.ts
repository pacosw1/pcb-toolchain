// Stable identity for the exact protected runtime command and limits; no authorization is implied.
import { createHash } from 'node:crypto';
import { parseCanonicalJson } from './canonical-json.ts';
import type { JobSpec } from './types.ts';
export function protectedJobSpecDigest(spec: JobSpec): string {
  if (!spec || !Array.isArray(spec.command) || !spec.command.length || !spec.command.every(x => typeof x === 'string') ||
      typeof spec.name !== 'string' || typeof spec.image !== 'string' || ![spec.cpus,spec.memGb,spec.diskGb].every(x => typeof x === 'number' && Number.isFinite(x) && x > 0) ||
      ![spec.timeoutS,spec.queueWaitS,spec.maxRetries].every(x => Number.isSafeInteger(x) && x >= 0) || !Array.isArray(spec.retryExitCodes) || !spec.retryExitCodes.every(Number.isSafeInteger))
    throw new Error('invalid protected job specification');
  const input = {schema:'pcb.runtime-job-spec.v1',name:spec.name,command:spec.command,image:spec.image,cpus:String(spec.cpus),mem_gb:String(spec.memGb),disk_gb:String(spec.diskGb),
    timeout_s:spec.timeoutS,queue_wait_s:spec.queueWaitS,max_retries:spec.maxRetries,retry_exit_codes:spec.retryExitCodes};
  const canonical=parseCanonicalJson(Buffer.from(JSON.stringify(input)),{maxBytes:1024*1024,maxNodes:20000,maxDepth:8}).canonical;
  return createHash('sha256').update('pcb.runtime-job-spec.v1\0').update(canonical).digest('hex');
}
