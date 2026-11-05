// Service-owned immutable content for a future canonical project store. Not exposed as an API yet.
// Reservations are durable before bytes are written; uncertain uploads remain pending and consume quota.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SHA = /^[0-9a-f]{64}$/;
type Row = { sha256: string; size: number; state: 'pending' | 'ready'; upload_id: string };

function privateDirectory(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
  const s = fs.lstatSync(dir);
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) !== 0 || (process.getuid && s.uid !== process.getuid()))
    throw new Error('protected storage must be a private, service-owned directory');
}
function syncDirectory(dir: string): void {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

export class ProtectedBlobs {
  protected db: DatabaseSync;
  private objects: string;
  private incoming: string;
  private maxBlob: number;
  private quota: number;

  constructor(root: string, limits: { maxBlobBytes: number; quotaBytes: number }) {
    if (!path.isAbsolute(root) || !Number.isSafeInteger(limits.maxBlobBytes) || limits.maxBlobBytes < 1 ||
        !Number.isSafeInteger(limits.quotaBytes) || limits.quotaBytes < limits.maxBlobBytes) throw new Error('invalid protected storage limits');
    const parent = fs.lstatSync(path.dirname(root));
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) !== 0 || (process.getuid && parent.uid !== process.getuid()))
      throw new Error('protected storage parent must be service-owned and not writable by others');
    privateDirectory(root);
    this.objects = path.join(root, 'objects'); this.incoming = path.join(root, 'incoming');
    privateDirectory(this.objects); privateDirectory(this.incoming);
    syncDirectory(root); syncDirectory(path.dirname(root));
    this.maxBlob = limits.maxBlobBytes; this.quota = limits.quotaBytes;
    // The future canonical authority adds its leases, receipts and revisions to this same database.
    const dbFile = path.join(root, 'authority.sqlite');
    const fd = fs.openSync(dbFile, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || (st.mode & 0o077) !== 0 || (process.getuid && st.uid !== process.getuid())) throw new Error('protected upload database is not private');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    syncDirectory(root);
    this.db = new DatabaseSync(dbFile);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS protected_uploads (
        sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, state TEXT NOT NULL,
        upload_id TEXT NOT NULL, created_at INTEGER NOT NULL
      ) STRICT;`);
  }
  protected transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private row(sha: string): Row | undefined {
    return this.db.prepare('SELECT sha256, size, state, upload_id FROM protected_uploads WHERE sha256=?').get(sha) as Row | undefined;
  }
  protected blobReady(sha: string): boolean { return SHA.test(sha) && this.row(sha)?.state === 'ready'; }
  put(expected: string, bytes: Uint8Array): { sha256: string; size: number; reused: boolean } {
    if (!SHA.test(expected) || !(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > this.maxBlob)
      throw new Error('invalid protected blob or hash');
    const content = Buffer.from(bytes);
    if (digest(content) !== expected) throw new Error('invalid protected blob or hash');
    const uploadId = randomUUID(), size = content.byteLength;
    const reused = this.transaction(() => {
      const prior = this.row(expected);
      if (prior) {
        if (prior.state !== 'ready' || prior.size !== size) throw new Error('protected upload is pending or inconsistent');
        return true;
      }
      const used = (this.db.prepare('SELECT COALESCE(SUM(size),0) AS total FROM protected_uploads').get() as { total: number }).total;
      if (!Number.isSafeInteger(used) || used + size > this.quota) throw new Error('protected storage quota exceeded');
      this.db.prepare("INSERT INTO protected_uploads VALUES (?,?, 'pending', ?, ?)").run(expected, size, uploadId, Date.now());
      return false;
    });
    if (reused) { this.read(expected); return { sha256: expected, size, reused: true }; }
    const temp = path.join(this.incoming, uploadId), dest = path.join(this.objects, expected);
    try {
      const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.linkSync(temp, dest); // Never replace an existing object.
      syncDirectory(this.objects);
      fs.unlinkSync(temp); syncDirectory(this.incoming);
      this.transaction(() => {
        const current = this.row(expected);
        if (!current || current.state !== 'pending' || current.upload_id !== uploadId) throw new Error('protected upload reservation changed');
        this.db.prepare("UPDATE protected_uploads SET state='ready' WHERE sha256=? AND upload_id=?").run(expected, uploadId);
      });
      return { sha256: expected, size, reused: false };
    } catch (error) {
      // A crash or I/O error may have persisted bytes. Keep the reservation until explicit safe recovery.
      throw new Error(`protected upload outcome is unknown: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  read(sha: string): Buffer {
    if (!SHA.test(sha)) throw new Error('invalid protected blob hash');
    const row = this.row(sha); if (!row || row.state !== 'ready') throw new Error('protected blob is unavailable');
    const fd = fs.openSync(path.join(this.objects, sha), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size !== row.size || stat.size > this.maxBlob || (stat.mode & 0o077) !== 0 ||
          (process.getuid && stat.uid !== process.getuid())) throw new Error('protected blob metadata changed');
      const bytes = fs.readFileSync(fd);
      if (bytes.length !== row.size || digest(bytes) !== sha) throw new Error('protected blob hash changed');
      return bytes;
    } finally { fs.closeSync(fd); }
  }
  pending(): { sha256: string; size: number; upload_id: string }[] {
    return this.db.prepare("SELECT sha256,size,upload_id FROM protected_uploads WHERE state='pending' ORDER BY created_at").all() as { sha256: string; size: number; upload_id: string }[];
  }
  close(): void { this.db.close(); }
}
