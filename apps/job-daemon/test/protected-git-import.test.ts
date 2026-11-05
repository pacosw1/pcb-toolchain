import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {test} from 'node:test';
import {ProtectedBlobs} from '../src/protected-blobs.ts';import {stageGitImport} from '../src/protected-git-import.ts';import {parseProjectManifest} from '../src/protected-manifest.ts';
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
test('stages an exact private Git commit with in-root links and preserves source worktree',async()=>{
 const parent=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'pcb-git-import-')),work=path.join(parent,'work'),bare=path.join(parent,'bare'),storeDir=path.join(parent,'store');fs.mkdirSync(work);
 const git=fs.realpathSync('/usr/bin/git'),tar=fs.realpathSync('/usr/bin/tar'),call=(...args:string[])=>execFileSync(git,args,{cwd:work,encoding:'utf8',stdio:['ignore','pipe','pipe']});
 call('init','-q');call('config','user.name','Test');call('config','user.email','test@example.test');fs.mkdirSync(path.join(work,'lib'));fs.mkdirSync(path.join(work,'pretty'));
 fs.writeFileSync(path.join(work,'board.kicad_pcb'),'committed board');fs.writeFileSync(path.join(work,'lib/part'),'part');fs.symlinkSync('../lib/part',path.join(work,'pretty/part'));fs.writeFileSync(path.join(work,'run.sh'),'#!/bin/sh\n',{mode:0o755});
 call('add','.');call('commit','-qm','fixture');const commit=call('rev-parse','HEAD').trim();call('clone','--bare','--no-local','--quiet',work,bare);fs.chmodSync(bare,0o700);fs.writeFileSync(path.join(work,'board.kicad_pcb'),'dirty worktree');
 const store=new ProtectedBlobs(storeDir,{maxBlobBytes:1024*1024,quotaBytes:10*1024*1024});
 try{
  const result=await stageGitImport(store,bare,commit,'p',parent,{gitPath:git,gitSha256:hash(fs.readFileSync(git)),tarPath:tar,tarSha256:hash(fs.readFileSync(tar)),selectedPaths:[],requiredPaths:['board.kicad_pcb'],optionalAbsentPaths:['optional'],externalMounts:[],maxFiles:100,maxFileBytes:1024*1024,maxArchiveBytes:10*1024*1024,timeoutMs:30000});
  assert.equal(result.gitCommit,commit);const manifest=parseProjectManifest(store.read(result.manifestSha256)).manifest,board=manifest.entries.find(e=>e.path==='board.kicad_pcb'),link=manifest.entries.find(e=>e.path==='pretty/part'),script=manifest.entries.find(e=>e.path==='run.sh');
  assert.equal(board?.kind,'file');if(board?.kind==='file')assert.equal(store.read(board.sha256).toString(),'committed board');
  assert.deepEqual(link,{kind:'link',path:'pretty/part',target:'../lib/part'});assert.equal(script?.kind==='file'&&script.executable,true);assert.equal(fs.readFileSync(path.join(work,'board.kicad_pcb'),'utf8'),'dirty worktree');
  const subset=await stageGitImport(store,bare,commit,'p',parent,{gitPath:git,gitSha256:hash(fs.readFileSync(git)),tarPath:tar,tarSha256:hash(fs.readFileSync(tar)),selectedPaths:['board.kicad_pcb'],requiredPaths:['board.kicad_pcb'],optionalAbsentPaths:[],externalMounts:[],maxFiles:100,maxFileBytes:1024*1024,maxArchiveBytes:10*1024*1024,timeoutMs:30000});
  assert.equal(subset.files,1);
  fs.writeFileSync(path.join(work,'.gitattributes'),'meta.txt export-subst\n');fs.writeFileSync(path.join(work,'meta.txt'),'$Format:%H$');call('add','.');call('commit','-qm','archive transform');
  const transformed=call('rev-parse','HEAD').trim(),bare2=path.join(parent,'bare2');call('clone','--bare','--no-local','--quiet',work,bare2);fs.chmodSync(bare2,0o700);
  await assert.rejects(stageGitImport(store,bare2,transformed,'p',parent,{gitPath:git,gitSha256:hash(fs.readFileSync(git)),tarPath:tar,tarSha256:hash(fs.readFileSync(tar)),selectedPaths:[],requiredPaths:['board.kicad_pcb'],optionalAbsentPaths:[],externalMounts:[],maxFiles:100,maxFileBytes:1024*1024,maxArchiveBytes:10*1024*1024,timeoutMs:30000}),/archive transformed/);
 }finally{store.close();fs.rmSync(parent,{recursive:true,force:true});}
});
