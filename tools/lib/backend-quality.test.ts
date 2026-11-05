import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { bind, LOCK, PATCH, requireCapability, UPSTREAM } from './backend-quality.ts';
import { sha256File } from './json-file.ts';

let dir: string;
let binary: string;
let evidence: string;
let manifest: string;
let data: Record<string, unknown>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'backend-quality-'));
  binary = join(dir, 'binary');
  evidence = join(dir, 'native-evidence');
  manifest = join(dir, 'manifest.json');
  writeFileSync(binary, 'fixture artifact');
  writeFileSync(evidence, 'fixture validation');
  data = {
    schema: 1, upstream_commit: UPSTREAM, cargo_lock_sha256: LOCK, patch_sha256: sha256File(PATCH),
    binary_sha256: sha256File(binary),
    native_validation: { status: 'passed', evidence: [{ path: evidence, sha256: sha256File(evidence) }] },
  };
});
afterEach(() => rmSync(dir, { recursive: true }));

function bound(value: unknown = data) {
  writeFileSync(manifest, JSON.stringify(value));
  return bind(binary, manifest);
}

test('a bound artifact reports its provenance and needs the quality capability', () => {
  assert.deepEqual(bound(), {
    mode: 'quality-first', manifest: realpathSync(manifest), manifest_sha256: sha256File(manifest),
    binary_sha256: data.binary_sha256, patch_sha256: data.patch_sha256, upstream_commit: UPSTREAM, qualified: false,
  });
  requireCapability(' --quality-first reject new identities');
  assert.throws(() => requireCapability('ordinary unpatched backend'), /lacks required --quality-first/);
});

test('a changed artifact cannot reuse the validation', () => {
  writeFileSync(binary, 'replacement');
  assert.throws(() => bound(), /binary hash mismatch/);
});

test('a different source, patch or lock cannot bind', () => {
  for (const key of ['upstream_commit', 'patch_sha256', 'cargo_lock_sha256']) {
    assert.throws(() => bound({ ...data, [key]: '0'.repeat(64) }), /source\/patch\/lock provenance mismatch/);
  }
});

test('a schema other than the integer 1 cannot bind', () => {
  for (const schema of [2, '1', true, null]) {
    assert.throws(() => bound({ ...data, schema }), /provenance mismatch/);
  }
  assert.throws(() => bound([data]), /provenance schema invalid/);
});

test('missing, changed or malformed native evidence is rejected', () => {
  const cases: [unknown, RegExp][] = [
    [{}, /evidence unavailable/],
    [{ status: 'passed', evidence: [] }, /evidence unavailable/],
    [[], /validation schema invalid/],
    [null, /validation schema invalid/],
    [{ status: 'passed', evidence: [{ path: evidence, sha256: [] }] }, /evidence schema invalid/],
    [{ status: 'passed', evidence: [{ path: 'native-evidence', sha256: 'a'.repeat(64) }] }, /evidence hash mismatch/],
    [{ status: 'passed', evidence: [{ path: join(dir, 'gone'), sha256: 'a'.repeat(64) }] }, /evidence hash mismatch/],
  ];
  for (const [validation, message] of cases) {
    assert.throws(() => bound({ ...data, native_validation: validation }), message);
  }
  const { native_validation: _dropped, ...withoutValidation } = data;
  assert.throws(() => bound(withoutValidation), /evidence unavailable/);
  writeFileSync(evidence, 'changed proof');
  assert.throws(() => bound(), /evidence hash mismatch/);
});

test('the legacy mode never claims quality or validation', () => {
  assert.deepEqual(bind(binary, null), { mode: 'legacy-unverified', qualified: false });
  assert.throws(() => bind(binary, ''));
});
