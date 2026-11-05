import assert from 'node:assert/strict';import {createHash,generateKeyPairSync,sign} from 'node:crypto';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {test} from 'node:test';
import {parseCanonicalJson} from '../src/canonical-json.ts';import {ProtectedTrustStore} from '../src/protected-trust-store.ts';import {launchProtectedAttemptFromTrustedService} from '../src/protected-launch.ts';import {installProtectedRuntime} from '../src/protected-runtime.ts';import {validateSpec} from '../src/manager.ts';import {rig} from './helpers.ts';
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex'),encode=(v:unknown)=>parseCanonicalJson(Buffer.from(JSON.stringify(v)),{maxBytes:100000,maxNodes:10000,maxDepth:16}).canonical;
class Fixture extends ProtectedTrustStore {
 seedTarget(source:string,policy:string,worker:string,toolchain:string,tar:string):void{
  this.db.prepare("INSERT INTO protected_targets VALUES ('p','b',1,1,'ACTIVE',?,'board')").run(source);
  this.db.prepare("INSERT INTO protected_aliases VALUES ('p','alias','b',1)").run();
  this.db.prepare("INSERT INTO protected_target_policy VALUES ('p','b',?,?,?)").run(policy,worker,toolchain);
  this.db.prepare("INSERT INTO protected_approved_digests VALUES ('runtime',?,1),('toolchain',?,1),('archive-tool',?,1)").run(worker,toolchain,tar);
 }
}
test('enrolled signed policy controls real manager admission and a trust change stops the worker',async()=>{
 const parent=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'pcb-signed-flow-')),trustFile=path.join(parent,'trust.json'),uid=process.getuid!(),keys=generateKeyPairSync('ed25519');
 const keyId=sha(keys.publicKey.export({type:'spki',format:'der'})),pem=keys.publicKey.export({type:'spki',format:'pem'}).toString();
 const trust=(version:number,revoked:boolean)=>encode({schema:'pcb.policy-trust.v1',version,signers:[{key_id:keyId,public_key_pem:pem,revoked}]});fs.writeFileSync(trustFile,trust(1,false),{mode:0o600});
 const worker='a'.repeat(64),verifier='b'.repeat(64),toolchain='c'.repeat(64),tar=sha(fs.readFileSync('/usr/bin/tar'));
 const policy=encode({schema:'pcb.verification-policy.v1',policy_id:'policy',project_id:'p',board_id:'b',operation:'route',board_path:'board',gate_board:'X',gate_project:'cad/X',required_checks:['drc'],warnings_as_errors:false,parity_not_applicable_allowed:false,worker_image_sha256:worker,verifier_image_sha256:verifier,toolchain_sha256:toolchain,archive_tool_sha256:tar,tool_versions:{kicad:'10'},external_inputs:[],allowed_pours:[],issued_at_ms:100,expires_at_ms:10000});
 const signature=sign(null,Buffer.concat([Buffer.from('pcb.verification-policy.v1\0'),policy]),keys.privateKey).toString('base64'),r=rig({images:[`sha256:${worker}`]});
 const store=new Fixture(path.join(parent,'store'),{maxBlobBytes:10000,quotaBytes:100000},trustFile,uid,()=>1000,()=>0n);
 try {
  const put=(bytes:Buffer)=>{const hash=sha(bytes);store.put(hash,bytes);return hash;};
  const board=Buffer.from('source'),boardHash=put(board),source=put(encode({schema:'pcb.project-manifest.v1',project_id:'p',entries:[{kind:'file',path:'board',sha256:boardHash,size:board.length,executable:false}],required_paths:['board'],optional_absent_paths:[],external_mounts:[]}));
  const policyHash=store.registerSignedPolicyFromTrustedService(policy,signature,keyId);store.seedTarget(source,policyHash,worker,toolchain,tar);
  const issued=store.issueFromTrustedService('submit','admin',{role:'submit',principal:'operator',project:'p',board:'b',operation:'route',job:null,attempt:null,issuedAtMs:1000,expiresAtMs:10000,maxUses:50});
  const workerCap=store.issueFromTrustedService('worker','admin',{role:'worker',principal:'worker',project:'p',board:'b',operation:'route',job:'job',attempt:'attempt',issuedAtMs:1000,expiresAtMs:10000,maxUses:50});
  if(issued.state!=='ISSUED'||workerCap.state!=='ISSUED')throw Error('capability missing');
  const ref={project:'p',board:'b',operation:'route',job:'job',attempt:'attempt'},lease=store.acquire(issued.token,{requestId:'lease',project:'p',board:'b',alias:'alias',aliasRevision:1,sourceRevision:1,sourceManifest:source,operation:'route',ttlMs:5000});
  if(lease.state!=='ACQUIRED')throw Error('lease missing');
  store.bindAttempt(issued.token,{...ref,generation:lease.generation,token:lease.token},{job:'job',attempt:'attempt',sourceManifest:source,policyDigest:policyHash,runtimeDigest:worker,toolchainDigest:toolchain});
  installProtectedRuntime(store,r.mgr);
  const result=launchProtectedAttemptFromTrustedService(store,r.mgr,ref,validateSpec({command:['hang'],maxRetries:0},r.cfg),parent,{tarPath:'/usr/bin/tar',tarSha256:tar,maxFiles:10,maxBytes:100,maxArchiveBytes:100000,timeoutMs:10000});
  if(result.state!=='SUBMITTED')throw Error('submission unresolved');await r.mgr.tick();const job=r.mgr.jobs.get(result.runtimeJob)!;assert.equal(job.state,'running');
  store.stageCandidate(workerCap.token,{...ref,manifest:source});
  fs.writeFileSync(trustFile,trust(2,true));
  await r.mgr.tick();assert.equal(job.state,'cancelled');assert.deepEqual(r.runtime.killed,[job.attempts[0].container]);
  assert.throws(()=>store.stageCandidate(workerCap.token,{...ref,manifest:source}),/policy/);
 } finally {store.close();r.cleanup();fs.rmSync(parent,{recursive:true,force:true});}
});
