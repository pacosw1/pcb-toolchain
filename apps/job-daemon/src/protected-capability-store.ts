// Internal capability registry in the canonical authority database. Not exposed as an API.
// Issuance/revocation require a future authenticated administrator path; callers must not map these methods directly
// to network requests. A lost issuance response returns UNKNOWN, never a second bearer.
import { randomUUID } from 'node:crypto';
import { parseCanonicalJson } from './canonical-json.ts';
import { capabilityHash, newCapability, scopeMatches, validateScope, verifyCapability } from './protected-capability.ts';
import type { CapabilityScope, CapabilityTarget } from './protected-capability.ts';
import { ProtectedBlobs } from './protected-blobs.ts';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
type Row = { id: string; request_id: string; fingerprint: string; token_hash: Uint8Array; scope: string; uses: number; revoked: number; boot_id: string | null };
export type Issuance = { state: 'ISSUED'; id: string; token: string } | { state: 'UNKNOWN'; id: string };

export class ProtectedCapabilityStore extends ProtectedBlobs {
  private wall: () => number;
  private mono: () => bigint;
  private originWall: number;
  private originMono: bigint;
  private lastWall: number;
  protected bootId: string;
  constructor(root: string, limits: { maxBlobBytes: number; quotaBytes: number }, now: () => number = Date.now, monotonic: () => bigint = process.hrtime.bigint) {
    super(root, limits); this.wall = now; this.mono = monotonic; this.originWall = now(); this.originMono = monotonic(); this.lastWall = this.originWall; this.bootId = randomUUID();
    if (!Number.isSafeInteger(this.originWall) || this.originWall < 1) throw new Error('invalid coordinator time');
    this.db.exec(`CREATE TABLE IF NOT EXISTS protected_capabilities (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, token_hash BLOB NOT NULL UNIQUE,
      scope TEXT NOT NULL, uses INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0, boot_id TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS protected_capability_audit (capability_id TEXT NOT NULL, actor TEXT NOT NULL,
      action TEXT NOT NULL, at_ms INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS protected_boot (singleton INTEGER PRIMARY KEY CHECK(singleton=1), boot_id TEXT NOT NULL, last_wall INTEGER NOT NULL) STRICT;`);
    const columns = this.db.prepare('PRAGMA table_info(protected_capabilities)').all() as { name:string }[];
    if (!columns.some(column => column.name === 'boot_id')) this.db.exec('ALTER TABLE protected_capabilities ADD COLUMN boot_id TEXT');
    try {
      this.transaction(() => {
        const previous = this.db.prepare('SELECT last_wall FROM protected_boot WHERE singleton=1').get() as {last_wall:number} | undefined;
        if (previous && this.originWall < previous.last_wall) throw new Error('coordinator clock regressed across restart');
        this.db.prepare('INSERT INTO protected_boot VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET boot_id=excluded.boot_id,last_wall=excluded.last_wall').run(this.bootId, this.originWall);
      });
    } catch (error) { this.close(); throw error; }
  }
  /** Must run inside the same transaction as the authority action. New instances invalidate old capabilities. */
  protected safeNow(): number {
    const meta = this.db.prepare('SELECT boot_id,last_wall FROM protected_boot WHERE singleton=1').get() as {boot_id:string;last_wall:number} | undefined;
    const now = this.wall(), elapsed = this.mono() - this.originMono;
    if (!meta || meta.boot_id !== this.bootId || !Number.isSafeInteger(now) || now < this.lastWall || now < meta.last_wall || elapsed < 0n ||
        BigInt(now - this.originWall + 1) * 1_000_000n < elapsed) throw new Error('coordinator clock or boot identity is unsafe');
    this.lastWall = now;
    this.db.prepare('UPDATE protected_boot SET last_wall=? WHERE singleton=1').run(now);
    return now;
  }
  /** Trusted service code only; never expose without administrator authorization. */
  issueFromTrustedService(requestId: string, actor: string, scope: CapabilityScope): Issuance {
    if (typeof requestId !== 'string' || !ID.test(requestId) || typeof actor !== 'string' || !ID.test(actor)) throw new Error('invalid issuance identity');
    validateScope(scope);
    const parsed = parseCanonicalJson(Buffer.from(JSON.stringify({ actor, scope })), { maxBytes: 16_384, maxNodes: 100, maxDepth: 4 });
    const encodedScope = parseCanonicalJson(Buffer.from(JSON.stringify(scope)), { maxBytes: 16_384, maxNodes: 100, maxDepth: 4 }).canonical.toString('utf8');
    const token = newCapability(), hash = capabilityHash(token), id = randomUUID();
    return this.transaction(() => {
      const now = this.safeNow();
      if (now < scope.issuedAtMs || now >= scope.expiresAtMs) throw new Error('capability is not currently valid');
      const prior = this.db.prepare('SELECT id,fingerprint FROM protected_capabilities WHERE request_id=?').get(requestId) as { id: string; fingerprint: string } | undefined;
      if (prior) {
        if (prior.fingerprint !== parsed.sha256) throw new Error('issuance request ID reused with different request');
        return { state: 'UNKNOWN', id: prior.id } as const;
      }
      this.db.prepare('INSERT INTO protected_capabilities (id,request_id,fingerprint,token_hash,scope,boot_id) VALUES (?,?,?,?,?,?)')
        .run(id, requestId, parsed.sha256, hash, encodedScope, this.bootId);
      this.db.prepare('INSERT INTO protected_capability_audit VALUES (?,?,?,?)').run(id, actor, 'issued', now);
      return { state: 'ISSUED', id, token } as const;
    });
  }
  /** Trusted service code only; idempotent and never returns a bearer. */
  revokeFromTrustedService(id: string, actor: string): boolean {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id) || typeof actor !== 'string' || !ID.test(actor)) return false;
    return this.transaction(() => {
      const now = this.safeNow();
      const row = this.db.prepare('SELECT revoked FROM protected_capabilities WHERE id=?').get(id) as { revoked: number } | undefined;
      if (!row) return false;
      if (!row.revoked) {
        this.db.prepare('UPDATE protected_capabilities SET revoked=1 WHERE id=?').run(id);
        this.db.prepare('INSERT INTO protected_capability_audit VALUES (?,?,?,?)').run(id, actor, 'revoked', now);
      }
      return true;
    });
  }
  /** DB-only synchronous action: capability use and protected records commit or roll back together.
   * Files must already be durable; never perform external side effects from this callback. */
  protected withCapability<T>(token: string, target: CapabilityTarget, action: (identity: { capabilityId: string; principal: string }) => T): T {
    return this.transaction(() => {
      const now = this.safeNow();
      let hash: Buffer;
      try { hash = capabilityHash(token); } catch { throw new Error('capability is not authorized'); }
      const row = this.db.prepare('SELECT * FROM protected_capabilities WHERE token_hash=?').get(hash) as Row | undefined;
      if (!row || row.boot_id !== this.bootId || !verifyCapability(token, row.token_hash)) throw new Error('capability is not authorized');
      let scope: CapabilityScope;
      try { scope = JSON.parse(row.scope) as CapabilityScope; } catch { throw new Error('capability is not authorized'); }
      if (!scopeMatches(scope, target, now, row.uses, row.revoked !== 0)) throw new Error('capability is not authorized');
      this.db.prepare('UPDATE protected_capabilities SET uses=uses+1 WHERE id=?').run(row.id);
      const result = action({ capabilityId: row.id, principal: scope.principal });
      if (result && typeof result === 'object' && 'then' in result && typeof result.then === 'function')
        throw new Error('protected transaction action must be synchronous');
      return result;
    });
  }
}
