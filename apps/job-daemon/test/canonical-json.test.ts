import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { parseCanonicalJson } from '../src/canonical-json.ts';

const limits = { maxBytes: 4096, maxNodes: 100, maxDepth: 8 };
const parse = (text: string) => parseCanonicalJson(Buffer.from(text), limits);
test('protected JSON rejects ambiguous input and produces stable canonical bytes', () => {
  const vectors = JSON.parse(fs.readFileSync(new URL('../../../contracts/canonical-json-v1-vectors.json', import.meta.url), 'utf8')) as {
    valid: { input: string; canonical: string }[]; invalid: { input?: string; input_hex?: string }[] };
  for (const v of vectors.valid) assert.equal(parse(v.input).canonical.toString(), v.canonical);
  assert.equal(parse('{"z":1000,"a":[true,"é"]}').sha256, parse('{"a":[true,"é"],"z":1000}').sha256);
  for (const v of vectors.invalid) assert.throws(() => parseCanonicalJson(v.input_hex ? Buffer.from(v.input_hex, 'hex') : Buffer.from(v.input!), limits));
  assert.throws(() => parseCanonicalJson(Buffer.from('{"a":{"b":1}}'), { ...limits, maxDepth: 1 }));
});
