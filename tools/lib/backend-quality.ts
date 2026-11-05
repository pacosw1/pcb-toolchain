// Bind an explicitly selected quality backend to reviewed build and native evidence.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256File } from './json-file.ts';

export const UPSTREAM = 'e5d52c4544795422b8b28077acc0605fdf11265a';
export const LOCK = '4761175c5d8df0ed4c2c69036df2686dc7e3a186cd085d2ae766936134cab9a6';
export const PATCH = fileURLToPath(new URL('../backend-patches/fastroute-quality-773/quality-first.patch', import.meta.url));

const SHA256 = /^[0-9a-f]{64}$/;

// Snake case: these objects are written as they are into the routing evidence files.
export interface LegacyPolicy { mode: 'legacy-unverified'; qualified: false }
export interface QualityPolicy {
  mode: 'quality-first';
  manifest: string;
  manifest_sha256: string;
  binary_sha256: string;
  patch_sha256: string;
  upstream_commit: string;
  qualified: false;
}
type Fields = Record<string, unknown>;

const isFields = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function assertEvidence(item: unknown): void {
  if (!isFields(item) || typeof item.path !== 'string' || typeof item.sha256 !== 'string' || !SHA256.test(item.sha256)) {
    throw new Error('quality backend evidence schema invalid');
  }
  const isFile = isAbsolute(item.path) && statSync(item.path, { throwIfNoEntry: false })?.isFile();
  if (!isFile || sha256File(item.path) !== item.sha256) throw new Error('quality backend native evidence hash mismatch');
}

function assertNativeValidation(validation: unknown): void {
  if (!isFields(validation)) throw new Error('quality backend native validation schema invalid');
  const { status, evidence } = validation;
  if (status !== 'passed' || !Array.isArray(evidence) || evidence.length === 0) {
    throw new Error('quality backend native validation evidence unavailable');
  }
  evidence.forEach(assertEvidence);
}

/** No manifest is the legacy mode, which claims nothing. A manifest must prove source, patch, lock, binary and evidence. */
export function bind(binary: string, manifest: string | null): LegacyPolicy | QualityPolicy {
  if (manifest === null) return { mode: 'legacy-unverified', qualified: false };
  const data: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
  if (!isFields(data)) throw new Error('quality backend provenance schema invalid');
  const patchSha256 = sha256File(PATCH);
  if (data.schema !== 1 || data.upstream_commit !== UPSTREAM || data.cargo_lock_sha256 !== LOCK || data.patch_sha256 !== patchSha256) {
    throw new Error('quality backend source/patch/lock provenance mismatch');
  }
  const binarySha256 = sha256File(binary);
  if (data.binary_sha256 !== binarySha256) throw new Error('quality backend binary hash mismatch');
  const { native_validation: validation = {} } = data;
  assertNativeValidation(validation);
  return {
    mode: 'quality-first',
    manifest: realpathSync(manifest),
    manifest_sha256: sha256File(manifest),
    binary_sha256: binarySha256,
    patch_sha256: patchSha256,
    upstream_commit: UPSTREAM,
    qualified: false,
  };
}

export function requireCapability(helpText: string): void {
  if (!helpText.includes('--quality-first')) throw new Error('quality backend lacks required --quality-first capability');
}
