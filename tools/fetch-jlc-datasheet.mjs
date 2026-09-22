#!/usr/bin/env node
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {dirname} from 'node:path';
const [snapshotPath,output]=process.argv.slice(2);
const meta=JSON.parse(await readFile(snapshotPath,'utf8'));
const html=await readFile(snapshotPath.replace(/\.json$/,'.html'),'utf8');
let rsc='';for(const m of html.matchAll(/self\.__next_f\.push\((\[.*?\])\)<\/script>/gs)){
  const v=JSON.parse(m[1]);if(v[0]===1&&typeof v[1]==='string')rsc+=v[1];
}
const urls=[...rsc.matchAll(/https:\/\/[^/\s"<>]+\/smtDataManualFile\/[^\s"<>]*?x-oss-signature=[a-f0-9]{64}/g)].map(m=>m[0]);
const url=urls.find(u=>new URL(u).pathname.endsWith('-'+meta.expected_lcsc+'.pdf'));
if(!url)throw new Error('No exact public catalog PDF asset for '+meta.expected_lcsc);
let bytes;try{bytes=execFileSync('curl',['--http1.1','-f','-s','-S','-L','--max-time','40',url],{maxBuffer:40*1024*1024,stdio:['ignore','pipe','pipe']});}
catch(e){console.error(JSON.stringify({code:meta.expected_lcsc,status:'download_failed',detail:e.stderr?.toString().trim()}));process.exit(1);}
if(!bytes.subarray(0,1024).includes(Buffer.from('%PDF-')))throw new Error('Non-PDF response; nothing saved');
await mkdir(dirname(output),{recursive:true});await writeFile(output,bytes);
const u=new URL(url);
const evidence={source_url:u.origin+u.pathname,catalog_url:meta.source_url,catalog_snapshot:snapshotPath,catalog_sha256:meta.source_sha256,source_kind:'manufacturer_document_mirrored_by_jlcpcb',fetched_at_utc:new Date().toISOString(),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),pdf_header_verified:true,content_review:'pending',note:'Temporary public asset query signature omitted; catalog snapshot preserves original source evidence.'};
await writeFile(output+'.source.json',JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({file:output,code:meta.expected_lcsc,bytes:bytes.length,sha256:evidence.sha256}));
