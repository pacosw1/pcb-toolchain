import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Decimal, positiveDegrees } from './decimal.ts';

const text = (value: string) => Decimal.of(value).toString();

test('text keeps the written exponent, as str(Decimal) does', () => {
  assert.equal(text('1.50'), '1.50');
  assert.equal(text('-0.0'), '-0.0');
  assert.equal(text('.5'), '0.5');
  assert.equal(text('1e3'), '1E+3');
  assert.equal(text('0.0000001'), '1E-7');
  assert.equal(text('0.000001'), '0.000001');
});

test('normalize drops trailing zeros and may use an exponent', () => {
  assert.equal(Decimal.of('1.500').normalize().toString(), '1.5');
  assert.equal(Decimal.of('100').normalize().toString(), '1E+2');
  assert.equal(Decimal.of('0.00').normalize().toString(), '0');
});

test('arithmetic is exact and keeps the smaller exponent', () => {
  assert.equal(Decimal.of('10.5').sub(Decimal.of('3.25')).toString(), '7.25');
  assert.equal(Decimal.of('1.50').sub(Decimal.of('1.5')).toString(), '0.00');
  assert.ok(Decimal.of('1.50').equals(Decimal.of('1.5')));
});

test('% takes the sign of the dividend; positiveDegrees wraps', () => {
  assert.equal(Decimal.of('-90').mod(Decimal.of('360')).toString(), '-90');
  assert.equal(positiveDegrees(Decimal.of('-90')).toString(), '270');
  assert.equal(positiveDegrees(Decimal.of('450.5')).toString(), '90.5');
  assert.ok(positiveDegrees(Decimal.of('-360')).isZero);
});

test('unary minus of zero is plus zero; a subtraction of zeros keeps its sign rule', () => {
  assert.equal(Decimal.of('0.0').neg().toString(), '0.0');
  assert.equal(Decimal.of('-0.0').neg().toString(), '0.0');
  assert.equal(Decimal.of('2').neg().toString(), '-2');
  assert.equal(Decimal.of('0').sub(Decimal.of('0')).toString(), '0');
  assert.equal(Decimal.of('-0').sub(Decimal.of('0')).toString(), '-0');
});

test('NaN and infinity parse to null, other text raises', () => {
  assert.equal(Decimal.parse('NaN'), null);
  assert.equal(Decimal.parse('-Infinity'), null);
  assert.throws(() => Decimal.parse('abc'), /ConversionSyntax/);
});
