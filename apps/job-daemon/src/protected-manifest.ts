// Draft manifest parser; registration, dependency provenance, collision policy and activation are not implemented.
import { parseCanonicalJson } from './canonical-json.ts';
import { resolveManifestLinks, validateManifestPath } from './protected-link-resolution.ts';
import type { SnapshotNode } from './protected-materialize.ts';

const SHA = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const exact = (x: Record<string, unknown>, keys: string[]): boolean => Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const compare = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
const safePath = (x: unknown): x is string => { if (typeof x !== 'string') return false; try { validateManifestPath(x); return true; } catch { return false; } };
function sortedUnique(paths: unknown): paths is string[] {
  return Array.isArray(paths) && paths.length <= 100_000 && paths.every((x, i) => safePath(x) && (i === 0 || compare(paths[i - 1], x) < 0));
}
export interface ProjectManifest {
  schema: 'pcb.project-manifest.v1'; project_id: string; entries: SnapshotNode[];
  required_paths: string[]; optional_absent_paths: string[];
  external_mounts: { path: string; manifest_sha256: string }[];
}

/** Board-adoption v1 changes only the canonical PCB bytes; other project changes need a different policy. */
export function assertBoardOnlyChange(source: ProjectManifest, candidate: ProjectManifest, boardPath: string): void {
  if (source.schema !== candidate.schema || source.project_id !== candidate.project_id ||
      JSON.stringify(source.required_paths) !== JSON.stringify(candidate.required_paths) ||
      JSON.stringify(source.optional_absent_paths) !== JSON.stringify(candidate.optional_absent_paths) ||
      JSON.stringify(source.external_mounts) !== JSON.stringify(candidate.external_mounts) || source.entries.length !== candidate.entries.length)
    throw new Error('candidate changes project dependencies or paths');
  let found = false;
  for (let i = 0; i < source.entries.length; i++) {
    const before = source.entries[i], after = candidate.entries[i];
    if (before.path === boardPath && after.path === boardPath && before.kind === 'file' && after.kind === 'file') {
      if (before.executable !== after.executable) throw new Error('candidate changes board file mode');
      found = true;
    } else if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('candidate changes a non-board file');
  }
  if (!found) throw new Error('candidate board is unavailable');
}

/** Parses canonical JSON and checks structural references only. It does not establish dependency closure or filesystem compatibility. */
export function parseProjectManifest(bytes: Uint8Array): { manifest: ProjectManifest; sha256: string } {
  const parsed = parseCanonicalJson(bytes, { maxBytes: 8 * 1024 * 1024, maxNodes: 200_000, maxDepth: 12 });
  if (!Buffer.from(bytes).equals(parsed.canonical)) throw new Error('manifest bytes are not canonical JSON');
  const doc = parsed.value;
  if (!object(doc) || !exact(doc, ['schema', 'project_id', 'entries', 'required_paths', 'optional_absent_paths', 'external_mounts']) ||
      doc.schema !== 'pcb.project-manifest.v1' || typeof doc.project_id !== 'string' || !ID.test(doc.project_id) ||
      !Array.isArray(doc.entries) || doc.entries.length > 25_000 || !sortedUnique(doc.required_paths) || !sortedUnique(doc.optional_absent_paths) ||
      !Array.isArray(doc.external_mounts) || doc.external_mounts.length > 1000) throw new Error('invalid project manifest');
  const entries: SnapshotNode[] = []; let previous = '';
  for (const value of doc.entries) {
    if (!object(value) || !safePath(value.path) || (previous && compare(previous, value.path) >= 0)) throw new Error('invalid or unsorted manifest entry');
    previous = value.path;
    if (value.kind === 'file' && exact(value, ['kind', 'path', 'sha256', 'size', 'executable']) && typeof value.sha256 === 'string' && SHA.test(value.sha256) &&
        Number.isSafeInteger(value.size) && (value.size as number) >= 0 && typeof value.executable === 'boolean')
      entries.push({ kind: 'file', path: value.path, sha256: value.sha256, size: value.size as number, executable: value.executable });
    else if (value.kind === 'link' && exact(value, ['kind', 'path', 'target']) && typeof value.target === 'string')
      entries.push({ kind: 'link', path: value.path, target: value.target });
    else throw new Error('invalid manifest entry');
  }
  resolveManifestLinks(entries);
  const paths = new Set(entries.map(e => e.path));
  const directories = new Set<string>();
  for (const entry of entries) { const segments = entry.path.split('/'); for (let i = 1; i < segments.length; i++) directories.add(segments.slice(0, i).join('/')); }
  for (const p of doc.required_paths) if (!paths.has(p) && !directories.has(p)) throw new Error('required manifest path missing');
  for (const p of doc.optional_absent_paths) {
    const parts = p.split('/');
    if (paths.has(p) || directories.has(p) || parts.some((_, i) => i > 0 && paths.has(parts.slice(0, i).join('/'))))
      throw new Error('optional absent path exists or crosses a non-directory');
  }
  const mounts: ProjectManifest['external_mounts'] = []; let prior = '';
  for (const mount of doc.external_mounts) {
    if (!object(mount) || !exact(mount, ['path', 'manifest_sha256']) || !safePath(mount.path) || (prior && compare(prior, mount.path) >= 0) ||
        typeof mount.manifest_sha256 !== 'string' || !SHA.test(mount.manifest_sha256)) throw new Error('invalid external mount');
    const mountPath = mount.path; prior = mountPath;
    if ([...paths, ...doc.optional_absent_paths, ...mounts.map(m => m.path)].some(p => p === mountPath || p.startsWith(mountPath + '/') || mountPath.startsWith(p + '/')) ||
        [...directories].some(p => p === mountPath || p.startsWith(mountPath + '/')))
      throw new Error('external mount overlaps project path');
    mounts.push({ path: mount.path, manifest_sha256: mount.manifest_sha256 });
  }
  return { manifest: { schema: 'pcb.project-manifest.v1', project_id: doc.project_id, entries, required_paths: doc.required_paths,
    optional_absent_paths: doc.optional_absent_paths, external_mounts: mounts }, sha256: parsed.sha256 };
}
