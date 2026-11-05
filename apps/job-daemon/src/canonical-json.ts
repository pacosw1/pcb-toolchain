// Bounded JSON/JCS parser for protected contracts. Not an authorization boundary.
// Duplicate keys, invalid Unicode and non-safe/nonnegative integers fail before canonicalization.
import { createHash } from 'node:crypto';

export type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue };
export function parseCanonicalJson(input: Uint8Array, limits: { maxBytes: number; maxNodes: number; maxDepth: number }): { value: CanonicalValue; canonical: Buffer; sha256: string } {
  if (!(input instanceof Uint8Array) || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1 || limits.maxBytes > 8 * 1024 * 1024 ||
      !Number.isSafeInteger(limits.maxNodes) || limits.maxNodes < 1 || limits.maxNodes > 200_000 ||
      !Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 1 || limits.maxDepth > 128 || input.byteLength > limits.maxBytes)
    throw new Error('invalid JSON limits');
  let text: string;
  if (input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) throw new Error('invalid JSON UTF-8');
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(input); } catch { throw new Error('invalid JSON UTF-8'); }
  let i = 0, nodes = 0;
  // v1 permits decimal integer tokens only; avoid rounding a fractional/exponent input into a safe integer.
  const numberPattern = /(?:0|[1-9]\d*)/y;
  const fail = (): never => { throw new Error('invalid protected JSON'); };
  const ws = (): void => { while (i < text.length && /[\x20\x09\x0a\x0d]/.test(text[i])) i++; };
  const string = (): string => {
    if (text[i] !== '"') return fail();
    const start = i++; let closed = false;
    while (i < text.length) {
      const c = text[i++];
      if (c === '"') { closed = true; break; }
      if (c === '\\') i++;
    }
    if (!closed || i > text.length) return fail();
    let value: unknown;
    try { value = JSON.parse(text.slice(start, i)); } catch { return fail(); }
    if (typeof value !== 'string') return fail();
    for (let n = 0; n < value.length; n++) {
      const unit = value.charCodeAt(n);
      if (unit >= 0xd800 && unit <= 0xdbff) { const low = value.charCodeAt(++n); if (!(low >= 0xdc00 && low <= 0xdfff)) return fail(); }
      else if (unit >= 0xdc00 && unit <= 0xdfff) return fail();
    }
    return value;
  };
  const value = (depth: number): CanonicalValue => {
    ws(); if (++nodes > limits.maxNodes || depth > limits.maxDepth) return fail();
    const c = text[i];
    if (c === '"') return string();
    if (c === '{') {
      i++; ws(); const out: { [key: string]: CanonicalValue } = Object.create(null), seen = new Set<string>();
      if (text[i] === '}') { i++; return out; }
      for (;;) {
        ws(); const key = string(); if (seen.has(key)) return fail(); seen.add(key);
        ws(); if (text[i++] !== ':') return fail(); out[key] = value(depth + 1); ws();
        const end = text[i++]; if (end === '}') return out; if (end !== ',') return fail();
      }
    }
    if (c === '[') {
      i++; ws(); const out: CanonicalValue[] = [];
      if (text[i] === ']') { i++; return out; }
      for (;;) { out.push(value(depth + 1)); ws(); const end = text[i++]; if (end === ']') return out; if (end !== ',') return fail(); }
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]] as const)
      if (text.startsWith(literal, i)) { i += literal.length; return result; }
    numberPattern.lastIndex = i;
    const match = numberPattern.exec(text);
    if (!match) return fail();
    i += match[0].length; const number = Number(match[0]);
    if (!Number.isSafeInteger(number) || number < 0) return fail();
    return number;
  };
  const root = value(0); ws(); if (i !== text.length) return fail();
  const emit = (x: CanonicalValue): string => {
    if (x === null || typeof x !== 'object') return JSON.stringify(x);
    if (Array.isArray(x)) return '[' + x.map(emit).join(',') + ']';
    return '{' + Object.keys(x).sort().map(key => JSON.stringify(key) + ':' + emit(x[key])).join(',') + '}';
  };
  const canonical = Buffer.from(emit(root), 'utf8');
  return { value: root, canonical, sha256: createHash('sha256').update(canonical).digest('hex') };
}
