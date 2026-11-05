import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCanonicalJson } from '../src/canonical-json.ts';
import { parseProjectManifest } from '../src/protected-manifest.ts';
const encode = (v: unknown): Buffer => parseCanonicalJson(Buffer.from(JSON.stringify(v)), { maxBytes: 1024 * 1024, maxNodes: 1000, maxDepth: 12 }).canonical;
const doc = () => ({ schema: 'pcb.project-manifest.v1', project_id: 'p', entries: [
  { kind: 'link', path: 'board/ref', target: '../lib/file' },
  { kind: 'file', path: 'lib/file', sha256: 'a'.repeat(64), size: 1, executable: false },
], required_paths: ['board/ref'], optional_absent_paths: ['config/optional'], external_mounts: [{ path: 'vendor', manifest_sha256: 'b'.repeat(64) }] });
test('parses and binds a canonical manifest with required, absent, link and external declarations', () => {
  const parsed = parseProjectManifest(encode(doc()));
  assert.equal(parsed.manifest.entries.length, 2);
  assert.equal(parsed.manifest.external_mounts[0].manifest_sha256, 'b'.repeat(64));
  assert.match(parsed.sha256, /^[0-9a-f]{64}$/);
});
test('rejects noncanonical bytes, missing inputs, escaping links and overlapping mounts', () => {
  assert.throws(() => parseProjectManifest(Buffer.from(JSON.stringify(doc()))), /canonical/);
  const missing = doc(); missing.required_paths = ['missing']; assert.throws(() => parseProjectManifest(encode(missing)), /required/);
  const escape = doc(); escape.entries[0].target = '../../escape'; assert.throws(() => parseProjectManifest(encode(escape)), /escapes/);
  const overlap = doc(); overlap.external_mounts[0].path = 'lib'; assert.throws(() => parseProjectManifest(encode(overlap)), /overlaps/);
});
