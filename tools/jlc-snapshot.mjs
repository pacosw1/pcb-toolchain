#!/usr/bin/env node
// Read-only public JLCPCB catalog capture. No login, cart, or order operations.
// Saves inbound source evidence; never evaluates scripts supplied by a webpage.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const [url, destination, expectedCode] = process.argv.slice(2);
if (!url || !destination || !/^C\d+$/.test(expectedCode || '')) {
  throw new Error('Usage: node tools/jlc-snapshot.mjs JLC_URL OUTPUT_DIRECTORY C_NUMBER');
}
const parsed = new URL(url);
if (parsed.hostname !== 'jlcpcb.com' || !parsed.pathname.startsWith('/partdetail/')) {
  throw new Error('Only public https://jlcpcb.com/partdetail/ pages are accepted');
}
if (parsed.protocol !== 'https:' || !parsed.pathname.endsWith('/' + expectedCode)) {
  throw new Error('URL/code mismatch');
}
const fetchedAt = new Date().toISOString();
let html;
try {
  html = execFileSync('curl', ['-f', '-s', '-S', '-L', '--max-time', '30', url], {
    encoding:'utf8',maxBuffer:20*1024*1024,stdio:['ignore','pipe','pipe'],
  });
} catch (error) {
  console.error(JSON.stringify({source_url:url,status:'snapshot_failed',detail:String(error.stderr||error.message).trim()}));
  process.exit(1);
}
let rsc = '';
for (const match of html.matchAll(/self\.__next_f\.push\((\[.*?\])\)<\/script>/gs)) {
  const item = JSON.parse(match[1]);
  if (item[0] === 1 && typeof item[1] === 'string') rsc += item[1];
}
const records = new Map();
for (const line of rsc.split('\n')) {
  const match = line.match(/^([0-9a-f]+):(\{.*\}|\[.*\])$/);
  if (!match) continue;
  try { records.set(match[1], JSON.parse(match[2])); } catch { /* Non-JSON RSC record. */ }
}
const resolveReference = (value, depth = 0) => {
  if (depth > 12) return value;
  if (typeof value === 'string' && /^\$[0-9a-f]+$/.test(value) && records.has(value.slice(1))) {
    return resolveReference(records.get(value.slice(1)), depth + 1);
  }
  if (Array.isArray(value)) return value.map(v => resolveReference(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveReference(v, depth + 1)]));
  }
  return value === '$undefined' ? null : value;
};
const matches = [...records.values()].filter(v => v && !Array.isArray(v) && v.componentCode === expectedCode);
const purchase = matches.find(v => Object.hasOwn(v, 'overseasStockCount'));
const attributes = matches.find(v => Object.hasOwn(v, 'attributes'));
const related = [...records.values()].filter(v => v && !Array.isArray(v) && v.componentModelEn && v.urlSuffix && v.componentCode !== expectedCode);
const snapshot = {
  schema_version: 1,
  fetched_at_utc: fetchedAt,
  source_url: url,
  source_kind: 'public_jlcpcb_server_rendered_catalog',
  expected_lcsc: expectedCode,
  source_sha256: createHash('sha256').update(html).digest('hex'),
  identity_matched: Boolean(purchase && purchase.componentCode === expectedCode),
  stock_verified: Boolean(purchase && Number.isFinite(purchase.overseasStockCount)),
  status: purchase ? 'catalog_snapshot_not_reserved' : 'unresolved_do_not_select',
  purchase_record: purchase ? resolveReference(purchase) : null,
  attribute_record: attributes ? resolveReference(attributes) : null,
  related_parts: related.map(v => ({mpn:v.componentModelEn,lcsc:v.componentCode,url_suffix:v.urlSuffix,stock_count:v.stockCount})),
  caveats: [
    'Counts are catalog observations, not reserved inventory or an assembly quote.',
    'overseasStockCount and canPresaleNumber are preserved as vendor field names; do not merge them.',
    'Assembly process/class, exact datasheet package and land pattern require separate verification.',
    'A sourcing snapshot does not constitute electrical selection, BOM approval or fabrication release.',
  ],
};
const out = resolve(destination);
await mkdir(out, { recursive: true });
// These are downloaded source artifacts, not generated design files.
await writeFile(join(out, expectedCode + '.html'), html);
await writeFile(join(out, expectedCode + '.json'), JSON.stringify(snapshot, null, 2) + '\n');
console.log(JSON.stringify({
  lcsc:expectedCode,mpn:purchase?.componentModelEn,stock:purchase?.overseasStockCount,
  can_presale:purchase?.canPresaleNumber,price_1:purchase?.initialPrice,
  fetched_at_utc:fetchedAt,status:snapshot.status,
}));
if (!purchase) process.exitCode = 2;
