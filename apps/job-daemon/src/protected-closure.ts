// Integrity traversal only: callers must independently authenticate each external mount and dependency provenance.
import { parseProjectManifest } from './protected-manifest.ts';
import type { ProjectManifest } from './protected-manifest.ts';
import { resolveManifestLinks } from './protected-link-resolution.ts';
import type { SnapshotNode } from './protected-materialize.ts';

export interface ManifestClosure {
  rootProject: string; rootManifest: ProjectManifest; nodes: SnapshotNode[]; optionalAbsentPaths: string[]; manifests: string[]; fileBytes: number;
}

/** Traverse immutable manifest references and produce their mounted file tree, bounded against malicious graphs. */
export function resolveManifestClosure(rootHash: string, readManifest: (sha: string) => Uint8Array,
  blobSize: (sha: string) => number | null, limits: { maxDepth: number; maxManifests: number; maxNodes: number; maxBytes: number; maxManifestBytes: number }): ManifestClosure {
  if (!/^[0-9a-f]{64}$/.test(rootHash) || !Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 1 || limits.maxDepth > 32 ||
      !Number.isSafeInteger(limits.maxManifests) || limits.maxManifests < 1 || limits.maxManifests > 10_000 ||
      !Number.isSafeInteger(limits.maxNodes) || limits.maxNodes < 1 || limits.maxNodes > 100_000 ||
      !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 0 || !Number.isSafeInteger(limits.maxManifestBytes) || limits.maxManifestBytes < 1)
    throw new Error('invalid manifest closure limits');
  const nodes: SnapshotNode[] = [], optionalAbsentPaths:string[] = [], manifests: string[] = [], active = new Set<string>(); let fileBytes = 0, manifestBytes = 0, rootProject = '';
  let rootManifest: ProjectManifest | undefined;
  const visit = (hash: string, prefix: string, depth: number): void => {
    if (depth > limits.maxDepth || manifests.length >= limits.maxManifests || active.has(hash)) throw new Error('manifest closure cycle or limit exceeded');
    active.add(hash); manifests.push(hash);
    const before = nodes.length;
    const bytes = readManifest(hash); manifestBytes += bytes.byteLength;
    if (!Number.isSafeInteger(manifestBytes) || manifestBytes > limits.maxManifestBytes) throw new Error('manifest closure byte limit exceeded');
    const parsed = parseProjectManifest(bytes);
    if (parsed.sha256 !== hash) throw new Error('manifest closure hash mismatch');
    if (depth === 1) { rootProject = parsed.manifest.project_id; rootManifest = parsed.manifest; }
    for (const entry of parsed.manifest.entries) {
      if (nodes.length >= limits.maxNodes) throw new Error('manifest closure node limit exceeded');
      if (entry.kind === 'file') {
        if (blobSize(entry.sha256) !== entry.size) throw new Error('manifest closure file blob unavailable');
        fileBytes += entry.size; if (!Number.isSafeInteger(fileBytes) || fileBytes > limits.maxBytes) throw new Error('manifest closure byte limit exceeded');
      }
      nodes.push({ ...entry, path: prefix + entry.path });
    }
    for (const absent of parsed.manifest.optional_absent_paths) {
      if (optionalAbsentPaths.length >= limits.maxNodes) throw new Error('manifest closure absent-path limit exceeded');
      optionalAbsentPaths.push(prefix + absent);
    }
    for (const mount of parsed.manifest.external_mounts) visit(mount.manifest_sha256, prefix + mount.path + '/', depth + 1);
    if (prefix && nodes.length === before) throw new Error('empty external mount is not representable');
    active.delete(hash);
  };
  visit(rootHash, '', 1);
  // Recheck combined namespace and links; materialization must also detect destination-specific collisions.
  resolveManifestLinks(nodes);
  if (!rootManifest) throw new Error('root manifest missing');
  return { rootProject, rootManifest, nodes, optionalAbsentPaths, manifests, fileBytes };
}
