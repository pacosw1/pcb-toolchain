import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {test} from 'node:test';
import {prepareVerifierContext} from './prepare-verifier-context.mjs';
test('verifier build context is derived from a commit and immutable image IDs',()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'pcb-verifier-build-')),repo=path.join(base,'repo'),out=path.join(base,'out');fs.mkdirSync(repo);const git=(...args)=>execFileSync('git',args,{cwd:repo,stdio:'ignore'});
 try{
  git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.test');fs.mkdirSync(path.join(repo,'tools'),{recursive:true});fs.mkdirSync(path.join(repo,'apps/job-daemon/deploy'),{recursive:true});
  fs.writeFileSync(path.join(repo,'tools/pcb-protected-verifier.ts'),'committed');fs.writeFileSync(path.join(repo,'apps/job-daemon/deploy/verifier.Dockerfile'),'FROM scratch\n');git('add','.');git('commit','-qm','fixture');
  fs.writeFileSync(path.join(repo,'tools/pcb-protected-verifier.ts'),'uncommitted');
  const result=prepareVerifierContext(repo,'HEAD',out,'sha256:'+'a'.repeat(64),'sha256:'+'b'.repeat(64));assert.equal(fs.readFileSync(path.join(out,'tools/pcb-protected-verifier.ts'),'utf8'),'committed');assert.match(result.sourceArchiveSha256,/^[0-9a-f]{64}$/);
  assert.throws(()=>prepareVerifierContext(repo,'HEAD',path.join(base,'bad'),'node:latest','sha256:'+'b'.repeat(64)),/image IDs/);
  assert.throws(()=>prepareVerifierContext(repo,'HEAD',out,'sha256:'+'a'.repeat(64),'sha256:'+'b'.repeat(64)));
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});
