#!/usr/bin/env node
// JLC assembly stock and class for each part of a JLC BOM (read only: no login, no cart, no order).
//
//   node tools/jlc_stock.mjs BOM-JLC.csv OUT.json [--boards 5] [--min-margin 10]
//
// For each LCSC code of the BOM (column "LCSC Part #"): the public JLC SMT parts search
// (POST https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList, keyword = C-number),
// the record whose componentCode is the C-number. Saved per part: model, class (Basic / Extended), stock, price tiers,
// refs, quantity per board and the sha256 of the response (the same format as registry/evidence/2026-09-27/BASE-PWR-stock.json).
// Prints the lowest stocks and FAIL lines: a code with no exact record, or stock below qty x boards x --min-margin.
// Exit 1 on a FAIL. Stock is not reserved: run it again on the day of the order.
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {Float, PyError, SystemExit, cli, decode, dictRows, fixed, get, head, item, jsonDumps, jsonLoads, number, osError, parseArgs, print, pyStr, readText, run, sleep, split, strip, truthy, utcNow} from './lib/py-compat.mjs';

const URL = 'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList';
const or = (value, otherwise) => truthy(value) ? value : otherwise;
// A value for < and sorted(): exact for int, as Python compares int with float.
function ordered(value) {
  if (value instanceof Float) return value.value;
  if (typeof value === 'bigint') return value;
  if (value === true || value === false) return BigInt(value);
  throw new PyError('TypeError', `'<' not supported between instances of '${value === null ? 'NoneType' : typeof value === 'string' ? 'str' : 'list'}' and 'int'`);
}

function fetchPart(code) {
  const body = jsonDumps(new Map([['keyword', code], ['currentPage', 1], ['pageSize', 10], ['searchSource', 'search']]));
  let p;
  for (let attempt = 0; attempt < 4; attempt++) {
    p = run('curl', ['-s', '-f', '-m', '30', '-X', 'POST', URL, '-H', 'Content-Type: application/json', '-d', body]);
    if (p.status === 0 && p.stdout.length) return p.stdout;
    sleep(2 ** (attempt + 1));
  }
  throw new PyError('RuntimeError', `${code}: no response from JLC (${head(decode(p.stderr), 120)})`);
}

function main() {
  const a = parseArgs({prog: 'jlc_stock.mjs', positionals: ['bom', 'out'],
    options: [{flag: '--boards', type: 'int', fallback: 5n}, {flag: '--min-margin', type: 'int', fallback: 10n}]}, process.argv.slice(2));
  const lines = dictRows(readText(a.bom));
  const byCode = new Map();  // one code can be on more lines (same part, other Value text): add the refs
  for (const r of lines) {
    const code = strip(item(r, 'LCSC Part #')), comment = item(r, 'Comment');
    if (!byCode.has(code)) byCode.set(code, {comment, refs: []});
    byCode.get(code).refs.push(...split(item(r, 'Designator'), ',').map(strip).filter(Boolean));
  }
  const parts = new Map(), fails = [];
  for (const [code, e] of byCode) {
    const refs = e.refs, raw = fetchPart(code), doc = jsonLoads(raw);
    const list = or(get(or(get(or(get(doc, 'data'), new Map()), 'componentPageInfo'), new Map()), 'list'), []);
    const rec = list.find(x => get(x, 'componentCode') === code);
    if (rec === undefined) { fails.push(`FAIL ${code} (${pyStr(e.comment)}): no exact catalog record`); continue; }
    const library = get(rec, 'componentLibraryType');
    let cls = {base: 'Basic', expand: 'Extended'}[library] ?? library;
    if (truthy(get(rec, 'preferredComponentFlag'))) cls = 'Preferred';
    const prices = or(get(rec, 'componentPrices'), []).map(pr => new Map(['startNumber', 'endNumber', 'productPrice'].map(k => [k, get(pr, k)])));
    parts.set(code, {model: get(rec, 'componentModelEn'), class: cls, stock: get(rec, 'stockCount'), prices,
      refs: refs.join(','), qty: refs.length, response_sha256: createHash('sha256').update(raw).digest('hex')});
    const need = BigInt(refs.length) * a.boards * a.min_margin, stock = get(rec, 'stockCount');
    if (ordered(or(stock, 0n)) < need) {
      fails.push(`FAIL ${code} ${pyStr(get(rec, 'componentModelEn'))}: stock ${pyStr(stock)} < ${need} (qty ${refs.length} x ${a.boards} boards x margin ${a.min_margin})`);
    }
    sleep(0.3);
  }
  const out = new Map([['fetched_at_utc', utcNow()], ['source_url', URL], ['bom', a.bom], ['boards', a.boards], ['parts', new Map([...parts].map(([c, v]) => [c, new Map(Object.entries(v))]))]]);
  try { writeFileSync(a.out, jsonDumps(out, 2)); } catch (error) { throw osError(error, a.out); }
  let unit = 0;   // plain addition in order: Python before 3.12 does the same, and the sum is shown to two places
  for (const v of parts.values()) {
    const price = v.prices.length ? v.prices[0].get('productPrice') : 0n;
    if (price === null) throw new PyError('TypeError', "unsupported operand type(s) for *: 'int' and 'NoneType'");
    unit += v.qty * number(price);
  }
  const extended = [...parts.values()].filter(v => v.class === 'Extended').length;
  const total = [...byCode.values()].reduce((sum, e) => sum + e.refs.length, 0);
  print(`jlc_stock: ${parts.size} of ${byCode.size} codes found (${lines.length} BOM lines, ${total} parts); Extended types ${extended}; parts per board at the first price tier ${fixed(unit, 2)} USD`);
  const key = v => ordered(or(v.stock, 0n));
  const lowest = [...parts].sort(([, x], [, y]) => { const p = key(x), q = key(y); return p < q ? -1 : p > q ? 1 : 0; }).slice(0, 6);
  for (const [c, v] of lowest) print(`  lowest: ${c} ${pyStr(v.model)} (${v.refs}) ${pyStr(v.class)} stock ${pyStr(v.stock)}`);
  for (const f of fails) print(f);
  throw new SystemExit(fails.length ? 1 : 0);
}

cli(main);
