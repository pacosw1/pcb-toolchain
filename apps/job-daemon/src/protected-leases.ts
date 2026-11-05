// Draft canonical lease primitive. No network API, project activation or trusted unpin path is exposed yet.
// Legacy checkouts remain a separate, noncanonical system until a deliberate migration disables dual authority.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { parseCanonicalJson } from './canonical-json.ts';
import { ProtectedCapabilityStore } from './protected-capability-store.ts';
import { resolveManifestClosure } from './protected-closure.ts';
import type { ManifestClosure } from './protected-closure.ts';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN = /^[0-9a-f]{64}$/;
interface LeaseRow { generation: number; token_hash: Uint8Array; owner: string; expires_at: number; pinned: number; source_revision: number; alias_revision: number; operation: string; source_manifest: string | null; boot_id: string | null }
export interface ProtectedLeaseRequest { requestId: string; project: string; board: string; alias: string; aliasRevision: number; sourceRevision: number; sourceManifest: string; operation: string; ttlMs: number }
export type ProtectedLeaseResult = { state: 'ACQUIRED'; generation: number; token: string; expiresAt: number } | { state: 'UNKNOWN'; generation: number } | { state: 'BUSY' };
export const protectedLeaseHash = (token: string): Buffer => createHash('sha256').update('pcb.lease.v1\0').update(Buffer.from(token, 'hex')).digest();

export class ProtectedLeaseStore extends ProtectedCapabilityStore {
  protected clock: () => number;
  constructor(root: string, limits: { maxBlobBytes: number; quotaBytes: number }, now: () => number = Date.now, monotonic: () => bigint = process.hrtime.bigint) {
    super(root, limits, now, monotonic); this.clock = () => this.safeNow();
    this.db.exec(`CREATE TABLE IF NOT EXISTS protected_targets (project TEXT NOT NULL, board TEXT NOT NULL,
      revision INTEGER NOT NULL, alias_revision INTEGER NOT NULL, state TEXT NOT NULL, source_manifest TEXT, board_path TEXT, PRIMARY KEY(project,board)) STRICT;
      CREATE TABLE IF NOT EXISTS protected_aliases (project TEXT NOT NULL, alias TEXT NOT NULL, board TEXT NOT NULL,
      alias_revision INTEGER NOT NULL, PRIMARY KEY(project,alias)) STRICT;
      CREATE TABLE IF NOT EXISTS protected_leases (project TEXT NOT NULL, board TEXT NOT NULL, generation INTEGER NOT NULL,
      token_hash BLOB NOT NULL, owner TEXT NOT NULL, expires_at INTEGER NOT NULL, pinned INTEGER NOT NULL,
      source_revision INTEGER NOT NULL, alias_revision INTEGER NOT NULL, operation TEXT NOT NULL, source_manifest TEXT, boot_id TEXT, PRIMARY KEY(project,board)) STRICT;
      CREATE TABLE IF NOT EXISTS protected_lease_requests (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
      project TEXT NOT NULL, board TEXT NOT NULL, generation INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS protected_lease_audit (project TEXT NOT NULL, board TEXT NOT NULL, generation INTEGER NOT NULL,
      actor TEXT NOT NULL, action TEXT NOT NULL, at_ms INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS protected_attempt_bindings (job TEXT NOT NULL, attempt TEXT NOT NULL,
      project TEXT NOT NULL, board TEXT NOT NULL, generation INTEGER NOT NULL, source_revision INTEGER NOT NULL,
      alias_revision INTEGER NOT NULL, operation TEXT NOT NULL, source_manifest TEXT NOT NULL, policy_digest TEXT NOT NULL,
      runtime_digest TEXT NOT NULL, toolchain_digest TEXT NOT NULL, PRIMARY KEY(job,attempt),
      UNIQUE(project,board,generation)) STRICT;`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS protected_blob_pins (kind TEXT NOT NULL, owner TEXT NOT NULL, sha256 TEXT NOT NULL,
      PRIMARY KEY(kind,owner,sha256)) STRICT;
      CREATE TABLE IF NOT EXISTS protected_attempt_cancellation (job TEXT NOT NULL, attempt TEXT NOT NULL, cancelled INTEGER NOT NULL,
        PRIMARY KEY(job,attempt)) STRICT;`);
    const columns = this.db.prepare('PRAGMA table_info(protected_targets)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'source_manifest')) this.db.exec('ALTER TABLE protected_targets ADD COLUMN source_manifest TEXT');
    if (!columns.some(column => column.name === 'board_path')) this.db.exec('ALTER TABLE protected_targets ADD COLUMN board_path TEXT');
    const leaseColumns = this.db.prepare('PRAGMA table_info(protected_leases)').all() as { name: string }[];
    if (!leaseColumns.some(column => column.name === 'source_manifest')) this.db.exec('ALTER TABLE protected_leases ADD COLUMN source_manifest TEXT');
    if (!leaseColumns.some(column => column.name === 'boot_id')) this.db.exec('ALTER TABLE protected_leases ADD COLUMN boot_id TEXT');
  }
  /** Called inside the authoritative transaction. Future GC must consider every row here before deleting blobs. */
  protected pinBlobs(kind: string, owner: string, hashes: Iterable<string>): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO protected_blob_pins VALUES (?,?,?)');
    for (const hash of new Set(hashes)) {
      if (!this.blobReady(hash)) throw new Error('cannot pin unavailable protected blob');
      insert.run(kind, owner, hash);
    }
  }
  protected pinClosure(kind: string, owner: string, closure: ManifestClosure): void {
    this.pinBlobs(kind, owner, [...closure.manifests, ...closure.nodes.filter(node => node.kind === 'file').map(node => node.sha256)]);
  }
  /** Startup reconciliation only. A previous-boot lease that was never pinned or bound cannot have started an
   * authorized writer: pin/binding and boot validation are serialized in this same database. Never call this for
   * direct checkout writers or expose it as an unauthenticated network endpoint. */
  recoverUnusedFromPriorBoot(project: string, board: string, generation: number): boolean {
    if (![project, board].every(v => typeof v === 'string' && ID.test(v)) || !Number.isSafeInteger(generation) || generation < 1)
      throw new Error('invalid protected recovery target');
    return this.transaction(() => {
      const now = this.safeNow();
      const row = this.db.prepare('SELECT * FROM protected_leases WHERE project=? AND board=?').get(project, board) as LeaseRow | undefined;
      if (!row || row.generation !== generation || row.boot_id === this.bootId || row.pinned !== 0 || row.owner === '') return false;
      const attempt = this.db.prepare('SELECT 1 AS found FROM protected_attempt_bindings WHERE project=? AND board=? AND generation=?').get(project, board, generation);
      if (attempt) return false;
      const changed = this.db.prepare('UPDATE protected_leases SET token_hash=?,owner=?,expires_at=0 WHERE project=? AND board=? AND generation=? AND pinned=0')
        .run(Buffer.alloc(32), '', project, board, generation);
      if (changed.changes !== 1) throw new Error('protected lease changed during recovery');
      this.db.prepare('INSERT INTO protected_lease_audit VALUES (?,?,?,?,?,?)').run(project, board, generation, 'coordinator', 'unused-prior-boot-recovered', now);
      return true;
    });
  }
  /** Stage a durable attempt binding and pin atomically before dispatch. The caller must separately establish
   * the identities and immutable inputs; this method alone does not authorize a worker or verify a job. */
  bindAttempt(capability: string, lease: { project: string; board: string; operation: string; generation: number; token: string },
    binding: { job: string; attempt: string; sourceManifest: string; policyDigest: string; runtimeDigest: string; toolchainDigest: string }): void {
    const sha = /^[0-9a-f]{64}$/;
    if (!lease || ![lease.project, lease.board, lease.operation].every(v => typeof v === 'string' && ID.test(v)) ||
        !Number.isSafeInteger(lease.generation) || lease.generation < 1 || typeof lease.token !== 'string' || !TOKEN.test(lease.token) ||
        !binding || ![binding.job, binding.attempt].every(v => typeof v === 'string' && ID.test(v)) ||
        ![binding.sourceManifest, binding.policyDigest, binding.runtimeDigest, binding.toolchainDigest].every(v => typeof v === 'string' && sha.test(v)))
      throw new Error('invalid protected attempt binding');
    this.withCapability(capability, { role: 'submit', project: lease.project, board: lease.board, operation: lease.operation, job: null, attempt: null }, identity => {
      const now = this.clock(), row = this.db.prepare('SELECT * FROM protected_leases WHERE project=? AND board=?').get(lease.project, lease.board) as LeaseRow | undefined;
      const target = this.db.prepare('SELECT revision,alias_revision,state,source_manifest,board_path FROM protected_targets WHERE project=? AND board=?').get(lease.project, lease.board) as { revision: number; alias_revision: number; state: string; source_manifest: string | null; board_path: string | null } | undefined;
      if (!Number.isSafeInteger(now) || now < 1 || !row || row.boot_id !== this.bootId || row.generation !== lease.generation || row.owner !== identity.principal ||
          row.operation !== lease.operation || row.expires_at <= now || !target || target.state !== 'ACTIVE' || target.revision !== row.source_revision ||
          target.alias_revision !== row.alias_revision || row.source_manifest !== binding.sourceManifest || target.source_manifest !== binding.sourceManifest || !this.blobReady(binding.sourceManifest) ||
          row.token_hash.byteLength !== 32 || !timingSafeEqual(Buffer.from(row.token_hash), protectedLeaseHash(lease.token)))
        throw new Error('protected lease cannot bind attempt');
      const blob = this.db.prepare("SELECT size FROM protected_uploads WHERE sha256=? AND state='ready'");
      const source = resolveManifestClosure(binding.sourceManifest, sha => this.read(sha), sha => {
        const stored = blob.get(sha) as { size: number } | undefined; return stored?.size ?? null;
      }, { maxDepth: 16, maxManifests: 256, maxNodes: 100_000, maxBytes: 64 * 1024 ** 3, maxManifestBytes: 64 * 1024 ** 2 });
      if (source.rootProject !== lease.project) throw new Error('protected source manifest does not match target');
      if (!target.board_path || !source.rootManifest.required_paths.includes(target.board_path) ||
          !source.rootManifest.entries.some(entry => entry.kind === 'file' && entry.path === target.board_path))
        throw new Error('protected board is absent from the source manifest');
      this.pinClosure('attempt-source', JSON.stringify([binding.job, binding.attempt]), source);
      this.pinClosure('revision', JSON.stringify([lease.project, lease.board, row.source_revision]), source);
      const prior = this.db.prepare('SELECT * FROM protected_attempt_bindings WHERE job=? AND attempt=?').get(binding.job, binding.attempt) as
        { project: string; board: string; generation: number; source_revision: number; alias_revision: number; operation: string;
          source_manifest: string; policy_digest: string; runtime_digest: string; toolchain_digest: string } | undefined;
      if (prior) {
        if (row.pinned !== 1 || prior.project !== lease.project || prior.board !== lease.board || prior.generation !== lease.generation ||
            prior.source_revision !== row.source_revision || prior.alias_revision !== row.alias_revision || prior.operation !== lease.operation ||
            prior.source_manifest !== binding.sourceManifest || prior.policy_digest !== binding.policyDigest || prior.runtime_digest !== binding.runtimeDigest ||
            prior.toolchain_digest !== binding.toolchainDigest) throw new Error('protected attempt binding changed');
        return; // A response lost after commit can be retried without dispatching or repinning a different attempt.
      }
      if (row.pinned !== 0) throw new Error('protected lease cannot bind attempt');
      this.db.prepare('INSERT INTO protected_attempt_bindings VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(binding.job, binding.attempt,
        lease.project, lease.board, lease.generation, row.source_revision, row.alias_revision, lease.operation, binding.sourceManifest,
        binding.policyDigest, binding.runtimeDigest, binding.toolchainDigest);
      this.db.prepare('INSERT INTO protected_attempt_cancellation VALUES (?,?,0)').run(binding.job, binding.attempt);
      this.db.prepare('UPDATE protected_leases SET pinned=1 WHERE project=? AND board=?').run(lease.project, lease.board);
      this.db.prepare('INSERT INTO protected_lease_audit VALUES (?,?,?,?,?,?)').run(lease.project, lease.board, lease.generation, identity.principal, 'attempt-bound', now);
    });
  }
  /** Called only after authenticated submission; only targets activated by a future trusted import can be leased. */
  acquire(capability: string, request: ProtectedLeaseRequest): ProtectedLeaseResult {
    const keys = ['requestId', 'project', 'board', 'alias', 'aliasRevision', 'sourceRevision', 'sourceManifest', 'operation', 'ttlMs'];
    if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).length !== keys.length || !keys.every(k => Object.hasOwn(request, k)) ||
        ![request.requestId, request.project, request.board, request.alias, request.operation].every(v => typeof v === 'string' && ID.test(v)) ||
        !Number.isSafeInteger(request.aliasRevision) || request.aliasRevision < 1 || !Number.isSafeInteger(request.sourceRevision) || request.sourceRevision < 1 ||
        typeof request.sourceManifest !== 'string' || !TOKEN.test(request.sourceManifest) ||
        !Number.isSafeInteger(request.ttlMs) || request.ttlMs < 1000 || request.ttlMs > 300_000) throw new Error('invalid protected lease request');
    const token = randomBytes(32).toString('hex'), hash = protectedLeaseHash(token);
    return this.withCapability(capability, { role: 'submit', project: request.project, board: request.board, operation: request.operation, job: null, attempt: null }, identity => {
      const now = this.clock();
      const fingerprint = parseCanonicalJson(Buffer.from(JSON.stringify({ ...request, principal: identity.principal, capabilityId: identity.capabilityId })),
        { maxBytes: 16_384, maxNodes: 100, maxDepth: 4 }).sha256;
      const prior = this.db.prepare('SELECT fingerprint,generation FROM protected_lease_requests WHERE request_id=?').get(request.requestId) as { fingerprint: string; generation: number } | undefined;
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error('lease request ID reused with different content');
        return { state: 'UNKNOWN', generation: prior.generation } as const;
      }
      const target = this.db.prepare('SELECT revision,alias_revision,state,source_manifest FROM protected_targets WHERE project=? AND board=?').get(request.project, request.board) as { revision: number; alias_revision: number; state: string; source_manifest: string | null } | undefined;
      const alias = this.db.prepare('SELECT board,alias_revision FROM protected_aliases WHERE project=? AND alias=?').get(request.project, request.alias) as { board: string; alias_revision: number } | undefined;
      if (!target || target.state !== 'ACTIVE' || target.revision !== request.sourceRevision || target.alias_revision !== request.aliasRevision || target.source_manifest !== request.sourceManifest || !this.blobReady(request.sourceManifest) ||
          !alias || alias.board !== request.board || alias.alias_revision !== request.aliasRevision) throw new Error('protected target, source or alias changed');
      const existing = this.db.prepare('SELECT * FROM protected_leases WHERE project=? AND board=?').get(request.project, request.board) as LeaseRow | undefined;
      if (existing && (existing.pinned !== 0 || (existing.owner !== '' && (existing.boot_id !== this.bootId || existing.expires_at > now)))) return { state: 'BUSY' } as const;
      const generation = (existing?.generation ?? 0) + 1; if (!Number.isSafeInteger(generation)) throw new Error('lease generation exhausted');
      const expiresAt = now + request.ttlMs; if (!Number.isSafeInteger(expiresAt)) throw new Error('lease expiry overflow');
      this.db.prepare(`INSERT INTO protected_leases (project,board,generation,token_hash,owner,expires_at,pinned,source_revision,alias_revision,operation,source_manifest,boot_id) VALUES (?,?,?,?,?,?,0,?,?,?,?,?) ON CONFLICT(project,board) DO UPDATE SET
        generation=excluded.generation,token_hash=excluded.token_hash,owner=excluded.owner,expires_at=excluded.expires_at,
        pinned=0,source_revision=excluded.source_revision,alias_revision=excluded.alias_revision,operation=excluded.operation,source_manifest=excluded.source_manifest,boot_id=excluded.boot_id`)
        .run(request.project, request.board, generation, hash, identity.principal, expiresAt, request.sourceRevision, request.aliasRevision, request.operation, request.sourceManifest, this.bootId);
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
      const target = this.db.prepare('SELECT revision,alias_revision,state,source_manifest FROM protected_targets WHERE project=? AND board=?').get(lease.project, lease.board) as { revision: number; alias_revision: number; state: string; source_manifest: string | null } | undefined;
      if (!row || row.boot_id !== this.bootId || row.generation !== lease.generation || row.owner !== identity.principal || row.operation !== lease.operation || row.expires_at <= now ||
          !target || target.state !== 'ACTIVE' || target.revision !== row.source_revision || target.alias_revision !== row.alias_revision || !row.source_manifest || target.source_manifest !== row.source_manifest ||
          row.token_hash.byteLength !== 32 || !timingSafeEqual(Buffer.from(row.token_hash), protectedLeaseHash(lease.token))) throw new Error('protected lease is stale');
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
      if (!row || row.boot_id !== this.bootId || row.generation !== lease.generation || row.owner !== identity.principal || row.operation !== lease.operation || row.expires_at <= now ||
          row.token_hash.byteLength !== 32 || !timingSafeEqual(Buffer.from(row.token_hash), protectedLeaseHash(lease.token))) throw new Error('protected lease is stale');
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
      if (!row || row.boot_id !== this.bootId || row.pinned !== 0 || row.generation !== lease.generation || row.owner !== identity.principal || row.operation !== lease.operation ||
          row.token_hash.byteLength !== 32 || !timingSafeEqual(Buffer.from(row.token_hash), protectedLeaseHash(lease.token))) throw new Error('protected lease cannot be released');
      this.db.prepare('UPDATE protected_leases SET token_hash=?,owner=?,expires_at=0 WHERE project=? AND board=?').run(Buffer.alloc(32), '', lease.project, lease.board);
      this.db.prepare('INSERT INTO protected_lease_audit VALUES (?,?,?,?,?,?)').run(lease.project, lease.board, lease.generation, identity.principal, 'released', now);
    });
  }
}
