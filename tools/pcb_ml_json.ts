// The finite, unambiguous JSON contract shared by the ML ports. Float preserves Python's 1.0 versus 1 in sealed artifacts.
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute } from 'node:path';
import { utf8Fingerprint } from './lib/fingerprint.ts';
import { sha256File } from './lib/json-file.ts';
import { Float, jsonCanonical, readText, truthy as pyTruthy } from './lib/py-compat.mjs';
import { isFile, joinPath, resolvePath } from './lib/py-path.ts';

export { Float, isFile, sha256File };
export type Numeric = number | bigint | Float;
export type Json = null | boolean | string | Numeric | Json[] | { [key: string]: Json };
export type Obj = { [key: string]: Json };
export type Bindings = Record<string, string>;
export type Closure = Record<string, string | null>;
export const SHA = /^[a-f0-9]{64}$/;
export const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export const resolve = (root: string, path: string): string => resolvePath(joinPath(resolvePath(root), path));
export const hasPath = (path: string): boolean => { try { lstatSync(path); return true; } catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return false;
  throw error;
} };
export const isObject = (value: unknown): value is Obj => value !== null && typeof value === 'object'
  && !Array.isArray(value) && !(value instanceof Float) && Object.getPrototypeOf(value) === Object.prototype;
export const truthy = (value: unknown): boolean => isObject(value) ? Object.keys(value).length > 0 : pyTruthy(value);
export function object(value: unknown, label = 'JSON value'): Obj {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}
export function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
}
export function fingerprint(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA.test(value)) throw new Error(`${label} must be a lowercase SHA256`);
  return value;
}
export const finite = (value: unknown): value is Numeric => (typeof value === 'number' || typeof value === 'bigint' || value instanceof Float)
  && Number.isFinite(value instanceof Float ? value.value : Number(value));
export function number(value: unknown, label = 'value'): number {
  if (!finite(value)) throw new Error(`${label} must be a finite number, not a boolean`);
  return value instanceof Float ? value.value : Number(value);
}
export const float = (value: number): Float => new Float(number(value, 'derived value'));
export const maybeFloat = (value: number | null): Float | null => value === null ? null : float(value);
export function names(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${label} must be a nonempty ordered list`);
  const result = value.map(v => text(v, `${label} name`));
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicate names`);
  return result;
}
export function exactKeys(value: Obj, expected: string[], label: string): void {
  if (Object.keys(value).length !== expected.length || expected.some(k => !Object.hasOwn(value, k))) throw new Error(label);
}
export const without = (value: Obj, key: string): Obj => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));

export function jsonCopy(value: unknown): Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'bigint') return value;
  if (typeof value === 'string') {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw new Error('artifact is not canonical JSON');
    return value;
  }
  if (typeof value === 'number' || value instanceof Float) { number(value, 'JSON number'); return value instanceof Float ? float(value.value) : value; }
  if (Array.isArray(value)) return value.map(jsonCopy);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [jsonCopy(key), jsonCopy(item)]));
  throw new Error('unsupported JSON value');
}
export const artifactIdentity = (value: unknown): string => utf8Fingerprint(jsonCopy(value));
export const same = (left: unknown, right: unknown): boolean => artifactIdentity(left) === artifactIdentity(right);
export const encode = (value: unknown, indent = false, sort = true): string => {
  const canonical = jsonCanonical(jsonCopy(value), { ascii: false, sort });
  if (!indent) return canonical;
  // Format tokens without parsing through JSON.parse, which would lose the distinction between int and float.
  let depth = 0, quoted = false, escaped = false, output = '';
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical[i];
    if (quoted) { output += c; if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; output += c; }
    else if (c === '{' || c === '[') { output += c; if (canonical[i + 1] !== (c === '{' ? '}' : ']')) output += '\n' + '  '.repeat(++depth); else output += canonical[++i]; }
    else if (c === '}' || c === ']') output += '\n' + '  '.repeat(--depth) + c;
    else if (c === ',') output += ',\n' + '  '.repeat(depth);
    else output += c === ':' ? ': ' : c;
  }
  return output;
};

/** A strict parser: duplicate keys and nonfinite numbers are rejected before any seal is trusted. */
export function parseJson(source: string): Json {
  let at = 0;
  const space = () => { while (/[\x20\t\r\n]/.test(source[at] ?? '') && at < source.length) at++; };
  const string = (): string => {
    const begin = at++;
    while (at < source.length) {
      const c = source[at++];
      if (c === '\\') at++;
      else if (c === '"') return JSON.parse(source.slice(begin, at)) as string;
    }
    throw new Error('unterminated JSON string');
  };
  const value = (): Json => {
    space();
    const c = source[at];
    if (c === '"') return string();
    if (c === '{') {
      at++; space();
      const pairs: [string, Json][] = [], seen = new Set<string>();
      if (source[at] === '}') { at++; return {}; }
      for (;;) {
        space(); if (source[at] !== '"') throw new Error('expected JSON object key');
        const key = string();
        if (seen.has(key)) throw new Error('duplicate JSON key: ' + key);
        seen.add(key); space();
        if (source[at++] !== ':') throw new Error('expected JSON colon');
        pairs.push([key, value()]); space();
        if (source[at] === '}') { at++; return Object.fromEntries(pairs); }
        if (source[at++] !== ',') throw new Error('expected JSON comma');
      }
    }
    if (c === '[') {
      at++; space(); const values: Json[] = [];
      if (source[at] === ']') { at++; return values; }
      for (;;) { values.push(value()); space(); if (source[at] === ']') { at++; return values; } if (source[at++] !== ',') throw new Error('expected JSON comma'); }
    }
    for (const [token, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (source.startsWith(token, at)) { at += token.length; return result; }
    }
    if (/^(?:NaN|[+-]?Infinity)/.test(source.slice(at))) throw new Error('nonfinite JSON number');
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(at))?.[0];
    if (!token) throw new Error('invalid JSON value');
    at += token.length;
    if (/[.eE]/.test(token)) return float(Number(token));
    const integer = BigInt(token);
    return integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer;
  };
  const result = value(); space();
  if (at !== source.length) throw new Error('extra data after JSON value');
  return jsonCopy(result);
}
export const readObject = (path: string): Obj => object(parseJson(readText(path)), `JSON source ${path}`);

export function normalizeInputs(root: string, inputs: unknown): Bindings {
  const source = object(inputs, 'dataset inputs');
  if (!Object.keys(source).length) throw new Error('dataset inputs must contain source artifacts');
  const result: Bindings = {};
  for (const [name, digest] of Object.entries(source)) {
    text(name, 'input path'); fingerprint(digest, 'input hash');
    const key = resolve(root, name);
    if (result[key] !== undefined && result[key] !== digest) throw new Error('conflicting hashes for aliased source artifact: ' + key);
    result[key] = digest as string;
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
export function assertUnchanged(root: string, inputs: unknown): Bindings {
  const normalized = normalizeInputs(root, inputs);
  for (const [name, expected] of Object.entries(normalized)) {
    if (!isFile(name)) throw new Error('source artifact is missing or not a regular file: ' + name);
    if (sha256File(name) !== expected) throw new Error('source artifact changed: ' + name);
  }
  return normalized;
}
export function validateBindings(inputs: unknown): Bindings {
  const value = object(inputs, 'input bindings');
  if (!Object.keys(value).length) throw new Error('input bindings must be a path-to-SHA256 mapping');
  for (const [path, digest] of Object.entries(value)) {
    if (!isAbsolute(path) || typeof digest !== 'string' || !SHA.test(digest)) throw new Error('invalid absolute input binding: ' + path);
  }
  return value as Bindings;
}
export function checkClosure(root: string, closure: Closure): Bindings {
  const existing = Object.fromEntries(Object.entries(closure).filter((entry): entry is [string, string] => entry[1] !== null));
  if (Object.keys(existing).length) assertUnchanged(root, existing);
  for (const [name, digest] of Object.entries(closure)) if (digest === null && hasPath(name)) throw new Error('previously absent ML source appeared: ' + name);
  return existing;
}

/** Publish complete bytes without replacing any file, including a dangling symlink. */
export function writeArtifact(path: string, value: unknown, protectedInputs: Iterable<string> = [], identicalOk = false): void {
  if (new Set([...protectedInputs].map(resolvePath)).has(resolvePath(path))) throw new Error('output would overwrite a consumed input: ' + path);
  const payload = encode(value, true) + '\n';
  if (identicalOk && isFile(path) && readFileSync(path, 'utf8') === payload) return;
  if (hasPath(path)) throw new Error('output already exists: ' + path);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, payload); fsyncSync(fd); } finally { closeSync(fd); }
    linkSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
