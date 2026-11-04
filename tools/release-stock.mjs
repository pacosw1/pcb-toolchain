#!/usr/bin/env node
// Read-only JLC assembly availability for an exact fabrication candidate.
//
//   node tools/release-stock.mjs CANDIDATE OUT --boards N
//
// Saves original responses and source/time/hash attribution. No login, cart, order or supplier contact. Quantities cover
// N boards of any one population; mixed population totals must be planned separately. No arbitrary stock margin.
// Exit 0 available, 1 unavailable or stale (receipts kept), 2 stopped.
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Float, PyError, SystemExit, decode, eprint, get, head, item, jsonDumps, jsonLoads, osError, parseArgs, print, pyStr, run, sorted, strip, truthy, typeName, utcNow} from './lib/py-compat.mjs';

const URL = 'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList';
const sha256 = data => createHash('sha256').update(data).digest('hex');
const or = (value, otherwise) => truthy(value) ? value : otherwise;
const isOne = value => value === 1n || value === true || (value instanceof Float && value.value === 1);
function values(dict) {
  if (!(dict instanceof Map)) throw new PyError('AttributeError', `'${typeName(dict)}' object has no attribute 'values'`);
  return [...dict.values()];
}
function write(path, data) {
  try { writeFileSync(path, data); } catch (error) { throw osError(error, path); }
}

function fetchPart(code) {
  const body = jsonDumps(new Map([['keyword', code], ['currentPage', 1], ['pageSize', 10], ['searchSource', 'search']]));
  const p = run('curl', ['-sS', '-f', '-L', '-m', '30', '-H', 'Content-Type: application/json', '-d', body, URL]);
  if (p.status !== 0) throw new PyError('RuntimeError', `${code}: no response from JLC (${strip(head(decode(p.stderr), 120))})`);
  return p.stdout;
}

function main() {
  const args = parseArgs({prog: 'release-stock.mjs', positionals: ['candidate', 'out'], options: [{flag: '--boards', type: 'int', required: true}]}, process.argv.slice(2));
  if (args.boards <= 0n) throw new PyError('ValueError', '--boards must be positive');
  const manifestPath = join(args.candidate, 'release-manifest.json');
  let manifestBytes;
  try { manifestBytes = readFileSync(manifestPath); } catch (error) { throw osError(error, manifestPath); }
  const manifest = jsonLoads(manifestBytes);
  if (!isOne(get(manifest, 'schema_version')) || get(manifest, 'scope') !== 'cad_fabrication_candidate') {
    throw new PyError('ValueError', 'verified fabrication candidate required');
  }
  mkdirSync(args.out);  // Refuse existing output; original receipts are immutable.
  const required = new Map();
  for (const population of values(item(item(manifest, 'assembly'), 'populations'))) {
    const codes = values(item(population, 'references'));
    for (const code of new Set(codes)) {
      if (typeof code !== 'string' || !/^C\p{Nd}+$/u.test(code)) throw new PyError('ValueError', 'invalid exact LCSC code');
      const quantity = BigInt(codes.filter(c => c === code).length) * args.boards, known = required.get(code) ?? 0n;
      required.set(code, quantity > known ? quantity : known);
    }
  }
  if (!required.size) throw new PyError('ValueError', 'candidate contains no fitted parts');
  const day = utcNow().slice(0, 10), parts = new Map();
  const receipt = new Map([['schema_version', 1], ['board', item(manifest, 'board')], ['candidate_sha256', sha256(manifestBytes)],
    ['source_url', URL], ['order_day_utc', day], ['boards', args.boards], ['parts', parts]]);
  const failures = [];
  for (const code of sorted(required.keys())) {
    const quantity = required.get(code);
    print('START: assembly stock ' + code);
    const raw = fetchPart(code), fetched = utcNow();
    write(join(args.out, code + '.json'), raw);
    parts.set(code, new Map([['required', quantity], ['fetched_at_utc', fetched], ['response', code + '.json'], ['response_sha256', sha256(raw)]]));
    const rows = or(get(or(get(or(get(jsonLoads(raw), 'data'), new Map()), 'componentPageInfo'), new Map()), 'list'), []);
    const matches = rows.filter(row => get(row, 'componentCode') === code);
    const count = matches.length === 1 ? get(matches[0], 'stockCount') : null;
    // Python's isinstance(count, int) takes true and false too.
    const exact = typeof count === 'bigint' || typeof count === 'boolean';
    if (!exact || BigInt(count) < quantity || fetched.slice(0, 10) !== day) failures.push(code);
    print(`${failures.includes(code) ? 'FAIL' : 'PASS'}: ${code} assembly stock=${pyStr(count)} required=${quantity}`);
  }
  write(join(args.out, 'stock.json'), jsonDumps(receipt, 2) + '\n');
  print(failures.length ? 'FAIL: unavailable or stale assembly stock: ' + failures.join(', ') : 'PASS: original JLC stock receipts saved; stock is not reserved');
  return failures.length ? 1 : 0;
}

try { process.exitCode = main(); } catch (error) {
  if (error instanceof SystemExit) process.exitCode = error.code;
  else {
    eprint('FAIL: assembly stock: ' + osError(error).message);
    process.exitCode = 2;
  }
}
