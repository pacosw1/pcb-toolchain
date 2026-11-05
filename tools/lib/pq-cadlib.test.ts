import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Atom, dump, item, items, parse, walk } from './pq-cadlib.ts';

test('bare atoms stay bare and quoted strings stay quoted', () => {
  const tree = parse('(footprint "A:B" (layer "F.Cu") (at 1 2.50 0) locked)');
  assert.equal(dump(tree), '(footprint "A:B"\n  (layer "F.Cu")\n  (at 1 2.50 0)\n  locked)');
  assert.deepEqual(parse(dump(tree)), tree);
});

test('a list of atoms stays on one line; depth adds two spaces', () => {
  assert.equal(dump(parse('(a b c)')), '(a b c)');
  assert.equal(dump(parse('(a (b (c 1)))')), '(a\n  (b\n    (c 1)))');
});

test('strings keep non-ASCII text and escape quotes', () => {
  assert.equal(dump(['x', 'µ"\n']), '("x" "µ\\"\\n")');
  assert.deepEqual(parse(String.raw`(x "a\"b")`)[1], 'a"b');
});

test('items, item and walk find lists by head', () => {
  const tree = parse('(root (pad "1" (net 1)) (pad "2" (net 2)) (at 0 0))');
  assert.equal(items(tree, 'pad').length, 2);
  assert.equal(item(tree, 'pad')?.[1], '1');
  assert.equal(item(tree, 'missing'), undefined);
  assert.equal([...walk(tree, 'net')].length, 2);
});

test('an edit shows in the dump', () => {
  const tree = parse('(p (property "Value" "1uF"))');
  (item(tree, 'property') as (string | Atom)[])[2] = '10uF';
  assert.match(dump(tree), /"10uF"/);
});

test('broken expressions are refused', () => {
  for (const text of ['(a', '(a))', '(a) (b)', '']) assert.throws(() => parse(text));
});
