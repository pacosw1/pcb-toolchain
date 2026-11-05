// Stages a Git snapshot into content storage; it does not activate a project or prove signer/dependency provenance.
import {createHash} from 'node:crypto';import {spawn,spawnSync,type ChildProcess} from 'node:child_process';import fs from 'node:fs';import path from 'node:path';import {Transform} from 'node:stream';import {pipeline} from 'node:stream/promises';
import {parseCanonicalJson} from './canonical-json.ts';import {parseProjectManifest} from './protected-manifest.ts';import {materializeSnapshot} from './protected-materialize.ts';import {trustedExecutable} from './protected-input.ts';import {validateManifestPath} from './protected-link-resolution.ts';
import type {ProtectedBlobs} from './protected-blobs.ts';import type {SnapshotNode} from './protected-materialize.ts';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,OID=/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
type Entry={path:string;mode:string;oid:string;target?:string};
const utf8=(b:Uint8Array)=>new TextDecoder('utf-8',{fatal:true}).decode(b);
function privateRepo(repo:string):string {
 const uid=process.getuid?.();if(uid===undefined||!path.isAbsolute(repo))throw new Error('private repository ownership unavailable');
 const root=fs.lstatSync(repo);if(!root.isDirectory()||root.isSymbolicLink()||root.uid!==uid||(root.mode&0o077)!==0)throw new Error('repository must be service-private');
 const canonical=fs.realpathSync(repo);let ancestor=path.dirname(canonical);
 for(;;){const st=fs.lstatSync(ancestor),stickyRoot=st.uid===0&&(st.mode&0o1000)!==0;if(!st.isDirectory()||st.isSymbolicLink()||![0,uid].includes(st.uid)||((st.mode&0o022)!==0&&!stickyRoot))throw new Error('unsafe repository ancestor');const next=path.dirname(ancestor);if(next===ancestor)break;ancestor=next;}
 const stack=[canonical];let count=0;
 while(stack.length){const dir=stack.pop()!;for(const item of fs.readdirSync(dir,{withFileTypes:true})){
  if(++count>1_000_000)throw new Error('repository metadata limit exceeded');const file=path.join(dir,item.name),st=fs.lstatSync(file);
  if(st.isSymbolicLink()||st.uid!==uid||(st.mode&0o022)!==0)throw new Error('repository contains unsafe metadata');
  if(st.isDirectory())stack.push(file);else if(!st.isFile()||st.nlink!==1)throw new Error('repository contains unsupported object');
 }}
 if(fs.existsSync(path.join(canonical,'objects/info/alternates')))throw new Error('repository alternates are unsupported');
 return canonical;
}
function gitBlobMatches(bytes:Buffer,oid:string):boolean {return createHash(oid.length===40?'sha1':'sha256').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')===oid;}
function run(git:string,repo:string,args:string[],timeoutMs:number,maxBuffer:number):Buffer {
 const env={PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'};
 const result=spawnSync(git,['--no-replace-objects',`--git-dir=${repo}`,...args],{env,timeout:timeoutMs,maxBuffer,encoding:'buffer',stdio:['ignore','pipe','pipe']});
 if(result.error||result.status!==0)throw new Error(`git ${args[0]} failed`);return result.stdout;
}
async function extract(git:string,repo:string,commit:string,selected:string[],tar:string,destination:string,maxBytes:number,timeoutMs:number):Promise<void>{
 const env={PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'};
 const source=spawn(git,['--no-replace-objects',`--git-dir=${repo}`,'archive','--format=tar',commit,...(selected.length?['--',...selected]:[])],{env,stdio:['ignore','pipe','ignore']});
 const target=spawn(tar,['-xf','-','-C',destination],{env:{PATH:'/usr/bin:/bin'},stdio:['pipe','ignore','ignore']});let total=0;
 const limit=new Transform({transform(chunk:Buffer,_encoding,callback){total+=chunk.length;callback(total>maxBytes?new Error('git archive exceeds limit'):null,chunk);}});
 const wait=(child:ChildProcess)=>new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 const sourceExit=wait(source),targetExit=wait(target);
 const timer=setTimeout(()=>{source.kill('SIGKILL');target.kill('SIGKILL');},timeoutMs);timer.unref();
 try{await Promise.all([pipeline(source.stdout,limit,target.stdin),sourceExit.then(code=>{if(code!==0)throw new Error('git archive failed');}),targetExit.then(code=>{if(code!==0)throw new Error('git archive extraction failed');})]);}
 catch(error){source.kill('SIGKILL');target.kill('SIGKILL');await Promise.allSettled([sourceExit,targetExit]);throw error;}finally{clearTimeout(timer);}
}
/** The repository must be an exclusively service-owned private bare copy. Paths select exact explicit Git pathspecs. */
export async function stageGitImport(store:ProtectedBlobs,repo:string,commit:string,projectId:string,parent:string,options:{gitPath:string;gitSha256:string;tarPath:string;tarSha256:string;
  selectedPaths:string[];requiredPaths:string[];optionalAbsentPaths:string[];externalMounts:{path:string;manifest_sha256:string}[];maxFiles:number;maxFileBytes:number;maxArchiveBytes:number;timeoutMs:number}):
  Promise<{manifestSha256:string;provenanceSha256:string;gitCommit:string;files:number;bytes:number}> {
 if(!OID.test(commit)||!ID.test(projectId)||!path.isAbsolute(parent)||!Number.isSafeInteger(options.maxFiles)||options.maxFiles<1||options.maxFiles>25_000||
   !Number.isSafeInteger(options.maxFileBytes)||options.maxFileBytes<1||!Number.isSafeInteger(options.maxArchiveBytes)||options.maxArchiveBytes<1||!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>600_000||
   !Array.isArray(options.selectedPaths)||options.selectedPaths.length>4096||new Set(options.selectedPaths).size!==options.selectedPaths.length)throw new Error('invalid Git import request');
 for(const selected of options.selectedPaths){validateManifestPath(selected);if(selected.startsWith(':'))throw new Error('Git pathspec magic is unsupported');}
 const parentStat=fs.lstatSync(parent);if(!parentStat.isDirectory()||parentStat.isSymbolicLink()||(parentStat.mode&0o077)!==0||(process.getuid&&parentStat.uid!==process.getuid()))throw new Error('import parent must be service-private');
 const privatePath=privateRepo(repo),git=trustedExecutable(options.gitPath,options.gitSha256,'git'),tar=trustedExecutable(options.tarPath,options.tarSha256,'archive tool'),selected=options.selectedPaths.map(p=>`:(literal)${p}`);
 if(run(git,privatePath,['rev-parse','--is-bare-repository'],options.timeoutMs,1024).toString().trim()!=='true')throw new Error('import repository must be bare');
 const actual=run(git,privatePath,['rev-parse','--verify','--end-of-options',`${commit}^{commit}`],options.timeoutMs,1024).toString().trim();if(actual!==commit)throw new Error('Git commit differs');
 run(git,privatePath,['fsck','--full','--no-reflogs','--no-dangling',commit],options.timeoutMs,1024*1024);
 const listing=run(git,privatePath,['ls-tree','-rz','--full-tree',commit,...(selected.length?['--',...selected]:[])],options.timeoutMs,Math.min(128*1024*1024,options.maxFiles*4200)),entries:Entry[]=[];
 let start=0;for(let i=0;i<listing.length;i++)if(listing[i]===0){const item=listing.subarray(start,i),tab=item.indexOf(9);start=i+1;if(tab<0)throw new Error('invalid Git tree entry');
  const header=item.subarray(0,tab).toString('ascii').match(/^(100644|100755|120000) blob ([0-9a-f]{40}|[0-9a-f]{64})$/);if(!header)throw new Error('unsupported Git tree entry');
  const name=utf8(item.subarray(tab+1));validateManifestPath(name);entries.push({path:name,mode:header[1],oid:header[2]});if(entries.length>options.maxFiles)throw new Error('Git import file limit exceeded');}
 if(start!==listing.length||!entries.length)throw new Error('empty or malformed Git selection');
 for(const entry of entries)if(entry.mode==='120000'){const target=run(git,privatePath,['cat-file','blob',entry.oid],options.timeoutMs,4096);if(!gitBlobMatches(target,entry.oid))throw new Error('Git link object differs');entry.target=utf8(target);}
 const empty=Buffer.alloc(0),emptyHash=createHash('sha256').update(empty).digest('hex');
 const placeholders:SnapshotNode[]=entries.map(e=>e.mode==='120000'?{kind:'link',path:e.path,target:e.target!}:{kind:'file',path:e.path,sha256:emptyHash,size:0,executable:e.mode==='100755'});
 placeholders.sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
 const skeleton=parseCanonicalJson(Buffer.from(JSON.stringify({schema:'pcb.project-manifest.v1',project_id:projectId,entries:placeholders,required_paths:options.requiredPaths,optional_absent_paths:options.optionalAbsentPaths,external_mounts:options.externalMounts})),{maxBytes:8*1024*1024,maxNodes:200_000,maxDepth:16});parseProjectManifest(skeleton.canonical);
 const collisionProbe=materializeSnapshot(parent,placeholders,()=>empty,{maxFiles:options.maxFiles,maxBytes:1});fs.rmSync(collisionProbe,{recursive:true,force:true});
 const scratch=fs.mkdtempSync(path.join(parent,'git-import-'));let total=0;
 try{
  await extract(git,privatePath,commit,selected,tar,scratch,options.maxArchiveBytes,options.timeoutMs);
  if(trustedExecutable(git,options.gitSha256,'git')!==git||trustedExecutable(tar,options.tarSha256,'archive tool')!==tar)throw new Error('import executables changed');
  const nodes:SnapshotNode[]=[];
  for(const entry of entries){const file=path.join(scratch,entry.path),st=fs.lstatSync(file);
   if(entry.mode==='120000'){if(!st.isSymbolicLink()||fs.readlinkSync(file)!==entry.target)throw new Error('Git link differs after extraction');nodes.push({kind:'link',path:entry.path,target:entry.target!});continue;}
   const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
   try{const before=fs.fstatSync(fd);if(!before.isFile()||before.nlink!==1||(process.getuid&&before.uid!==process.getuid())||(before.mode&0o022)!==0||before.size>options.maxFileBytes||!!(before.mode&0o111)!==(entry.mode==='100755'))throw new Error('Git file metadata differs');
    const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd);if(bytes.length!==before.size||before.size!==after.size||before.ino!==after.ino||before.mtimeMs!==after.mtimeMs||!gitBlobMatches(bytes,entry.oid))throw new Error('Git file changed or archive transformed content');
    total+=bytes.length;if(!Number.isSafeInteger(total)||total>options.maxArchiveBytes)throw new Error('Git import byte limit exceeded');const hash=createHash('sha256').update(bytes).digest('hex');store.put(hash,bytes);nodes.push({kind:'file',path:entry.path,sha256:hash,size:bytes.length,executable:entry.mode==='100755'});
   }finally{fs.closeSync(fd);}
  }
  nodes.sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
  const document={schema:'pcb.project-manifest.v1',project_id:projectId,entries:nodes,required_paths:options.requiredPaths,optional_absent_paths:options.optionalAbsentPaths,external_mounts:options.externalMounts};
  const manifest=parseCanonicalJson(Buffer.from(JSON.stringify(document)),{maxBytes:8*1024*1024,maxNodes:200_000,maxDepth:16});parseProjectManifest(manifest.canonical);store.put(manifest.sha256,manifest.canonical);
  const provenance=parseCanonicalJson(Buffer.from(JSON.stringify({schema:'pcb.git-import.v1',project_id:projectId,git_commit:commit,
    git_object_format:commit.length===40?'sha1':'sha256',selected_paths:[...options.selectedPaths].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))),
    manifest_sha256:manifest.sha256,git_executable_sha256:options.gitSha256,archive_tool_sha256:options.tarSha256,files:nodes.length,bytes:total})),
    {maxBytes:1024*1024,maxNodes:20000,maxDepth:8});
  store.put(provenance.sha256,provenance.canonical);
  return {manifestSha256:manifest.sha256,provenanceSha256:provenance.sha256,gitCommit:commit,files:nodes.length,bytes:total};
 }finally{fs.rmSync(scratch,{recursive:true,force:true});}
}
