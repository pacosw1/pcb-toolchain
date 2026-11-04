// JSON evidence files: written whole or not at all, in the same text Python's json.dump gave.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { jsonDumps } from './py-compat.mjs';

const CHUNK_BYTES = 1024 * 1024;

export const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

function assertFinite(value: unknown): void {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError(`not a JSON number: ${value}`);
  if (Array.isArray(value)) value.forEach(assertFinite);
  else if (value instanceof Map) [...value.values()].forEach(assertFinite);
  else if (value !== null && typeof value === 'object') Object.values(value).forEach(assertFinite);
}

/** Indent 2 and a final newline. The temporary file sits next to the target so the rename is atomic. */
export function atomicJson(path: string, data: unknown): void {
  assertFinite(data);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.tmp-${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(temporary, `${jsonDumps(data, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function sha256File(path: string): string {
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
  const file = openSync(path, 'r');
  try {
    for (let read = readSync(file, chunk); read > 0; read = readSync(file, chunk)) hash.update(chunk.subarray(0, read));
  } finally {
    closeSync(file);
  }
  return hash.digest('hex');
}
