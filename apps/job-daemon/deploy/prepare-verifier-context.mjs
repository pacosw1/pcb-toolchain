#!/usr/bin/env node
// Creates a new build context from committed source; no worktree or production files are changed.
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const digest=b=>createHash('sha256').update(b).digest('hex');
export function prepareVerifierContext(repo,revision,destination,nodeImage,kicadImage){
 if(!path.isAbsolute(destination)||!/^sha256:[0-9a-f]{64}$/.test(nodeImage)||!/^sha256:[0-9a-f]{64}$/.test(kicadImage))throw new Error('destination or image IDs are invalid');
 const git=(...args)=>execFileSync('git',args,{cwd:repo,maxBuffer:64*1024*1024}),commit=git('rev-parse','--verify','--end-of-options',`${revision}^{commit}`).toString().trim();
 const entries=git('ls-tree','-r',commit,'--','tools','apps/job-daemon/deploy/verifier.Dockerfile').toString().trim().split('\n').filter(Boolean);
 if(!entries.length||entries.some(line=>!/^100(644|755) blob [0-9a-f]+\t/.test(line))||!entries.some(line=>line.endsWith('\ttools/pcb-protected-verifier.ts'))||!entries.some(line=>line.endsWith('\tapps/job-daemon/deploy/verifier.Dockerfile')))throw new Error('verifier source contains missing or unsupported entries');
 const archive=git('archive','--format=tar',commit,'--','tools','apps/job-daemon/deploy/verifier.Dockerfile');
 fs.mkdirSync(destination,{mode:0o700});
 try{
  const extract=spawnSync('/usr/bin/tar',['-xf','-','-C',destination],{input:archive,maxBuffer:1024*1024});if(extract.status!==0)throw new Error('cannot extract verifier source');
  const dockerfile=fs.readFileSync(path.join(destination,'apps/job-daemon/deploy/verifier.Dockerfile'));fs.writeFileSync(path.join(destination,'Dockerfile'),dockerfile,{flag:'wx',mode:0o600});
  const manifest={schema:'pcb.verifier-build-context.v1',commit,sourceArchiveSha256:digest(archive),dockerfileSha256:digest(dockerfile),nodeImage,kicadImage};
  fs.writeFileSync(path.join(destination,'provenance.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});return manifest;
 }catch(error){fs.rmSync(destination,{recursive:true,force:true});throw error;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [revision,destination,nodeImage,kicadImage]=process.argv.slice(2);if(!revision||!destination||!nodeImage||!kicadImage||process.argv.length!==6)throw new Error('usage: prepare-verifier-context.mjs COMMIT NEW_DIRECTORY NODE_IMAGE_ID KICAD_IMAGE_ID');
 console.log(JSON.stringify(prepareVerifierContext(process.cwd(),revision,path.resolve(destination),nodeImage,kicadImage)));
}
