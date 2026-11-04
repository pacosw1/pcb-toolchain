// The part-use examples and schemas of the project. Their review hashes were computed by the Python tool, so this checks
// factsDigest against text it did not write. Listed in .cip/project-only-tests.txt.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { sha256File } from './json-file.ts';
import { factsDigest } from './part-review.ts';
import { fileRoot } from './project-root.mjs';
import { jsonLoad } from './py-compat.mjs';
import type { Dict } from './py-dict.ts';

const folder = join(fileRoot, 'hardware-design/registry/part-reviews');
const load = (name: string) => jsonLoad(join(folder, name)) as Dict;
const reviewOf = (value: Dict) => value.get('review') as Dict;

test('the examples are pending, and their hashes are exact', () => {
  const profilePath = join(folder, 'examples/SYNTHETIC.profile.example.json');
  const profile = load('examples/SYNTHETIC.profile.example.json');
  const use = load('examples/SYNTHETIC.part-use.example.json');
  assert.equal(reviewOf(profile).get('verdict'), 'pending');
  assert.equal(reviewOf(use).get('verdict'), 'pending');
  assert.equal(((use.get('parts') as Dict[])[0]?.get('profile') as Dict).get('sha256'), sha256File(profilePath));
  assert.equal(reviewOf(profile).get('facts_sha256'), factsDigest(profile));
  assert.equal(reviewOf(use).get('facts_sha256'), factsDigest(use));
  for (const [name, example] of [['part-profile.schema.json', profile], ['part-use.schema.json', use]] as const) {
    const schema = load(name);
    assert.equal(example.get('schema'), ((schema.get('properties') as Dict).get('schema') as Dict).get('const'));
    for (const key of schema.get('required') as string[]) assert.ok(example.has(key), key);
  }
});
