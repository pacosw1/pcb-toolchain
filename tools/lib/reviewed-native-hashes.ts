/** Strict subset of the reviewed native asset normalization. Unsupported pad
 * rotations fail closed; these hashes alone never authorize a reviewed search. */
import {createHash} from 'node:crypto';
import {children, single} from './kicad-population.mjs';
import type {Tree} from './kicad-population.mjs';

type Json = string | number | boolean | null | Json[] | {[key:string]: Json};
function encode(value: Json): string {
  if (Array.isArray(value)) return '[' + value.map(encode).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+encode(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function digest(value: Json): string {return createHash('sha256').update(encode(value)).digest('hex');}

/** Decimal.normalize() string for finite decimal tokens, without binary float conversion. */
export function decimal(token: string): string | undefined {
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) return undefined;
  const sign = match[1] === '-' ? '-' : '';
  const fractional = match[3] ?? match[4] ?? '';
  let digits = ((match[2] ?? '') + fractional).replace(/^0+/, '');
  if (!digits) return '0';
  const exponentText = match[5] ?? '0';
  if (exponentText.length > 5) throw new Error('native decimal exponent unsupported');
  let exponent = Number(exponentText) - fractional.length;
  while (digits.endsWith('0')) {digits = digits.slice(0,-1); exponent++;}
  const adjusted = exponent + digits.length - 1;
  if (exponent > 0 || adjusted < -6) {
    const mantissa = digits.length === 1 ? digits : digits[0] + '.' + digits.slice(1);
    return sign + mantissa + 'E' + (adjusted >= 0 ? '+' : '') + adjusted;
  }
  if (exponent >= 0) return sign + digits + '0'.repeat(exponent);
  const point = digits.length + exponent;
  return sign + (point > 0 ? digits.slice(0,point) + '.' + digits.slice(point) : '0.' + '0'.repeat(-point) + digits);
}
function normalized(value: string | Tree): Json {
  if (typeof value === 'string') return decimal(value) ?? value;
  return value.filter(v => !(Array.isArray(v) && (v[0] === 'uuid' || v[0] === 'tstamp'))).map(normalized);
}
function integerAngle(token: string | Tree | undefined): number {
  if (token === undefined) return 0;
  if (typeof token !== 'string' || !/^[+-]?\d+(?:\.0+)?$/.test(token)) throw new Error('non-integer native pad rotation unsupported');
  const n = Number(token);
  if (!Number.isSafeInteger(n)) throw new Error('native pad rotation out of range');
  return n;
}
export function footprintHashes(form: Tree): {footprint_sha256:string; land_geometry_sha256:string} {
  const id = form[1];
  if (typeof id !== 'string') throw new Error('native footprint ID missing');
  const fpAt = single(form, 'at');
  const rotation = integerAngle(fpAt?.[3]);
  const geometry = children(form, 'pad').map(pad => {
    if (typeof pad[1] !== 'string' || typeof pad[2] !== 'string' || typeof pad[3] !== 'string') throw new Error('malformed native pad');
    const definition: Json[] = [];
    for (const item of pad.slice(2)) {
      if (typeof item === 'string') definition.push(item);
      else if (item[0] === 'at') {
        if ((item.length !== 3 && item.length !== 4) || typeof item[1] !== 'string' || typeof item[2] !== 'string') throw new Error('malformed native pad position');
        const angle = ((integerAngle(item[3]) - rotation) % 360 + 360) % 360;
        definition.push(['at', decimal(item[1]) ?? item[1], decimal(item[2]) ?? item[2], decimal(String(angle))!]);
      } else if (!['net','uuid','tstamp','pinfunction','pintype'].includes(String(item[0]))) definition.push(normalized(item));
    }
    return {number:pad[1], definition} as Json;
  });
  if (!geometry.length) throw new Error('native footprint has no pads');
  geometry.sort((a,b)=>Buffer.compare(Buffer.from(encode(a)),Buffer.from(encode(b))));
  const graphics = normalized(form.slice(2).filter(v => Array.isArray(v) && ['fp_line','fp_rect','fp_circle','fp_arc','fp_poly','zone'].includes(String(v[0]))) as Tree);
  return {footprint_sha256:digest({identifier:id,pads:geometry,graphics}), land_geometry_sha256:digest(geometry)};
}
export function symbolHash(assets: {unit:number; definitions:Tree[]}[]): string {
  if (!assets.length) throw new Error('native symbol assets missing');
  const rows = assets.map(a=>({unit:a.unit, definitions:a.definitions}) as Json);
  rows.sort((a,b)=>Buffer.compare(Buffer.from(encode(a)),Buffer.from(encode(b))));
  return digest(rows);
}
