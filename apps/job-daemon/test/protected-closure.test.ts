import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCanonicalJson } from '../src/canonical-json.ts';
import { resolveManifestClosure } from '../src/protected-closure.ts';
import { materializeSnapshot } from '../src/protected-materialize.ts';
const encode = (v: unknown): Buffer => parseCanonicalJson(Buffer.from(JSON.stringify(v)), { maxBytes: 10000, maxNodes: 1000, maxDepth: 12 }).canonical;
const sha = (v: Buffer): string => createHash('sha256').update(v).digest('hex');
const limits = { maxDepth: 4, maxManifests: 8, maxNodes: 10, maxBytes: 100, maxManifestBytes: 10_000 };
test('traverses external manifest references and prefixes their paths', () => {
  const content = Buffer.from('part'), fileHash = sha(content);
  const external = encode({ schema: 'pcb.project-manifest.v1', project_id: 'library', entries: [{ kind: 'file', path: 'part', sha256: fileHash, size: content.length, executable: false }],
    required_paths: ['part'], optional_absent_paths: [], external_mounts: [] });
  const root = encode({ schema: 'pcb.project-manifest.v1', project_id: 'project', entries: [], required_paths: [], optional_absent_paths: [],
    external_mounts: [{ path: 'vendor', manifest_sha256: sha(external) }] });
  const manifests = new Map([[sha(root), root], [sha(external), external]]);
  const read = (hash: string): Buffer => { const value = manifests.get(hash); if (!value) throw Error('manifest unavailable'); return value; };
  const closure = resolveManifestClosure(sha(root), read, hash => hash === fileHash ? content.length : null, limits);
  assert.equal(closure.rootProject, 'project'); assert.equal(closure.nodes[0].path, 'vendor/part'); assert.equal(closure.manifests.length, 2);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-closure-'));
  try {
    const snapshot = materializeSnapshot(parent, closure.nodes, () => content, { maxFiles: 10, maxBytes: 100 });
    assert.deepEqual(fs.readFileSync(path.join(snapshot, 'vendor/part')), content);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
  assert.throws(() => resolveManifestClosure(sha(root), read, () => null, limits), /file blob unavailable/);
  assert.throws(() => resolveManifestClosure(sha(root), read, () => content.length, { ...limits, maxDepth: 1 }), /limit/);
  assert.throws(() => resolveManifestClosure(sha(root), () => external, () => content.length, limits), /hash mismatch/);
});
