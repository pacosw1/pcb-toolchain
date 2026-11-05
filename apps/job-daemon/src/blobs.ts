// Files of past jobs by sha256, so a client sends only what the daemon does not have. A job is a manifest of these files;
// the daemon builds the same input.tar.gz a client would send, so the rest of the job path does not change.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { exec, lowPriority } from './docker.ts';
import { HttpError } from './types.ts';

const SHA256 = /^[0-9a-f]{64}$/;
/** Files in one manifest. Above the 2 000 or so of a real job. A default to tune. */
const MAX_FILES = 50_000;
/** How long the tar of a job may take. A default to tune. */
const TAR_MS = 120_000;
/** How often a submit may look for old files. A default to tune. */
const SWEEP_MS = 3_600_000;

export interface ManifestFile {
  path: string;
  sha256: string;
  mode: number;
  mtimeMs: number;
}

export const isSha256 = (s: unknown): s is string => typeof s === 'string' && SHA256.test(s);

/** The tar is extracted as root, so a path that could leave the job folder is refused here. */
function safePath(p: unknown): p is string {
  if (typeof p !== 'string' || p === '' || p.startsWith('/') || p.includes('\0') || p.includes('\\')) return false;
  return p.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

export function parseManifest(raw: unknown): ManifestFile[] {
  const files = (raw as { files?: unknown } | null)?.files;
  if (!Array.isArray(files) || files.length === 0) throw new HttpError(400, 'manifest has no files');
  if (files.length > MAX_FILES) throw new HttpError(413, `manifest over ${MAX_FILES} files`);
  const seen = new Set<string>();
  return files.map((f: Partial<ManifestFile>) => {
    if (!safePath(f?.path)) throw new HttpError(400, `unsafe path in manifest: ${String(f?.path)}`);
    if (!isSha256(f.sha256)) throw new HttpError(400, `bad sha256 for ${f.path}`);
    if (!Number.isInteger(f.mode) || !Number.isFinite(f.mtimeMs)) throw new HttpError(400, `bad mode or mtime for ${f.path}`);
    if (seen.has(f.path)) throw new HttpError(400, `path twice in manifest: ${f.path}`);
    seen.add(f.path);
    // No setuid, setgid or sticky bit: the job folder is unpacked as root.
    return { path: f.path, sha256: f.sha256, mode: (f.mode as number) & 0o777, mtimeMs: f.mtimeMs as number };
  });
}

export class BlobStore {
  private lastSweep = 0;
  private readonly dir: string;
  private readonly incoming: string;
  private readonly keepMs: number;

  constructor(dir: string, incoming: string, keepDays: number) {
    this.dir = dir;
    this.incoming = incoming;
    this.keepMs = keepDays * 86_400_000;
    fs.mkdirSync(dir, { recursive: true });
  }

  private file = (sha: string): string => path.join(this.dir, sha);

  missing(hashes: string[]): string[] {
    const absent: string[] = [];
    const now = new Date();
    for (const hash of new Set(hashes)) {
      try { fs.utimesSync(this.file(hash), now, now); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') absent.push(hash);
        else throw error;
      }
    }
    return absent;
  }

  /** A cached, content-addressed file; callers must validate the hash first. */
  read(sha: string): fs.ReadStream {
    if (!isSha256(sha)) throw new HttpError(400, 'bad sha256');
    const file = this.file(sha);
    if (!fs.existsSync(file)) throw new HttpError(404, 'blob not found');
    try { fs.utimesSync(file, new Date(), new Date()); } catch { /* a concurrent sweep may remove it */ }
    return fs.createReadStream(file);
  }

  /** A body that does not hash to `sha` is dropped, so a stored file is always what its name says. */
  async put(req: http.IncomingMessage, sha: string, maxBytes: number): Promise<void> {
    const tmp = path.join(this.incoming, `${randomBytes(8).toString('hex')}.blob`);
    const hash = createHash('sha256');
    let bytes = 0;
    const check = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        hash.update(chunk);
        cb(bytes > maxBytes ? new HttpError(413, `upload over ${maxBytes} bytes`) : null, chunk);
      },
    });
    try {
      await pipeline(req, check, fs.createWriteStream(tmp));
      if (hash.digest('hex') !== sha) throw new HttpError(400, 'body does not match its sha256');
      await fs.promises.rename(tmp, this.file(sha));
    } finally {
      await fs.promises.rm(tmp, { force: true });
    }
  }

  /** The input tar of a manifest, in the incoming folder. 409 when a file is gone: the client sends it and tries again. */
  async buildTar(files: ManifestFile[], maxBytes: number, signal: AbortSignal): Promise<string> {
    const now = new Date();
    let bytes = 0;
    for (const f of files) {
      try {
        bytes += (await fs.promises.stat(this.file(f.sha256))).size;
        await fs.promises.utimes(this.file(f.sha256), now, now); // in use: the sweep keeps it
      } catch {
        throw new HttpError(409, `not in the cache: ${f.sha256}`);
      }
    }
    if (bytes > maxBytes) throw new HttpError(413, `job over ${maxBytes} bytes`);
    const name = randomBytes(8).toString('hex');
    const stage = path.join(this.incoming, `${name}.stage`);
    const tar = path.join(this.incoming, `${name}.tar.gz`);
    try {
      for (const f of files) {
        const to = path.join(stage, f.path);
        await fs.promises.mkdir(path.dirname(to), { recursive: true });
        await fs.promises.copyFile(this.file(f.sha256), to, fs.constants.COPYFILE_FICLONE);
        await fs.promises.chmod(to, f.mode);
        await fs.promises.utimes(to, f.mtimeMs / 1000, f.mtimeMs / 1000);
      }
      const [cmd, args] = lowPriority('tar', ['-czf', tar, '-C', stage, '.']);
      const r = await exec(cmd, args, TAR_MS, { signal });
      if (r.code !== 0) throw new HttpError(500, 'tar of the manifest failed');
      return tar;
    } catch (e) {
      await fs.promises.rm(tar, { force: true });
      // One manifest path under another: a file where a folder must go.
      if (['ENOTDIR', 'EISDIR', 'EEXIST'].includes((e as NodeJS.ErrnoException).code ?? '')) {
        throw new HttpError(400, 'manifest paths conflict');
      }
      throw e;
    } finally {
      await fs.promises.rm(stage, { recursive: true, force: true });
    }
  }

  /** Drops files no job used for the keep time. A running job does not need them: it has its own input tar. */
  sweep(nowMs: number = Date.now()): void {
    if (nowMs - this.lastSweep < SWEEP_MS) return;
    this.lastSweep = nowMs;
    for (const name of fs.readdirSync(this.dir)) {
      const file = this.file(name);
      if (nowMs - fs.statSync(file).mtimeMs > this.keepMs) fs.rmSync(file, { force: true });
    }
  }
}
