import assert from 'node:assert/strict';import {createHash,generateKeyPairSync,sign} from 'node:crypto';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {test} from 'node:test';
import {parseCanonicalJson} from '../src/canonical-json.ts';import {ProtectedVerifierAuthority} from '../src/protected-verifier-authority.ts';import {launchProtectedAttemptFromTrustedService} from '../src/protected-launch.ts';import {installProtectedRuntime,protectedVerifierCommand} from '../src/protected-runtime.ts';import {validateSpec} from '../src/manager.ts';import {rig} from './helpers.ts';import {protectedJobSpecDigest} from '../src/protected-job-spec.ts';
import {prepareVerifierInput} from '../src/protected-verifier-input.ts';import {spawnSync} from 'node:child_process';
import {launchProtectedVerifierFromTrustedService} from '../src/protected-verifier-launch.ts';
import {collectProtectedVerifierOutput} from '../src/protected-verifier-output.ts';
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex'),encode=(v:unknown)=>parseCanonicalJson(Buffer.from(JSON.stringify(v)),{maxBytes:100000,maxNodes:10000,maxDepth:16}).canonical;
class Fixture extends ProtectedVerifierAuthority {
 setPolicyForTest(policy:string,enabled:number):void{this.db.prepare('UPDATE protected_policies SET enabled=? WHERE digest=?').run(enabled,policy);}
 seedTarget(source:string,policy:string,worker:string,toolchain:string,tar:string,verifier:string):void{
  this.db.prepare("INSERT INTO protected_targets VALUES ('p','b',1,1,'ACTIVE',?,'board')").run(source);
  this.db.prepare("INSERT INTO protected_aliases VALUES ('p','alias','b',1)").run();
  this.db.prepare("INSERT INTO protected_target_policy VALUES ('p','b',?,?,?)").run(policy,worker,toolchain);
  this.db.prepare("INSERT INTO protected_approved_digests VALUES ('runtime',?,1),('toolchain',?,1),('archive-tool',?,1),('verifier-runtime',?,1)").run(worker,toolchain,tar,verifier);
 }
}
test('enrolled signed policy controls real manager admission and a trust change stops the worker',async()=>{
 const parent=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'pcb-signed-flow-')),trustFile=path.join(parent,'trust.json'),uid=process.getuid!(),keys=generateKeyPairSync('ed25519');
 const keyId=sha(keys.publicKey.export({type:'spki',format:'der'})),pem=keys.publicKey.export({type:'spki',format:'pem'}).toString();
 const trust=(version:number,revoked:boolean)=>encode({schema:'pcb.policy-trust.v1',version,signers:[{key_id:keyId,public_key_pem:pem,revoked}]});fs.writeFileSync(trustFile,trust(1,false),{mode:0o600});
 const worker='a'.repeat(64),verifier='b'.repeat(64),toolchain='c'.repeat(64),tar=sha(fs.readFileSync('/usr/bin/tar'));
 const policy=encode({schema:'pcb.verification-policy.v1',policy_id:'policy',project_id:'p',board_id:'b',operation:'route',board_path:'board',gate_board:'X',gate_project:'cad/X',required_checks:['drc'],warnings_as_errors:false,parity_not_applicable_allowed:false,worker_image_sha256:worker,verifier_image_sha256:verifier,toolchain_sha256:toolchain,archive_tool_sha256:tar,tool_versions:{kicad:'10'},external_inputs:[],allowed_pours:[],issued_at_ms:100,expires_at_ms:10000});
 const signature=sign(null,Buffer.concat([Buffer.from('pcb.verification-policy.v1\0'),policy]),keys.privateKey).toString('base64'),r=rig({images:[`sha256:${worker}`,`sha256:${verifier}`]});
 const store=new Fixture(path.join(parent,'store'),{maxBlobBytes:10000,quotaBytes:100000},trustFile,uid,()=>1000,()=>0n);
 try {
  const put=(bytes:Buffer)=>{const hash=sha(bytes);store.put(hash,bytes);return hash;};
  const board=Buffer.from('source'),boardHash=put(board),source=put(encode({schema:'pcb.project-manifest.v1',project_id:'p',entries:[{kind:'file',path:'board',sha256:boardHash,size:board.length,executable:false}],required_paths:['board'],optional_absent_paths:[],external_mounts:[]}));
  const policyHash=store.registerSignedPolicyFromTrustedService(policy,signature,keyId);store.seedTarget(source,policyHash,worker,toolchain,tar,verifier);
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
test('verifier input is built only after the exact worker is cleaned up',async()=>{
 const parent=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'pcb-verify-input-')),trustFile=path.join(parent,'trust.json'),uid=process.getuid!(),keys=generateKeyPairSync('ed25519');
 const keyId=sha(keys.publicKey.export({type:'spki',format:'der'})),pem=keys.publicKey.export({type:'spki',format:'pem'}).toString();
 fs.writeFileSync(trustFile,encode({schema:'pcb.policy-trust.v1',version:1,signers:[{key_id:keyId,public_key_pem:pem,revoked:false}]}),{mode:0o600});
 const worker='a'.repeat(64),verifier='b'.repeat(64),toolchain='c'.repeat(64),tar=sha(fs.readFileSync('/usr/bin/tar'));
 const policy=encode({schema:'pcb.verification-policy.v1',policy_id:'policy',project_id:'p',board_id:'b',operation:'route',board_path:'board',gate_board:'X',gate_project:'cad/X',required_checks:['drc'],warnings_as_errors:false,parity_not_applicable_allowed:false,worker_image_sha256:worker,verifier_image_sha256:verifier,toolchain_sha256:toolchain,archive_tool_sha256:tar,tool_versions:{kicad:'10'},external_inputs:[],allowed_pours:[],issued_at_ms:100,expires_at_ms:10000});
 const signature=sign(null,Buffer.concat([Buffer.from('pcb.verification-policy.v1\0'),policy]),keys.privateKey).toString('base64'),r=rig({images:[`sha256:${worker}`,`sha256:${verifier}`]});
 const store=new Fixture(path.join(parent,'store'),{maxBlobBytes:10000,quotaBytes:100000},trustFile,uid,()=>1000,()=>0n);
 try {
  const put=(bytes:Buffer)=>{const hash=sha(bytes);store.put(hash,bytes);return hash;},old=Buffer.from('source'),oldHash=put(old),candidateBytes=Buffer.from('candidate'),candidateHash=put(candidateBytes);
  const manifest=(hash:string,size:number)=>put(encode({schema:'pcb.project-manifest.v1',project_id:'p',entries:[{kind:'file',path:'board',sha256:hash,size,executable:false}],required_paths:['board'],optional_absent_paths:[],external_mounts:[]}));
  const source=manifest(oldHash,old.length),candidate=manifest(candidateHash,candidateBytes.length),policyHash=store.registerSignedPolicyFromTrustedService(policy,signature,keyId);store.seedTarget(source,policyHash,worker,toolchain,tar,verifier);
  const submit=store.issueFromTrustedService('submit','admin',{role:'submit',principal:'operator',project:'p',board:'b',operation:'route',job:null,attempt:null,issuedAtMs:1000,expiresAtMs:10000,maxUses:50});
  const workerCap=store.issueFromTrustedService('worker','admin',{role:'worker',principal:'worker',project:'p',board:'b',operation:'route',job:'job',attempt:'attempt',issuedAtMs:1000,expiresAtMs:10000,maxUses:50});
  const cancel=store.issueFromTrustedService('cancel','admin',{role:'cancel',principal:'operator',project:'p',board:'b',operation:'route',job:'job',attempt:'attempt',issuedAtMs:1000,expiresAtMs:10000,maxUses:50});
  if(submit.state!=='ISSUED'||workerCap.state!=='ISSUED'||cancel.state!=='ISSUED')throw Error('capability missing');
  const ref={project:'p',board:'b',operation:'route',job:'job',attempt:'attempt'},lease=store.acquire(submit.token,{requestId:'lease',project:'p',board:'b',alias:'alias',aliasRevision:1,sourceRevision:1,sourceManifest:source,operation:'route',ttlMs:5000});if(lease.state!=='ACQUIRED')throw Error('lease missing');
  store.bindAttempt(submit.token,{...ref,generation:lease.generation,token:lease.token},{job:'job',attempt:'attempt',sourceManifest:source,policyDigest:policyHash,runtimeDigest:worker,toolchainDigest:toolchain});installProtectedRuntime(store,r.mgr);
  const opts={tarPath:'/usr/bin/tar',maxFiles:20,maxBytes:10000,maxArchiveBytes:100000,timeoutMs:10000};
  const launched=launchProtectedAttemptFromTrustedService(store,r.mgr,ref,validateSpec({command:['pass'],maxRetries:0},r.cfg),parent,{...opts,tarSha256:tar});if(launched.state!=='SUBMITTED')throw Error('launch unresolved');
  await r.mgr.tick();store.stageCandidate(workerCap.token,{...ref,manifest:candidate});await r.mgr.tick();assert.equal(r.mgr.jobs.get(launched.runtimeJob)?.state,'passed');
  const verifierRef={...ref,verification:'verification'},unproved={sha256:'f'.repeat(64),size:1,specSha256:'e'.repeat(64),sourceManifest:source,candidateManifest:candidate,policySha256:policyHash,verifierImage:`sha256:${verifier}`,archiveToolSha256:tar};
  assert.throws(()=>store.reserveVerifierFromTrustedService(verifierRef,unproved),/stale/);
  r.runtime.inspectBroken=true;await assert.rejects(prepareVerifierInput(store,r.mgr,ref,parent,opts),/cleanup/);r.runtime.inspectBroken=false;
  const input=await prepareVerifierInput(store,r.mgr,ref,parent,opts);assert.equal(input.verifierImage,`sha256:${verifier}`);
  const dest=path.join(parent,'extracted');fs.mkdirSync(dest);assert.equal(spawnSync('/usr/bin/tar',['-xzf',input.archive,'-C',dest]).status,0);
  assert.deepEqual(fs.readFileSync(path.join(dest,'board')),candidateBytes);assert.deepEqual(fs.readFileSync(path.join(dest,'__pcb_verify/source.kicad_pcb')),old);assert.deepEqual(fs.readFileSync(path.join(dest,'__pcb_verify/policy.json')),policy);
  const verifierSpec=validateSpec({name:'protected-verifier',command:protectedVerifierCommand(policyHash),image:`sha256:${verifier}`,maxRetries:0},r.cfg),identity={...input,specSha256:protectedJobSpecDigest(verifierSpec)};
  store.reserveVerifierFromTrustedService(verifierRef,identity);store.reserveVerifierFromTrustedService(verifierRef,identity);
  const verifyJob=r.mgr.submit(verifierSpec,input.archive,undefined,verifierRef);
  await r.mgr.tick();assert.equal(verifyJob.state,'queued');
  assert.deepEqual(await launchProtectedVerifierFromTrustedService(store,r.mgr,verifierRef,parent,opts),{state:'SUBMITTED',runtimeJob:verifyJob.id});
  assert.deepEqual(await launchProtectedVerifierFromTrustedService(store,r.mgr,verifierRef,parent,opts),{state:'SUBMITTED',runtimeJob:verifyJob.id});
  await assert.rejects(launchProtectedVerifierFromTrustedService(store,r.mgr,verifierRef,parent,opts,{cpus:0.5}),/submission changed/);
  store.associateVerifierFromTrustedService(verifierRef,verifyJob.id);
  store.setPolicyForTest(policyHash,0);await r.mgr.tick();assert.equal(verifyJob.state,'queued');store.setPolicyForTest(policyHash,1);
  verifyJob.spec.command[0]='/bin/other';await r.mgr.tick();assert.equal(verifyJob.state,'queued');
  verifyJob.spec.command[0]='/usr/local/bin/node';await r.mgr.tick();assert.equal(verifyJob.state,'running');
  assert.equal(store.canRunVerifier(verifierRef,verifyJob.id,true),true);
  await assert.rejects(collectProtectedVerifierOutput(store,r.mgr,verifierRef,verifyJob.id),/not completed/);
  const output=r.mgr.store.outDir(verifyJob.id,1),gate=path.join(output,'gate');fs.mkdirSync(gate,{recursive:true});
  const inputs=[{path:'board',sha256:candidateHash}],tools={kicad:'10'},fingerprint=sha(Buffer.from(JSON.stringify({inputs,tools}))),pourHash=createHash('sha256').update('pcb.allowed-pours.v1\0').update('[]').digest('hex');
  const write=(name:string,value:unknown)=>fs.writeFileSync(path.join(output,name),JSON.stringify(value));
  write('scan.json',{schema:'pcb.verifier-scan.v1',policy_sha256:policyHash,input_sha256:fingerprint,inputs,tools,configured_checks:['drc'],gate_exit:0,terminal_event:true});
  write('identity.json',{schema:'pcb.board-identity.v1',sourceSha256:oldHash,candidateSha256:candidateHash,allowedPoursSha256:pourHash,identityPreserved:true});
  write('gate/result.json',{exit:0,changedDuringRun:false,provenance:{input_sha256:fingerprint,inputs,tools},preflightErrors:[],checks:{drc:{status:'passed',cached:false,metrics:{drc_errors:0,drc_parity:0}}}});
  write('gate/findings.json',{schema_version:1,board:'X',project:'cad/X',input_sha256:fingerprint,inputs_valid:true,complete:true,completed_checks:['drc'],findings:[]});
  write('gate/drc.json',{violations:[],schematic_parity:[],unconnected_items:[]});
  fs.writeFileSync(path.join(gate,'events.jsonl'),JSON.stringify({type:'gate.end',exit:0,changedDuringRun:false})+'\n');
  fs.writeFileSync(path.join(gate,'drc.log'),'');fs.writeFileSync(path.join(output,'gate.stdout'),'');fs.writeFileSync(path.join(output,'gate.stderr'),'');
  r.runtime.containers.set(verifyJob.attempts[0].container,{status:'exited',exitCode:0,oomKilled:false});await r.mgr.tick();assert.equal(verifyJob.state,'passed');
  await assert.rejects(collectProtectedVerifierOutput(store,r.mgr,verifierRef,verifyJob.id),/service-private/);
  fs.chmodSync(r.mgr.store.root,0o700);
  const collected=await collectProtectedVerifierOutput(store,r.mgr,verifierRef,verifyJob.id);assert.equal(collected.runtimeJob,verifyJob.id);assert.equal(collected.files.size,9);
  store.cancelAttempt(cancel.token,ref);assert.equal(store.canRunVerifier(verifierRef,verifyJob.id,true),false);
 } finally {store.close();r.cleanup();fs.rmSync(parent,{recursive:true,force:true});}
});
