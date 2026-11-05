// Draft capability primitives. Not an authenticated endpoint or an authority by themselves.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ROLES = ['view', 'submit', 'cancel', 'commit', 'worker', 'verifier'] as const;
export type ProtectedRole = typeof ROLES[number];
export interface CapabilityScope {
  role: ProtectedRole; principal: string; project: string; board: string | null; operation: string | null;
  job: string | null; attempt: string | null; issuedAtMs: number; expiresAtMs: number; maxUses: number;
}
export interface CapabilityTarget { role: ProtectedRole; project: string; board: string | null; operation: string | null; job: string | null; attempt: string | null }

export function newCapability(): string { return randomBytes(32).toString('hex'); }
export function capabilityHash(token: string): Buffer {
  if (typeof token !== 'string' || !TOKEN.test(token)) throw new Error('invalid capability');
  return createHash('sha256').update('pcb.capability.v1\0', 'utf8').update(Buffer.from(token, 'hex')).digest();
}
export function verifyCapability(token: unknown, stored: Uint8Array): boolean {
  let candidate: Uint8Array = Buffer.alloc(32), valid = false;
  try { if (typeof token === 'string') { candidate = capabilityHash(token); valid = true; } } catch { /* compare a dummy value */ }
  const expected = stored instanceof Uint8Array && stored.byteLength === 32 ? Buffer.from(stored) : Buffer.alloc(32);
  const equal = timingSafeEqual(candidate, expected);
  return valid && stored instanceof Uint8Array && stored.byteLength === 32 && equal;
}
export function validateScope(scope: CapabilityScope): void {
  const ident = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
  const keys = ['role', 'principal', 'project', 'board', 'operation', 'job', 'attempt', 'issuedAtMs', 'expiresAtMs', 'maxUses'];
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) || Object.keys(scope).length !== keys.length || !keys.every(k => Object.hasOwn(scope, k)) ||
      !ROLES.includes(scope.role) || !ident(scope.principal) || !ident(scope.project) ||
      (scope.board !== null && !ident(scope.board)) || (scope.operation !== null && !ident(scope.operation)) ||
      (scope.job !== null && !ident(scope.job)) || (scope.attempt !== null && !ident(scope.attempt)) ||
      !Number.isSafeInteger(scope.issuedAtMs) || !Number.isSafeInteger(scope.expiresAtMs) || scope.issuedAtMs < 1 ||
      scope.expiresAtMs <= scope.issuedAtMs || scope.expiresAtMs - scope.issuedAtMs > 86_400_000 ||
      !Number.isSafeInteger(scope.maxUses) || scope.maxUses < 1 || scope.maxUses > 100_000) throw new Error('invalid capability scope');
  if (scope.role !== 'view' && (!scope.board || !scope.operation)) throw new Error('mutating capability requires board and operation');
  if (['worker', 'verifier', 'commit', 'cancel'].includes(scope.role) && (!scope.job || !scope.attempt)) throw new Error('capability requires a specific job attempt');
  if ((scope.job === null) !== (scope.attempt === null)) throw new Error('job and attempt must be specified together');
}
/** Call only inside the authoritative transaction that consumes a bounded use and performs the operation. */
export function scopeMatches(scope: CapabilityScope, target: CapabilityTarget, nowMs: number, uses: number, revoked: boolean): boolean {
  try { validateScope(scope); } catch { return false; }
  if (!target || typeof target !== 'object' || !ROLES.includes(target.role) || !Number.isSafeInteger(nowMs) || !Number.isSafeInteger(uses) || uses < 0 || revoked !== false || nowMs < scope.issuedAtMs ||
      nowMs >= scope.expiresAtMs || uses >= scope.maxUses || scope.role !== target.role || scope.project !== target.project) return false;
  return (scope.board === null || scope.board === target.board) && (scope.operation === null || scope.operation === target.operation) &&
    (scope.job === null || scope.job === target.job) && (scope.attempt === null || scope.attempt === target.attempt);
}
