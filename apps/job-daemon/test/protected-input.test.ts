import assert from 'node:assert/strict'; import { createHash } from 'node:crypto'; import { spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { test } from 'node:test';
import { parseCanonicalJson } from '../src/canonical-json.ts'; import { resolveManifestClosure } from '../src/protected-closure.ts'; import { prepareProtectedInput } from '../src/protected-input.ts';
const sha=(b:Buffer):string=>createHash('sha256').update(b).digest('hex');
test('builds a protected input archive from verified source bytes and safe links',()=>{
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'pcb-input-')), content=Buffer.from('board bytes'), digest=sha(content);
  const json=Buffer.from(JSON.stringify({schema:'pcb.project-manifest.v1',project_id:'p',entries:[{kind:'file',path:'board',sha256:digest,size:content.length,executable:false},{kind:'link',path:'ref',target:'board'}],required_paths:['board'],optional_absent_paths:[],external_mounts:[]}));
  const manifest=parseCanonicalJson(json,{maxBytes:10000,maxNodes:100,maxDepth:8}).canonical, manifestHash=sha(manifest);
  try {
    const closure=resolveManifestClosure(manifestHash,()=>manifest,h=>h===digest?content.length:null,{maxDepth:4,maxManifests:4,maxNodes:10,maxBytes:100,maxManifestBytes:10000});
    const input=prepareProtectedInput(parent,closure,h=>{if(h!==digest)throw Error('unexpected');return content;},{tarPath:'/usr/bin/tar',maxFiles:10,maxBytes:100,maxArchiveBytes:100000,timeoutMs:10000});
    assert.equal(sha(fs.readFileSync(input.archive)),input.sha256);
    const dest=path.join(parent,'extracted');fs.mkdirSync(dest);
    assert.equal(spawnSync('/usr/bin/tar',['-xzf',input.archive,'-C',dest]).status,0);
    assert.deepEqual(fs.readFileSync(path.join(dest,'board')),content); assert.equal(fs.readlinkSync(path.join(dest,'ref')),'board');
    assert.throws(()=>prepareProtectedInput(parent,{...closure,nodes:[...closure.nodes,{kind:'file',path:'OUT/x',sha256:digest,size:content.length,executable:false}]},()=>content,
      {tarPath:'/usr/bin/tar',maxFiles:10,maxBytes:100,maxArchiveBytes:100000,timeoutMs:10000}),/reserved/);
  } finally {fs.rmSync(parent,{recursive:true,force:true});}
});
