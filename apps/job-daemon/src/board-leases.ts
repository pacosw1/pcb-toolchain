// Durable coordinator-side leases. Write paths must enforce fencing separately.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

export interface BoardLease { board: string; owner: string; generation: number; token: string; expiresAt: number }
type Row = { generation: number; owner: string | null; token: string | null; expires_at: number };

export class BoardLeases {
  private db: DatabaseSync;
  private now: () => number;
  constructor(file: string, now: () => number = Date.now) {
    this.now = now;
    if (file !== ':memory:') {
      const secure = (name: string, create: boolean): void => {
        let fd: number;
        try { fd = fs.openSync(name, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | (create ? fs.constants.O_CREAT : 0), 0o600); }
        catch (error) { if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
        try { if (!fs.fstatSync(fd).isFile()) throw new Error('board revision database must be a regular file'); fs.fchmodSync(fd, 0o600); }
        finally { fs.closeSync(fd); }
      };
      secure(file, true); secure(file + '-wal', false); secure(file + '-shm', false);
    }
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS board_leases (board TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      owner TEXT, token TEXT, expires_at INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE TABLE IF NOT EXISTS board_revisions (board TEXT PRIMARY KEY, sha256 TEXT NOT NULL,
        content BLOB NOT NULL, generation INTEGER NOT NULL, revision INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS board_revision_history (board TEXT NOT NULL, revision INTEGER NOT NULL,
        sha256 TEXT NOT NULL, content BLOB NOT NULL, generation INTEGER NOT NULL, owner TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY(board, revision)) STRICT;
      CREATE TABLE IF NOT EXISTS board_commits (board TEXT PRIMARY KEY, generation INTEGER NOT NULL,
        owner TEXT NOT NULL, token TEXT NOT NULL, started_at INTEGER NOT NULL) STRICT;`);
    // Existing installations have only the latest bytes; retain that revision when introducing history.
    this.db.prepare(`INSERT OR IGNORE INTO board_revision_history
      SELECT board, revision, sha256, content, generation, 'migration', ? FROM board_revisions`).run(this.now());
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  private duration(ttl: number): void {
    if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 300_000) throw new Error('invalid lease duration');
  }
  acquire(board: string, owner: string, ttl: number): BoardLease | null {
    if (!board || board.length > 512 || !owner || owner.length > 256) throw new Error('invalid board or owner');
    this.duration(ttl);
    return this.transaction(() => {
      const now = this.now();
      if (this.db.prepare('SELECT 1 FROM board_commits WHERE board = ?').get(board)) return null;
      const old = this.db.prepare('SELECT * FROM board_leases WHERE board = ?').get(board) as Row | undefined;
      if (old && old.expires_at > now) return null;
      const generation = (old?.generation ?? 0) + 1;
      if (!Number.isSafeInteger(generation)) throw new Error('lease generation exhausted');
      const token = randomBytes(32).toString('hex'), expiresAt = now + ttl;
      this.db.prepare(`INSERT INTO board_leases VALUES (?, ?, ?, ?, ?) ON CONFLICT(board) DO UPDATE SET
        generation=excluded.generation, owner=excluded.owner, token=excluded.token, expires_at=excluded.expires_at`)
        .run(board, generation, owner, token, expiresAt);
      return { board, owner, generation, token, expiresAt };
    });
  }
  private matches(lease: BoardLease, now: number): boolean {
    const row = this.db.prepare('SELECT * FROM board_leases WHERE board = ?').get(lease.board) as Row | undefined;
    if (!row || row.generation !== lease.generation || row.owner !== lease.owner || !row.token || row.expires_at <= now) return false;
    const a = Buffer.from(row.token), b = Buffer.from(lease.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  private matchesCommit(lease: BoardLease): boolean {
    const row = this.db.prepare('SELECT generation, owner, token FROM board_commits WHERE board = ?').get(lease.board) as
      { generation: number; owner: string; token: string } | undefined;
    if (!row || row.generation !== lease.generation || row.owner !== lease.owner) return false;
    const a = Buffer.from(row.token), b = Buffer.from(lease.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  valid(lease: BoardLease): boolean { return this.matches(lease, this.now()); }
  status(board: string): { generation: number; owner: string | null; expiresAt: number; commitGeneration: number | null } | null {
    const row = this.db.prepare('SELECT generation, owner, expires_at FROM board_leases WHERE board=?').get(board) as
      { generation: number; owner: string | null; expires_at: number } | undefined;
    if (!row) return null;
    const pin = this.db.prepare('SELECT generation FROM board_commits WHERE board=?').get(board) as { generation: number } | undefined;
    return { generation: row.generation, owner: row.owner, expiresAt: row.expires_at, commitGeneration: pin?.generation ?? null };
  }
  renew(lease: BoardLease, ttl: number): BoardLease | null {
    this.duration(ttl);
    return this.transaction(() => {
      const now = this.now();
      if (!this.matches(lease, now)) return null;
      const expiresAt = now + ttl;
      this.db.prepare('UPDATE board_leases SET expires_at = ? WHERE board = ?').run(expiresAt, lease.board);
      return { ...lease, expiresAt };
    });
  }
  release(lease: BoardLease): boolean {
    return this.transaction(() => {
      if (!this.matches(lease, this.now())) return false;
      if (this.db.prepare('SELECT 1 FROM board_commits WHERE board = ?').get(lease.board)) return false;
      this.db.prepare('UPDATE board_leases SET owner=NULL, token=NULL, expires_at=0 WHERE board = ?').run(lease.board);
      return true;
    });
  }
  /** Pin a lease through a critical write. A crash leaves it pinned: recovery must prove the writer stopped. */
  beginCommit(lease: BoardLease): boolean {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT generation, owner, token FROM board_commits WHERE board = ?').get(lease.board) as
        { generation: number; owner: string; token: string } | undefined;
      if (existing) return existing.generation === lease.generation && existing.owner === lease.owner && existing.token === lease.token;
      if (!this.matches(lease, this.now())) return false;
      this.db.prepare('INSERT INTO board_commits VALUES (?, ?, ?, ?, ?)')
        .run(lease.board, lease.generation, lease.owner, lease.token, this.now());
      return true;
    });
  }
  /** End only the matching pinned commit; lease expiry cannot let another writer enter during it. */
  endCommit(lease: BoardLease): boolean {
    return this.transaction(() => {
      const result = this.db.prepare('DELETE FROM board_commits WHERE board=? AND generation=? AND owner=? AND token=?')
        .run(lease.board, lease.generation, lease.owner, lease.token);
      return result.changes === 1;
    });
  }
  /** Coordinator-owned bytes, not a file in an arbitrary worker checkout. */
  boardMeta(board: string): { sha256: string; generation: number; revision: number } | null {
    const row = this.db.prepare('SELECT sha256, generation, revision FROM board_revisions WHERE board = ?').get(board) as
      { sha256: string; generation: number; revision: number } | undefined;
    return row ?? null;
  }
  listBoards(after: string, limit: number): { boards: { board: string; sha256: string; generation: number; revision: number }[]; next: string | null } {
    if (typeof after !== 'string' || after.length > 512 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('invalid board list');
    const rows = this.db.prepare('SELECT board, sha256, generation, revision FROM board_revisions WHERE board > ? ORDER BY board LIMIT ?')
      .all(after, limit + 1) as { board: string; sha256: string; generation: number; revision: number }[];
    const boards = rows.slice(0, limit);
    return { boards, next: rows.length > limit ? boards[boards.length - 1].board : null };
  }
  readBoard(board: string): { sha256: string; content: Uint8Array; generation: number; revision: number } | null {
    const row = this.db.prepare('SELECT sha256, content, generation, revision FROM board_revisions WHERE board = ?').get(board) as
      { sha256: string; content: Uint8Array; generation: number; revision: number } | undefined;
    return row ?? null;
  }
  readVersion(board: string, revision: number): { sha256: string; content: Uint8Array; generation: number; revision: number } | null {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('invalid board revision');
    const row = this.db.prepare('SELECT sha256, content, generation, revision FROM board_revision_history WHERE board=? AND revision=?')
      .get(board, revision) as { sha256: string; content: Uint8Array; generation: number; revision: number } | undefined;
    return row ?? null;
  }

  /** Fence and compare the previous revision in the same transaction that stores bytes.
   * expected=null permits initial publication only. This does not verify KiCad gates or update checkouts. */
  publish(lease: BoardLease, expected: number | null, content: Uint8Array): { sha256: string; generation: number; revision: number } {
    if (!(content instanceof Uint8Array) || !content.length || content.length > 20 * 1024 * 1024)
      throw new Error('invalid board content size');
    if (expected !== null && (!Number.isSafeInteger(expected) || expected < 1)) throw new Error('invalid expected revision');
    return this.transaction(() => {
      if (!this.matchesCommit(lease)) throw new Error('commit is not pinned by this lease');
      const current = this.db.prepare('SELECT revision FROM board_revisions WHERE board = ?').get(lease.board) as
        { revision: number } | undefined;
      if ((current?.revision ?? null) !== expected) throw new Error('board revision changed');
      const revision = (current?.revision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) throw new Error('board revision exhausted');
      const sha256 = createHash('sha256').update(content).digest('hex');
      this.db.prepare('INSERT INTO board_revision_history VALUES (?,?,?,?,?,?,?)')
        .run(lease.board, revision, sha256, content, lease.generation, lease.owner, this.now());
      this.db.prepare(`INSERT INTO board_revisions VALUES (?, ?, ?, ?, ?) ON CONFLICT(board) DO UPDATE SET
        sha256=excluded.sha256, content=excluded.content, generation=excluded.generation, revision=excluded.revision`)
        .run(lease.board, sha256, content, lease.generation, revision);
      return { sha256, generation: lease.generation, revision };
    });
  }
  close(): void { this.db.close(); }
}
