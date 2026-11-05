import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCanonicalJson } from '../src/canonical-json.ts';

const limits = { maxBytes: 4096, maxNodes: 100, maxDepth: 8 };
const parse = (text: string) => parseCanonicalJson(Buffer.from(text), limits);
test('protected JSON rejects ambiguous input and produces stable canonical bytes', () => {
  assert.equal(parse('{"z":1000,"a":[true,"é"]}').canonical.toString(), '{"a":[true,"é"],"z":1000}');
  assert.equal(parse('{"z":1000,"a":[true,"é"]}').sha256, parse('{"a":[true,"é"],"z":1000}').sha256);
  for (const bad of ['{"a":1,"\\u0061":2}', '{"n":9007199254740992}', '{"n":-1}', '{"n":1.5}', '{"n":1e3}', '{"n":0.99999999999999999}', '{"s":"\\ud800"}', '{"x":1,}'])
    assert.throws(() => parse(bad));
  assert.throws(() => parseCanonicalJson(Buffer.from([0xff]), limits));
  assert.throws(() => parseCanonicalJson(Buffer.from('{"a":{"b":1}}'), { ...limits, maxDepth: 1 }));
});
