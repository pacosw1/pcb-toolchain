// Internal preparation only: caller must authorize the attempt, policy, runtime and full dependency provenance.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { materializeSnapshot } from './protected-materialize.ts';
import type { ManifestClosure } from './protected-closure.ts';
import type { ProtectedCommitStore } from './protected-commit.ts';

function trustedExecutable(file: string, expected: string): string {
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('invalid archive tool digest');
  const resolved = fs.realpathSync(file); let parent = path.dirname(resolved);
  for (;;) {
    const stat = fs.lstatSync(parent), stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (!stat.isDirectory() || (process.getuid && stat.uid !== 0 && stat.uid !== process.getuid()) || ((stat.mode & 0o022) !== 0 && !stickyRoot)) throw new Error('unsafe archive tool directory');
    const next = path.dirname(parent); if (next === parent) break; parent = next;
  }
  const fd = fs.openSync(resolved,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0 || (process.getuid && stat.uid !== 0 && stat.uid !== process.getuid())) throw new Error('unsafe archive tool');
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024*1024); let n:number;
    while ((n=fs.readSync(fd,buffer,0,buffer.length,null))>0) hash.update(buffer.subarray(0,n));
    if (hash.digest('hex') !== expected) throw new Error('archive tool digest mismatch');
    return resolved;
  } finally { fs.closeSync(fd); }
}

/** Build a gzip tar from a private, hash-checked snapshot. The resulting path is a private scratch artifact. */
export function prepareProtectedInput(parent: string, closure: ManifestClosure, readBlob: (sha: string) => Uint8Array,
  options: { tarPath: string; tarSha256: string; maxFiles: number; maxBytes: number; maxArchiveBytes: number; timeoutMs: number }): { directory: string; archive: string; sha256: string; size: number } {
  if (!path.isAbsolute(options.tarPath) || !Number.isSafeInteger(options.maxArchiveBytes) || options.maxArchiveBytes < 1 ||
      !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 600_000) throw new Error('invalid protected archive limits');
  // /job/out is a separate writable runtime mount; input content must never overlap it.
  if (closure.nodes.some(node => node.path.split('/')[0].toLowerCase() === 'out')) throw new Error('snapshot overlaps reserved runtime output');
  const tarPath = trustedExecutable(options.tarPath, options.tarSha256);
  const snapshot = materializeSnapshot(parent, closure.nodes, readBlob, { maxFiles: options.maxFiles, maxBytes: options.maxBytes });
  const directory = fs.mkdtempSync(path.join(parent, 'input-'));
  try {
    if (fs.existsSync(path.join(snapshot, 'out'))) throw new Error('snapshot overlaps reserved runtime output');
    const archive = path.join(directory, 'input.tar.gz');
    const result = spawnSync(tarPath, ['-czf', archive, '-C', snapshot, '.'], { timeout: options.timeoutMs, maxBuffer: 1024 * 1024, stdio: ['ignore','ignore','pipe'] });
    if (result.error || result.status !== 0) throw new Error('protected archive creation failed');
    if (trustedExecutable(tarPath, options.tarSha256) !== tarPath) throw new Error('archive tool changed during packaging');
    const fd = fs.openSync(archive, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size < 1 || stat.size > options.maxArchiveBytes || (process.getuid && stat.uid !== process.getuid()))
        throw new Error('invalid protected archive');
      const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024); let n: number;
      while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, n));
      fs.fchmodSync(fd, 0o600); fs.fsyncSync(fd);
      const dirFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      return { directory, archive, sha256: digest.digest('hex'), size: stat.size };
    } finally { fs.closeSync(fd); }
  } catch (error) { fs.rmSync(directory, { recursive:true, force:true }); throw error; }
  finally { fs.rmSync(snapshot, { recursive:true, force:true }); }
}

/** Prepare only from the authority-bound source and discard the archive if the lease changes during packaging. */
export function prepareAttemptInput(authority: ProtectedCommitStore, ref: {project:string;board:string;operation:string;job:string;attempt:string},
  parent: string, options: {tarPath:string;tarSha256:string;maxFiles:number;maxBytes:number;maxArchiveBytes:number;timeoutMs:number}):
  {directory:string;archive:string;sha256:string;size:number;sourceManifest:string;archiveToolSha256:string} {
  const source = authority.sourceForAttemptFromTrustedService(ref);
  if (!authority.approvedArtifactFromTrustedService('archive-tool',options.tarSha256)) throw new Error('archive tool is not approved');
  const prepared = prepareProtectedInput(parent, source.closure, sha => authority.read(sha), options);
  try {
    const current = authority.sourceForAttemptFromTrustedService(ref);
    if (current.manifest !== source.manifest) throw new Error('protected source changed during packaging');
    if (!authority.approvedArtifactFromTrustedService('archive-tool',options.tarSha256)) throw new Error('archive tool approval changed');
    return {...prepared,sourceManifest:source.manifest,archiveToolSha256:options.tarSha256};
  } catch (error) { fs.rmSync(prepared.directory,{recursive:true,force:true}); throw error; }
}
