#!/usr/bin/env node
// Download public supplier/manufacturer PDF evidence; do not alter its contents.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
const [url, target] = process.argv.slice(2);
if (!url || !target || new URL(url).protocol !== 'https:') {
  throw new Error('Usage: node tools/fetch-datasheet.mjs HTTPS_URL OUTPUT.pdf');
}
let bytes;
try {
  bytes = execFileSync('curl', ['--http1.1', '-f', '-s', '-S', '-L', '--max-time', '45', url], {maxBuffer:40*1024*1024,stdio:['ignore','pipe','pipe']});
} catch (error) {
  console.error(JSON.stringify({source_url:url,status:'download_failed',detail:error.stderr?.toString().trim()||String(error)}));
  process.exit(1);
}
if (!bytes.subarray(0,1024).includes(Buffer.from('%PDF-'))) throw new Error('Response is not a PDF; nothing saved');
const path=resolve(target);
await mkdir(dirname(path),{recursive:true});
await writeFile(path,bytes);
const evidence={source_url:url,fetched_at_utc:new Date().toISOString(),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),pdf_header_verified:true,content_review:'pending'};
await writeFile(path+'.source.json',JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({file:target,...evidence}));
