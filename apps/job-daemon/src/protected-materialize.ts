// Temporary snapshot materialization primitive. It does not import, activate or authorize projects.
// Callers must establish complete dependency closure, immutable provenance and a versioned path policy first.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveManifestLinks } from './protected-link-resolution.ts';
import type { ManifestNode } from './protected-link-resolution.ts';

export type SnapshotNode = (ManifestNode & { kind: 'file'; size: number; executable: boolean }) | (ManifestNode & { kind: 'link' });

/** Materialize only into a newly created private child, detecting collisions on the actual destination filesystem. */
export function materializeSnapshot(parent: string, nodes: readonly SnapshotNode[], readBlob: (sha256: string) => Uint8Array,
  limits: { maxFiles: number; maxBytes: number }): string {
  if (!path.isAbsolute(parent) || !Number.isSafeInteger(limits.maxFiles) || limits.maxFiles < 1 || limits.maxFiles > 100_000 ||
      !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1 || nodes.length > limits.maxFiles) throw new Error('invalid snapshot limits');
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
    throw new Error('snapshot parent must be private and service-owned');
  const links = resolveManifestLinks(nodes);
  let total = 0;
  for (const node of nodes) if (node.kind === 'file') {
    if (!Number.isSafeInteger(node.size) || node.size < 0 || typeof node.executable !== 'boolean' || !Number.isSafeInteger(total += node.size) || total > limits.maxBytes)
      throw new Error('snapshot file limits exceeded');
  }
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'snapshot-')));
  try {
    fs.chmodSync(root, 0o700);
    const directories = new Set<string>();
    for (const node of nodes) {
      const parts = node.path.split('/');
      for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
    }
    const ordered = [...directories].sort((a, b) => a.split('/').length - b.split('/').length || Buffer.compare(Buffer.from(a), Buffer.from(b)));
    for (const directory of ordered) fs.mkdirSync(path.join(root, directory), { mode: 0o700 }); // EEXIST also rejects filesystem-equivalent spellings.
    for (const node of nodes) if (node.kind === 'file') {
      const content = readBlob(node.sha256);
      if (!(content instanceof Uint8Array) || content.byteLength !== node.size || createHash('sha256').update(content).digest('hex') !== node.sha256)
        throw new Error('snapshot blob mismatch');
      const fd = fs.openSync(path.join(root, node.path), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, content); fs.fchmodSync(fd, node.executable ? 0o755 : 0o644); } finally { fs.closeSync(fd); }
    }
    // Links are created only after all files and directories, so they are never followed during construction.
    for (const node of nodes) if (node.kind === 'link') fs.symlinkSync(node.target, path.join(root, node.path));
    for (const link of links) {
      const resolved = fs.realpathSync(path.join(root, link.path));
      const expected = fs.realpathSync(path.join(root, link.resolvedPath));
      if ((resolved !== root && !resolved.startsWith(root + path.sep)) || resolved !== expected) throw new Error('snapshot link resolution changed');
    }
    return root;
  } catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
}
