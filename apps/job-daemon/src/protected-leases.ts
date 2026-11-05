// Draft canonical lease primitive. No network API, project activation or trusted unpin path is exposed yet.
// Legacy checkouts remain a separate, noncanonical system until a deliberate migration disables dual authority.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { parseCanonicalJson } from './canonical-json.ts';
import { ProtectedCapabilityStore } from './protected-capability-store.ts';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN = /^[0-9a-f]{64}$/;
interface LeaseRow { generation: number; token_hash: Uint8Array; owner: string; expires_at: number; pinned: number; source_revision: number; alias_revision: number; operation: string }
export interface ProtectedLeaseRequest { requestId: string; project: string; board: string; alias: string; aliasRevision: number; sourceRevision: number; operation: string; ttlMs: number }
export type ProtectedLeaseResult = { state: 'ACQUIRED'; generation: number; token: string; expiresAt: number } | { state: 'UNKNOWN'; generation: number } | { state: 'BUSY' };
const leaseHash = (token: string): Buffer => createHash('sha256').update('pcb.lease.v1\0').update(Buffer.from(token, 'hex')).digest();

export class ProtectedLeaseStore extends ProtectedCapabilityStore {
  private clock: () => number;
  constructor(root: string, limits: { maxBlobBytes: number; quotaBytes: number }, now: () => number = Date.now) {
    super(root, limits, now); this.clock = now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS protected_targets (project TEXT NOT NULL, board TEXT NOT NULL,
      revision INTEGER NOT NULL, alias_revision INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY(project,board)) STRICT;
      CREATE TABLE IF NOT EXISTS protected_aliases (project TEXT NOT NULL, alias TEXT NOT NULL, board TEXT NOT NULL,
      alias_revision INTEGER NOT NULL, PRIMARY KEY(project,alias)) STRICT;
      CREATE TABLE IF NOT EXISTS protected_leases (project TEXT NOT NULL, board TEXT NOT NULL, generation INTEGER NOT NULL,
      token_hash BLOB NOT NULL, owner TEXT NOT NULL, expires_at INTEGER NOT NULL, pinned INTEGER NOT NULL,
      source_revision INTEGER NOT NULL, alias_revision INTEGER NOT NULL, operation TEXT NOT NULL, PRIMARY KEY(project,board)) STRICT;
      CREATE TABLE IF NOT EXISTS protected_lease_requests (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
      project TEXT NOT NULL, board TEXT NOT NULL, generation INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS protected_lease_audit (project TEXT NOT NULL, board TEXT NOT NULL, generation INTEGER NOT NULL,
      actor TEXT NOT NULL, action TEXT NOT NULL, at_ms INTEGER NOT NULL) STRICT;`);
  }
  /** Called only after authenticated submission; only targets activated by a future trusted import can be leased. */
  acquire(capability: string, request: ProtectedLeaseRequest): ProtectedLeaseResult {
    const keys = ['requestId', 'project', 'board', 'alias', 'aliasRevision', 'sourceRevision', 'operation', 'ttlMs'];
    if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).length !== keys.length || !keys.every(k => Object.hasOwn(request, k)) ||
        ![request.requestId, request.project, request.board, request.alias, request.operation].every(v => typeof v === 'string' && ID.test(v)) ||
        !Number.isSafeInteger(request.aliasRevision) || request.aliasRevision < 1 || !Number.isSafeInteger(request.sourceRevision) || request.sourceRevision < 1 ||
        !Number.isSafeInteger(request.ttlMs) || request.ttlMs < 1000 || request.ttlMs > 300_000) throw new Error('invalid protected lease request');
    const token = randomBytes(32).toString('hex'), hash = leaseHash(token), now = this.clock();
    if (!Number.isSafeInteger(now) || now < 1) throw new Error('invalid coordinator time');
    return this.withCapability(capability, { role: 'submit', project: request.project, board: request.board, operation: request.operation, job: null, attempt: null }, identity => {
      const fingerprint = parseCanonicalJson(Buffer.from(JSON.stringify({ ...request, principal: identity.principal, capabilityId: identity.capabilityId })),
        { maxBytes: 16_384, maxNodes: 100, maxDepth: 4 }).sha256;
      const prior = this.db.prepare('SELECT fingerprint,generation FROM protected_lease_requests WHERE request_id=?').get(request.requestId) as { fingerprint: string; generation: number } | undefined;
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error('lease request ID reused with different content');
        return { state: 'UNKNOWN', generation: prior.generation } as const;
      }
      const target = this.db.prepare('SELECT revision,alias_revision,state FROM protected_targets WHERE project=? AND board=?').get(request.project, request.board) as { revision: number; alias_revision: number; state: string } | undefined;
      const alias = this.db.prepare('SELECT board,alias_revision FROM protected_aliases WHERE project=? AND alias=?').get(request.project, request.alias) as { board: string; alias_revision: number } | undefined;
      if (!target || target.state !== 'ACTIVE' || target.revision !== request.sourceRevision || target.alias_revision !== request.aliasRevision ||
          !alias || alias.board !== request.board || alias.alias_revision !== request.aliasRevision) throw new Error('protected target, source or alias changed');
      const existing = this.db.prepare('SELECT * FROM protected_leases WHERE project=? AND board=?').get(request.project, request.board) as LeaseRow | undefined;
      if (existing && (existing.pinned !== 0 || existing.expires_at > now)) return { state: 'BUSY' } as const;
      const generation = (existing?.generation ?? 0) + 1; if (!Number.isSafeInteger(generation)) throw new Error('lease generation exhausted');
      const expiresAt = now + request.ttlMs; if (!Number.isSafeInteger(expiresAt)) throw new Error('lease expiry overflow');
      this.db.prepare(`INSERT INTO protected_leases VALUES (?,?,?,?,?,?,0,?,?,?) ON CONFLICT(project,board) DO UPDATE SET
        generation=excluded.generation,token_hash=excluded.token_hash,owner=excluded.owner,expires_at=excluded.expires_at,
        pinned=0,source_revision=excluded.source_revision,alias_revision=excluded.alias_revision,operation=excluded.operation`)
        .run(request.project, request.board, generation, hash, identity.principal, expiresAt, request.sourceRevision, request.aliasRevision, request.operation);
      this.db.prepare('INSERT INTO protected_lease_requests VALUES (?,?,?,?,?)').run(request.requestId, fingerprint, request.project, request.board, generation);
      this.db.prepare('INSERT INTO protected_lease_audit VALUES (?,?,?,?,?,?)').run(request.project, request.board, generation, identity.principal, 'acquired', now);
      return { state: 'ACQUIRED', generation, token, expiresAt } as const;
    });
  }
  /** Pin a live lease before a writer starts. Only a future trusted cleanup/recovery path may remove a pin. */
  pin(capability: string, lease: { project: string; board: string; operation: string; generation: number; token: string }): void {
    if (!lease || ![lease.project, lease.board, lease.operation].every(v => typeof v === 'string' && ID.test(v)) ||
        !Number.isSafeInteger(lease.generation) || lease.generation < 1 || typeof lease.token !== 'string' || !TOKEN.test(lease.token)) throw new Error('invalid protected lease');
    this.withCapability(capability, { role: 'submit', project: lease.project, board: lease.board, operation: lease.operation, job: null, attempt: null }, identity => {
      const now = this.clock(), row = this.db.prepare('SELECT * FROM protected_leases WHERE project=? AND board=?').get(lease.project, lease.board) as LeaseRow | undefined;
      if (!Number.isSafeInteger(now) || now < 1) throw new Error('invalid coordinator time');
      const target = this.db.prepare('SELECT revision,alias_revision,state FROM protected_targets WHERE project=? AND board=?').get(lease.project, lease.board) as { revision: number; alias_revision: number; state: string } | undefined;
      if (!row || row.generation !== lease.generation || row.owner !== identity.principal || row.operation !== lease.operation || row.expires_at <= now ||
          !target || target.state !== 'ACTIVE' || target.revision !== row.source_revision || target.alias_revision !== row.alias_revision ||
          row.token_hash.byteLength !== 32 || !timingSafeEqual(Buffer.from(row.token_hash), leaseHash(lease.token))) throw new Error('protected lease is stale');
      this.db.prepare('UPDATE protected_leases SET pinned=1 WHERE project=? AND board=?').run(lease.project, lease.board);
      if (!row.pinned) this.db.prepare('INSERT INTO protected_lease_audit VALUES (?,?,?,?,?,?)').run(lease.project, lease.board, lease.generation, identity.principal, 'pinned', now);
    });
  }
  /** Expired leases cannot be revived, including while a pin is held. */
  renew(capability: string, lease: { project: string; board: string; operation: string; generation: number; token: string }, ttlMs: number): number {
    if (!lease || ![lease.project, lease.board, lease.operation].every(v => typeof v === 'string' && ID.test(v)) ||
        !Number.isSafeInteger(lease.generation) || lease.generation < 1 || typeof lease.token !== 'string' || !TOKEN.test(lease.token) ||
        !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300_000) throw new Error('invalid protected lease');
    return this.withCapability(capability, { role: 'submit', project: lease.project, board: lease.board, operation: lease.operation, job: null, attempt: null }, identity => {
      const now = this.clock(), row = this.db.prepare('SELECT * FROM protected_leases WHERE project=? AND board=?').get(lease.project, lease.board) as LeaseRow | undefined;
      if (!Number.isSafeInteger(now) || now < 1 || !Number.isSafeInteger(now + ttlMs)) throw new Error('invalid coordinator time');
      if (!row || row.generation !== lease.generation || row.owner !== identity.principal || row.operation !== lease.operation || row.expires_at <= now ||
          row.token_hash.byteLength !== 32 || !timingSafeEqual(Buffer.from(row.token_hash), leaseHash(lease.token))) throw new Error('protected lease is stale');
      const expiresAt = now + ttlMs;
      this.db.prepare('UPDATE protected_leases SET expires_at=? WHERE project=? AND board=?').run(expiresAt, lease.project, lease.board);
      this.db.prepare('INSERT INTO protected_lease_audit VALUES (?,?,?,?,?,?)').run(lease.project, lease.board, lease.generation, identity.principal, 'renewed', now);
      return expiresAt;
    });
  }
  /** An unpinned lease can be released; a pinned lease requires trusted cleanup, which is not wired yet. */
  release(capability: string, lease: { project: string; board: string; operation: string; generation: number; token: string }): void {
    if (!lease || ![lease.project, lease.board, lease.operation].every(v => typeof v === 'string' && ID.test(v)) ||
        !Number.isSafeInteger(lease.generation) || lease.generation < 1 || typeof lease.token !== 'string' || !TOKEN.test(lease.token)) throw new Error('invalid protected lease');
    this.withCapability(capability, { role: 'submit', project: lease.project, board: lease.board, operation: lease.operation, job: null, attempt: null }, identity => {
      const now = this.clock(), row = this.db.prepare('SELECT * FROM protected_leases WHERE project=? AND board=?').get(lease.project, lease.board) as LeaseRow | undefined;
      if (!Number.isSafeInteger(now) || now < 1) throw new Error('invalid coordinator time');
      if (!row || row.pinned !== 0 || row.generation !== lease.generation || row.owner !== identity.principal || row.operation !== lease.operation ||
          row.token_hash.byteLength !== 32 || !timingSafeEqual(Buffer.from(row.token_hash), leaseHash(lease.token))) throw new Error('protected lease cannot be released');
      this.db.prepare('UPDATE protected_leases SET token_hash=?,owner=?,expires_at=0 WHERE project=? AND board=?').run(Buffer.alloc(32), '', lease.project, lease.board);
      this.db.prepare('INSERT INTO protected_lease_audit VALUES (?,?,?,?,?,?)').run(lease.project, lease.board, lease.generation, identity.principal, 'released', now);
    });
  }
}
