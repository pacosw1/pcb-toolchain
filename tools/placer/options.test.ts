// The placer command lines: word lists, dash values and shell strings.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UsageError } from '../lib/cli.ts';
import { parseOptions, parseParams, shellWords, type Spec } from './options.ts';

const SPEC: Spec = { '-o': 'text', '--size': 'words', '--param': 'words', '--route-args': 'text', '--flag': 'switch', '--cap': 'float', '--n': 'int' };
const parse = (...argv: string[]) => parseOptions(argv, SPEC, 'usage');

test('a flag takes its words up to the next flag', () => {
  const a = parse('p.json', 'b', '--size', '70', '50', '--param', 'a=1', 'b=2', '--flag', '-o', 'x');
  assert.deepEqual(a.positionals, ['p.json', 'b']);
  assert.deepEqual(a.words('--size'), ['70', '50']);
  assert.deepEqual(a.words('--param'), ['a=1', 'b=2']);
  assert.equal(a.has('--flag'), true);
  assert.equal(a.text('-o'), 'x');
});

test('a value may start with a dash, and a negative number is a word', () => {
  assert.equal(parse('--route-args', '--layers F.Cu').text('--route-args'), '--layers F.Cu');
  assert.equal(parse('--route-args=--layers F.Cu').text('--route-args'), '--layers F.Cu');
  assert.deepEqual(parse('--size', '-1', '2').words('--size'), ['-1', '2']);
});

test('numbers are checked', () => {
  assert.equal(parse('--cap', '0.5').float('--cap'), 0.5);
  assert.equal(parse('--n', '3').int('--n'), 3);
  assert.throws(() => parse('--n', '1.5').int('--n'), UsageError);
  assert.throws(() => parse('--cap', 'wide').float('--cap'), UsageError);
});

test('an unknown flag and a missing value are usage errors', () => {
  assert.throws(() => parse('--nope'), UsageError);
  assert.throws(() => parse('-o'), UsageError);
});

test('params keep numbers and words', () => {
  assert.deepEqual(parseParams(['w_ov=20', 'schedule=lam', 'x=-1.5']), { w_ov: 20, schedule: 'lam', x: -1.5 });
  assert.throws(() => parseParams(['bad']), UsageError);
});

test('shell words split as a POSIX shell does', () => {
  assert.deepEqual(shellWords(`--layers F.Cu,B.Cu --plane-nets 'GND,+3V3' "a b" c\\ d`), ['--layers', 'F.Cu,B.Cu', '--plane-nets', 'GND,+3V3', 'a b', 'c d']);
  assert.deepEqual(shellWords(''), []);
  assert.deepEqual(shellWords(`''`), ['']);
  assert.throws(() => shellWords(`'open`), UsageError);
});
