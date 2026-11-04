// tools/lib/py-compat.mjs: each expected value below is what Python 3.11 gives. Run: node --test tools/lib/py-compat.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {PyError, SystemExit, compare, csvLine, csvRows, decode, dictRows, fixed, floatRepr, globNames, head, jsonDumps, jsonLoads, ljust, parseArgs, pyRepr, pyStr, run, sorted, splitlines, strip, tail, truthy, utcNow} from './py-compat.mjs';

test('float repr', () => {
  for (const [x, text] of [[1, '1.0'], [0.1, '0.1'], [1e16, '1e+16'], [1e15, '1000000000000000.0'], [1.5e16, '1.5e+16'], [0.0001, '0.0001'],
    [0.00001, '1e-05'], [1.25e-7, '1.25e-07'], [-2.5, '-2.5'], [1e100, '1e+100'], [123456.789, '123456.789'], [-0, '-0.0'], [0, '0.0']]) assert.equal(floatRepr(x), text);
});
test('format .2f rounds a tie half even on the exact value', () => {
  for (const [x, text] of [[0.125, '0.12'], [0.375, '0.38'], [2.5, '2.50'], [1.005, '1.00'], [2.675, '2.67'], [0, '0.00'], [12.345, '12.35'], [0.135, '0.14'], [1234.5678, '1234.57']]) assert.equal(fixed(x, 2), text);
  assert.equal(fixed(0.5, 0), '0');
  assert.equal(fixed(1.5, 0), '2');
});
test('json keeps int, float and key order', () => {
  const text = '{"b": 1.0, "10": 12345678901234567890, "2": [1e3, 0.5, null, true], "a": {}, "c": []}';
  assert.equal(jsonDumps(jsonLoads(text)), '{"b": 1.0, "10": 12345678901234567890, "2": [1000.0, 0.5, null, true], "a": {}, "c": []}');
  assert.equal(jsonDumps(jsonLoads('{"a":1,"b":2,"a":3}')), '{"a": 3, "b": 2}');
});
test('json.dumps ensure_ascii and indent', () => {
  assert.equal(jsonDumps('café \u{1f600} \x7f "\\\n\t'), '"caf\\u00e9 \\ud83d\\ude00 \\u007f \\"\\\\\\n\\t"');
  assert.equal(jsonDumps({a: [1, {b: null}], c: [], d: {}}, 2), '{\n  "a": [\n    1,\n    {\n      "b": null\n    }\n  ],\n  "c": [],\n  "d": {}\n}');
  assert.equal(jsonDumps([1, 2], 1), '[\n 1,\n 2\n]');
});
test('json errors read like JSONDecodeError', () => {
  for (const [text, message] of [['', 'Expecting value: line 1 column 1 (char 0)'], ['{', 'Expecting property name enclosed in double quotes: line 1 column 2 (char 1)'],
    ['{"a" 1}', "Expecting ':' delimiter: line 1 column 6 (char 5)"], ['[1 2]', "Expecting ',' delimiter: line 1 column 4 (char 3)"], ['1 2', 'Extra data: line 1 column 3 (char 2)'],
    ['"abc', 'Unterminated string starting at: line 1 column 1 (char 0)'], ['{\n"a": x}', 'Expecting value: line 2 column 6 (char 7)'], ['"\\q"', 'Invalid \\escape: line 1 column 2 (char 1)'],
    ['"a\nb"', 'Invalid control character at: line 1 column 3 (char 2)']]) {
    assert.throws(() => jsonLoads(text), e => e instanceof PyError && e.message === message, text);
  }
});
test('bytes may start with a BOM, text may not', () => {
  assert.equal(jsonLoads(Buffer.from('﻿1')), 1n);
  assert.throws(() => jsonLoads('﻿1'), /Unexpected UTF-8 BOM/);
});
test('strip uses the Python whitespace set', () => {
  assert.equal(strip(' \t\x1c\x85 a b　\n'), 'a b');
  assert.equal(strip('﻿a'), '﻿a');
  assert.throws(() => strip(null), /'NoneType' object has no attribute 'strip'/);
});
test('strings work by code point', () => {
  assert.equal(head('a\u{1f600}b', 2), 'a\u{1f600}');
  assert.equal(tail('a\u{1f600}b', 2), '\u{1f600}b');
  assert.equal(ljust('\u{1f600}', 3), '\u{1f600}  ');
  assert.deepEqual(sorted(['￿', '\u{10000}', 'a']), ['a', '￿', '\u{10000}']);
  assert.ok(compare('a', 'ab') < 0);
});
test('repr, str and truth', () => {
  assert.equal(pyRepr("it's"), '"it\'s"');
  assert.equal(pyRepr('a"b\'c\n'), "'a\"b\\'c\\n'");
  assert.equal(pyStr(null), 'None');
  assert.equal(pyStr(true), 'True');
  assert.equal(pyStr(5n), '5');
  assert.deepEqual([null, '', 0n, [], new Map()].map(truthy), [false, false, false, false, false]);
  assert.deepEqual(['x', 1n, [0]].map(truthy), [true, true, true]);
});
test('csv reader keeps the csv module rules', () => {
  assert.deepEqual(csvRows('a,"b,c",d\r\n\r\n,,\n"x""y","multi\nline"\n"open'), [['a', 'b,c', 'd'], [], ['', '', ''], ['x"y', 'multi\nline'], ['open']]);
  assert.deepEqual(csvRows('ab"c,"d"e\n'), [['ab"c', 'de']]);
  assert.deepEqual(dictRows('a,b\n1\n\n1,2,3\n').map(r => [...r]), [[['a', '1'], ['b', null]], [['a', '1'], ['b', '2']]]);
  assert.deepEqual(dictRows(''), []);
});
test('csv writer', () => {
  assert.equal(csvLine(['a', 'b,c', 'd"e', '', 'f\ng']), 'a,"b,c","d""e",,"f\ng"\r\n');
  assert.equal(csvLine(['']), '""\r\n');
});
test('splitlines, utf-8 failures and folders', () => {
  assert.deepEqual(splitlines('a\r\nb\vc\x85d\n'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(splitlines(''), []);
  assert.throws(() => decode(Buffer.from([0x41, 0xff])), e => e.message === "'utf-8' codec can't decode byte 0xff in position 1: invalid start byte");
  assert.throws(() => decode(Buffer.from([0xe2, 0x82])), e => e.message === "'utf-8' codec can't decode bytes in position 0-1: unexpected end of data");
  assert.throws(() => decode(Buffer.from([0xe2, 0x41])), e => e.message === "'utf-8' codec can't decode byte 0xe2 in position 0: invalid continuation byte");
  assert.equal(pyRepr('a '), "'a\\u2028'");
  assert.deepEqual(globNames('/no/such/folder'), []);
});
test('subprocess errors read like Python', () => {
  assert.throws(() => run('/no/such/tool', []), e => e.type === 'FileNotFoundError' && e.message === "[Errno 2] No such file or directory: '/no/such/tool'");
  assert.throws(() => run('false', ['x'], {check: true}), e => e.type === 'subprocess.CalledProcessError' && e.message === "Command '['false', 'x']' returned non-zero exit status 1.");
  assert.throws(() => run('', []), e => e.type === 'PermissionError');
});
test('utc time like datetime.isoformat', () => {
  assert.equal(utcNow(new Date('2026-11-04T01:02:03.456Z')), '2026-11-04T01:02:03.456000+00:00');
});
test('argparse: values, abbreviations and failures', () => {
  const spec = {prog: 'x.mjs', positionals: ['bom', 'out'], options: [{flag: '--boards', type: 'int', fallback: 5n}, {flag: '--min-margin', type: 'int', fallback: 10n}]};
  const quiet = fn => { const write = process.stderr.write; try { return fn(); } finally { process.stderr.write = write; } };
  assert.deepEqual({...parseArgs(spec, ['a', '--boards', '3', 'b'])}, {boards: 3n, min_margin: 10n, bom: 'a', out: 'b'});
  assert.equal(parseArgs(spec, ['a', 'b', '--min=1_0']).min_margin, 10n);
  assert.equal(parseArgs(spec, ['--boards=-2', '--', '-a', 'b']).bom, '-a');
  assert.throws(() => quiet(() => parseArgs(spec, ['a'])), e => e instanceof SystemExit && e.code === 2);
});
