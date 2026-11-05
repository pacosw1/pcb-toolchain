import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { test } from 'node:test';
import { ProtectedCommitStore } from '../src/protected-commit.ts'; import { parseCanonicalJson } from '../src/canonical-json.ts';
import { installProtectedRuntime, reconcileProtectedCancellations, recoverAbandonedProtectedAttempt, recoverUnassociatedProtectedSubmission } from '../src/protected-runtime.ts';
import { prepareAttemptInput } from '../src/protected-input.ts';
import { launchProtectedAttemptFromTrustedService } from '../src/protected-launch.ts';
import { validateSpec } from '../src/manager.ts';
import { protectedJobSpecDigest } from '../src/protected-job-spec.ts';
import { rig } from './helpers.ts';
import type { SignedVerificationPolicy } from '../src/protected-policy.ts';
const hash=(b:Uint8Array):string=>createHash('sha256').update(b).digest('hex');
const tarHash=hash(fs.readFileSync('/usr/bin/tar'));
const encode=(x:unknown):Buffer=>parseCanonicalJson(Buffer.from(JSON.stringify(x)),{maxBytes:1_000_000,maxNodes:1000,maxDepth:12}).canonical;
class Fixture extends ProtectedCommitStore {
  protected override verifierRecordTrusted():boolean {return true;} // Synthetic verifier fixture only.
  protected override authorizePolicy(input:{digest:string;project:string;board:string;operation:string;boardPath:string;workerDigest:string;toolchainDigest:string;archiveDigest:string},_now:number):SignedVerificationPolicy {
    return {schema:'pcb.verification-policy.v1',policy_id:'fixture',project_id:input.project,board_id:input.board,operation:input.operation,board_path:input.boardPath,gate_board:'X',gate_project:'cad/X',required_checks:['drc'],warnings_as_errors:false,parity_not_applicable_allowed:false,
      worker_image_sha256:input.workerDigest,verifier_image_sha256:'d'.repeat(64),toolchain_sha256:input.toolchainDigest,archive_tool_sha256:input.archiveDigest,tool_versions:{kicad:'10'},external_inputs:[],allowed_pours:[],issued_at_ms:1,expires_at_ms:10000};
  }
  seed(source:string,policy:string,runtime:string,toolchain:string):void {
    this.db.prepare("INSERT INTO protected_targets VALUES ('p','b',1,1,'ACTIVE',?,'board')").run(source);
    this.db.prepare("INSERT INTO protected_aliases VALUES ('p','alias','b',1)").run();
    this.db.prepare("INSERT INTO protected_target_policy VALUES ('p','b',?,?,?)").run(policy,runtime,toolchain);
    this.db.prepare("INSERT INTO protected_policies VALUES (?, ?, 0, 1)").run(policy,JSON.stringify(['drc']));
    this.db.prepare("INSERT INTO protected_approved_digests VALUES ('runtime',?,1),('toolchain',?,1)").run(runtime,toolchain);
    this.db.prepare("INSERT INTO protected_approved_digests VALUES ('archive-tool',?,1)").run(tarHash);
    this.db.prepare("INSERT INTO protected_verifiers VALUES ('verifier',1)").run();
  }
  verified(candidate:string,evidence:string,receipt:Buffer):void {
    const receiptHash=hash(receipt);this.put(receiptHash,receipt);
    this.db.prepare("INSERT INTO protected_verified_attempts VALUES ('job','attempt','verification',?,?,'verifier',?,'VERIFIED',0,0,?,?)").run(candidate,evidence,receipt,'d'.repeat(64),receiptHash);
  }
  revision():number { return (this.db.prepare("SELECT revision FROM protected_targets WHERE project='p' AND board='b'").get() as {revision:number}).revision; }
  pins(): {kind:string;owner:string;sha256:string}[] { return this.db.prepare('SELECT * FROM protected_blob_pins').all() as {kind:string;owner:string;sha256:string}[]; }
  revoke():void { this.db.prepare("UPDATE protected_verifiers SET enabled=0 WHERE id='verifier'").run(); }
  seedVerifierForTest():void { this.db.prepare("UPDATE protected_verifiers SET enabled=1 WHERE id='verifier'").run(); }
  approveArchiveForTest(enabled:number):void { this.db.prepare("UPDATE protected_approved_digests SET enabled=? WHERE kind='archive-tool' AND digest=?").run(enabled,tarHash); }
  resetCancellationForTest():void { this.db.prepare("UPDATE protected_attempt_cancellation SET cancelled=0 WHERE job='job' AND attempt='attempt'").run(); }
}
test('fenced verified commit atomically advances the target and replays its durable result',async()=>{
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'pcb-commit-')); const now=1000;
  const jobRig = rig({images:[`sha256:${'b'.repeat(64)}`]});
  const store=new Fixture(path.join(parent,'store'),{maxBlobBytes:10000,quotaBytes:100000},()=>now,()=>0n);
  const put=(b:Buffer):string=>{const h=hash(b);store.put(h,b);return h;};
  const manifest=(content:Buffer):string=>{const h=put(content);return put(encode({schema:'pcb.project-manifest.v1',project_id:'p',entries:[{kind:'file',path:'board',sha256:h,size:content.length,executable:false}],required_paths:['board'],optional_absent_paths:[],external_mounts:[]}));};
  try {
    const source=manifest(Buffer.from('old')), candidate=manifest(Buffer.from('new')), evidence=put(Buffer.from('evidence'));
    const policy='a'.repeat(64), runtime='b'.repeat(64), toolchain='c'.repeat(64); store.seed(source,policy,runtime,toolchain);
    const submit=store.issueFromTrustedService('submit','admin',{role:'submit',principal:'operator',project:'p',board:'b',operation:'route',job:null,attempt:null,issuedAtMs:now,expiresAtMs:10000,maxUses:50});
    const commit=store.issueFromTrustedService('commit','admin',{role:'commit',principal:'operator',project:'p',board:'b',operation:'route',job:'job',attempt:'attempt',issuedAtMs:now,expiresAtMs:10000,maxUses:50});
    const worker=store.issueFromTrustedService('worker','admin',{role:'worker',principal:'worker',project:'p',board:'b',operation:'route',job:'job',attempt:'attempt',issuedAtMs:now,expiresAtMs:10000,maxUses:50});
    const cancel=store.issueFromTrustedService('cancel','admin',{role:'cancel',principal:'operator',project:'p',board:'b',operation:'route',job:'job',attempt:'attempt',issuedAtMs:now,expiresAtMs:10000,maxUses:50});
    if(submit.state!=='ISSUED'||commit.state!=='ISSUED'||worker.state!=='ISSUED'||cancel.state!=='ISSUED') throw Error('capability missing');
    const lease=store.acquire(submit.token,{requestId:'lease',project:'p',board:'b',alias:'alias',aliasRevision:1,sourceRevision:1,sourceManifest:source,operation:'route',ttlMs:5000});
    if(lease.state!=='ACQUIRED') throw Error('lease missing');
    store.bindAttempt(submit.token,{project:'p',board:'b',operation:'route',generation:lease.generation,token:lease.token},{job:'job',attempt:'attempt',sourceManifest:source,policyDigest:policy,runtimeDigest:runtime,toolchainDigest:toolchain});
    const candidateRef={project:'p',board:'b',operation:'route',job:'job',attempt:'attempt',manifest:candidate};
    const input = prepareAttemptInput(store,candidateRef,parent,{tarPath:'/usr/bin/tar',tarSha256:tarHash,maxFiles:10,maxBytes:100,maxArchiveBytes:100000,timeoutMs:10000});
    assert.equal(input.sourceManifest,source);
    const runtimeJob=jobRig.mgr.submit(validateSpec({command:['hang'],maxRetries:0},jobRig.cfg),input.archive,candidateRef);
    const associatedInput = {...input,specSha256:protectedJobSpecDigest(runtimeJob.spec)};
    installProtectedRuntime(store,jobRig.mgr);
    await jobRig.mgr.tick(); assert.equal(runtimeJob.state,'queued');
    assert.equal(store.canDispatchProtected(candidateRef,runtimeJob.id),false);
    assert.throws(()=>store.associateRuntimeFromTrustedService(candidateRef,runtimeJob.id,associatedInput),/association is stale/);
    store.reserveSubmissionFromTrustedService(candidateRef,associatedInput);
    store.reserveSubmissionFromTrustedService(candidateRef,associatedInput);
    assert.throws(()=>store.reserveSubmissionFromTrustedService(candidateRef,{...associatedInput,sha256:'f'.repeat(64)}),/intent changed/);
    const options={tarPath:'/usr/bin/tar',tarSha256:tarHash,maxFiles:10,maxBytes:100,maxArchiveBytes:100000,timeoutMs:10000};
    const other=rig({images:[`sha256:${'b'.repeat(64)}`]});
    try {
      installProtectedRuntime(store,other.mgr);
      assert.equal(launchProtectedAttemptFromTrustedService(store,other.mgr,candidateRef,runtimeJob.spec,parent,options).state,'UNKNOWN');
      assert.equal(other.mgr.jobs.size,0);
    } finally { other.cleanup(); }
    assert.deepEqual(launchProtectedAttemptFromTrustedService(store,jobRig.mgr,candidateRef,runtimeJob.spec,parent,options),{state:'SUBMITTED',runtimeJob:runtimeJob.id});
    store.associateRuntimeFromTrustedService(candidateRef,runtimeJob.id,associatedInput);
    store.associateRuntimeFromTrustedService(candidateRef,runtimeJob.id,associatedInput);
    assert.throws(()=>store.associateRuntimeFromTrustedService(candidateRef,'different-job',associatedInput),/changed/);
    assert.equal(store.canDispatchProtected(candidateRef,runtimeJob.id),true);
    await jobRig.mgr.tick(); assert.equal(runtimeJob.state,'running');
    assert.equal(fs.readFileSync(path.join(jobRig.mgr.store.workDir(runtimeJob.id,1),'board'),'utf8'),'old');
    assert.throws(()=>store.stageCandidate(submit.token,candidateRef),/not authorized/);
    store.stageCandidate(worker.token,candidateRef); store.stageCandidate(worker.token,candidateRef);
    assert.equal(store.canDispatchProtected(candidateRef,runtimeJob.id),false);
    assert.throws(()=>store.stageCandidate(worker.token,{...candidateRef,manifest:source}),/candidate changed/);
    assert.ok(store.pins().some(p=>p.kind==='attempt-candidate'&&p.sha256===candidate));
    const receipt=encode({schema:'pcb.verification.v1',verification_id:'verification',job_id:'job',attempt_id:'attempt',project_id:'p',board_id:'b',alias_revision:1,lease_generation:lease.generation,source_revision:1,source_manifest_sha256:source,candidate_manifest_sha256:candidate,toolchain_digest:toolchain,runtime_digest:runtime,policy_digest:policy,evidence_manifest_sha256:evidence,verifier_identity:'verifier',issued_at_ms:now,expires_at_ms:5000,checks:[{id:'drc',outcome:'passed',evidence_manifest_sha256:evidence}],schematic_parity:'passed',worker_cleanup:'confirmed',cancellation:'not_cancelled',outcome:'passed'});
    store.verified(candidate,evidence,receipt);
    const request={schema:'pcb.commit-request.v1' as const,request_id:'request',job_id:'job',attempt_id:'attempt',verification_id:'verification',project_id:'p',board_id:'b',alias_revision:1,source_revision:1,candidate_manifest_sha256:candidate,lease_generation:lease.generation,lease_token:lease.token};
    assert.throws(()=>store.commit(commit.token,{...request,lease_token:'0'.repeat(64)}),/preconditions/); assert.equal(store.revision(),1);
    store.revoke(); assert.throws(()=>store.commit(commit.token,request),/authority/); assert.equal(store.revision(),1);
    store.seedVerifierForTest();
    store.approveArchiveForTest(0); assert.throws(()=>store.commit(commit.token,request),/authority/); assert.equal(store.revision(),1);
    store.approveArchiveForTest(1);
    store.cancelAttempt(cancel.token,candidateRef);
    await jobRig.mgr.tick(); assert.equal(runtimeJob.state,'cancelled');
    assert.throws(()=>prepareAttemptInput(store,candidateRef,parent,{tarPath:'/usr/bin/tar',tarSha256:tarHash,maxFiles:10,maxBytes:100,maxArchiveBytes:100000,timeoutMs:10000}),/stale/);
    const jobs = new Map<string, unknown>(), calls:string[] = [];
    const manager = {jobs,cancel:(id:string)=>{calls.push(id);return jobs.get(id);}};
    assert.deepEqual(reconcileProtectedCancellations(store,manager as never).unavailable,[runtimeJob.id]);
    jobs.set(runtimeJob.id,{});
    assert.deepEqual(reconcileProtectedCancellations(store,manager as never).requested,[runtimeJob.id]);
    assert.deepEqual(calls,[runtimeJob.id]);
    assert.throws(()=>store.commit(commit.token,request),/preconditions/);
    assert.ok(store.pins().some(p=>p.kind==='attempt-candidate'&&p.sha256===candidate));
    store.resetCancellationForTest(); // Test fixture only; no production uncancel path exists.
    const result=store.commit(commit.token,request); assert.equal(result.state,'COMMITTED'); assert.equal(store.revision(),2);
    assert.throws(()=>store.cancelAttempt(cancel.token,candidateRef),/already committed/);
    const pins=store.pins();
    assert.ok(pins.some(p=>p.kind==='revision'&&p.owner===JSON.stringify(['p','b',1])&&p.sha256===source));
    assert.ok(pins.some(p=>p.kind==='revision'&&p.owner===JSON.stringify(['p','b',2])&&p.sha256===candidate));
    assert.ok(pins.some(p=>p.kind==='revision-evidence'&&p.owner===JSON.stringify(['p','b',2])&&p.sha256===evidence));
    assert.equal(pins.some(p=>p.kind==='attempt-source'),false);
    assert.equal(pins.some(p=>p.kind==='attempt-candidate'),false);
    assert.deepEqual(store.commit(commit.token,request),result);
    assert.throws(()=>store.commit(commit.token,{...request,candidate_manifest_sha256:source}),/reused/);
  } finally {store.close();jobRig.cleanup();fs.rmSync(parent,{recursive:true,force:true});}
});

test('recovers a queued orphan after intent persisted but runtime association was interrupted',async()=>{
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'pcb-orphan-')), jobRig=rig({images:[`sha256:${'b'.repeat(64)}`]});
  let store=new Fixture(path.join(parent,'store'),{maxBlobBytes:10000,quotaBytes:100000},()=>1000,()=>0n);
  const put=(b:Buffer):string=>{const h=hash(b);store.put(h,b);return h;};
  try {
    const bytes=Buffer.from('source'), boardHash=put(bytes), source=put(encode({schema:'pcb.project-manifest.v1',project_id:'p',entries:[{kind:'file',path:'board',sha256:boardHash,size:bytes.length,executable:false}],required_paths:['board'],optional_absent_paths:[],external_mounts:[]}));
    const policy='a'.repeat(64),runtime='b'.repeat(64),toolchain='c'.repeat(64);store.seed(source,policy,runtime,toolchain);
    const issue=(id:string)=>store.issueFromTrustedService(id,'admin',{role:'submit',principal:'operator',project:'p',board:'b',operation:'route',job:null,attempt:null,issuedAtMs:1000,expiresAtMs:10000,maxUses:50});
    const before=issue('before');if(before.state!=='ISSUED')throw Error('capability missing');
    const req={requestId:'old',project:'p',board:'b',alias:'alias',aliasRevision:1,sourceRevision:1,sourceManifest:source,operation:'route',ttlMs:5000};
    const lease=store.acquire(before.token,req);if(lease.state!=='ACQUIRED')throw Error('lease missing');
    const ref={project:'p',board:'b',operation:'route',job:'job',attempt:'attempt'};
    store.bindAttempt(before.token,{...ref,generation:lease.generation,token:lease.token},{job:'job',attempt:'attempt',sourceManifest:source,policyDigest:policy,runtimeDigest:runtime,toolchainDigest:toolchain});
    const input=prepareAttemptInput(store,ref,parent,{tarPath:'/usr/bin/tar',tarSha256:tarHash,maxFiles:10,maxBytes:100,maxArchiveBytes:100000,timeoutMs:10000});
    const spec=validateSpec({command:['hang'],maxRetries:0},jobRig.cfg), associated={...input,specSha256:protectedJobSpecDigest(spec)};
    store.reserveSubmissionFromTrustedService(ref,associated);
    const job=jobRig.mgr.submit(spec,input.archive,ref); // Crash before association.
    store.close();store=new Fixture(path.join(parent,'store'),{maxBlobBytes:10000,quotaBytes:100000},()=>1000,()=>0n);
    jobRig.restart();installProtectedRuntime(store,jobRig.mgr);
    const fresh=issue('after');if(fresh.state!=='ISSUED')throw Error('capability missing');
    const other=rig({images:[`sha256:${runtime}`]});
    try { assert.equal(await recoverUnassociatedProtectedSubmission(store,other.mgr,ref),'PENDING'); } finally {other.cleanup();}
    assert.equal(store.acquire(fresh.token,{...req,requestId:'busy'}).state,'BUSY');
    assert.equal(await recoverUnassociatedProtectedSubmission(store,jobRig.mgr,ref),'CLEANED');
    assert.equal(jobRig.mgr.jobs.get(job.id)?.state,'cancelled');assert.equal(jobRig.runtime.started.length,0);
    assert.equal(store.acquire(fresh.token,{...req,requestId:'next'}).state,'ACQUIRED');
  } finally {store.close();jobRig.cleanup();fs.rmSync(parent,{recursive:true,force:true});}
});

test('recovery keeps a prior-boot writer fenced until the manager proves cleanup',async()=>{
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'pcb-abandon-')), jobRig=rig({images:[`sha256:${'b'.repeat(64)}`]});
  let store=new Fixture(path.join(parent,'store'),{maxBlobBytes:10000,quotaBytes:100000},()=>1000,()=>0n);
  const put=(b:Buffer):string=>{const h=hash(b);store.put(h,b);return h;};
  try {
    const board=Buffer.from('source'), boardHash=put(board);
    const source=put(encode({schema:'pcb.project-manifest.v1',project_id:'p',entries:[{kind:'file',path:'board',sha256:boardHash,size:board.length,executable:false}],required_paths:['board'],optional_absent_paths:[],external_mounts:[]}));
    const policy='a'.repeat(64),runtime='b'.repeat(64),toolchain='c'.repeat(64);store.seed(source,policy,runtime,toolchain);
    const issue=(id:string)=>store.issueFromTrustedService(id,'admin',{role:'submit',principal:'operator',project:'p',board:'b',operation:'route',job:null,attempt:null,issuedAtMs:1000,expiresAtMs:10000,maxUses:50});
    const submit=issue('before');if(submit.state!=='ISSUED')throw Error('capability missing');
    const request={requestId:'old',project:'p',board:'b',alias:'alias',aliasRevision:1,sourceRevision:1,sourceManifest:source,operation:'route',ttlMs:5000};
    const lease=store.acquire(submit.token,request);if(lease.state!=='ACQUIRED')throw Error('lease missing');
    const ref={project:'p',board:'b',operation:'route',job:'job',attempt:'attempt'};
    store.bindAttempt(submit.token,{...ref,generation:lease.generation,token:lease.token},{job:'job',attempt:'attempt',sourceManifest:source,policyDigest:policy,runtimeDigest:runtime,toolchainDigest:toolchain});
    installProtectedRuntime(store,jobRig.mgr);
    const spec=validateSpec({command:['hang'],maxRetries:0},jobRig.cfg), options={tarPath:'/usr/bin/tar',tarSha256:tarHash,maxFiles:10,maxBytes:100,maxArchiveBytes:100000,timeoutMs:10000};
    const launched=launchProtectedAttemptFromTrustedService(store,jobRig.mgr,ref,spec,parent,options);
    if(launched.state!=='SUBMITTED') throw Error('launch unresolved');
    assert.deepEqual(launchProtectedAttemptFromTrustedService(store,jobRig.mgr,ref,spec,parent,options),launched);
    assert.throws(()=>launchProtectedAttemptFromTrustedService(store,jobRig.mgr,ref,{...spec,command:['different']},parent,options),/changed/);
    assert.equal(jobRig.mgr.jobs.size,1);
    const job=jobRig.mgr.jobs.get(launched.runtimeJob)!;
    await jobRig.mgr.tick();assert.equal(job.state,'running');
    store.close();store=new Fixture(path.join(parent,'store'),{maxBlobBytes:10000,quotaBytes:100000},()=>1000,()=>0n);
    jobRig.restart();installProtectedRuntime(store,jobRig.mgr);
    const fresh=issue('after');if(fresh.state!=='ISSUED')throw Error('capability missing');
    jobRig.runtime.inspectBroken=true;
    assert.equal(await recoverAbandonedProtectedAttempt(store,jobRig.mgr,ref),'PENDING');
    assert.equal(store.acquire(fresh.token,{...request,requestId:'busy'}).state,'BUSY');
    jobRig.runtime.inspectBroken=false;
    assert.equal(await recoverAbandonedProtectedAttempt(store,jobRig.mgr,ref),'CLEANED');
    assert.equal(await recoverAbandonedProtectedAttempt(store,jobRig.mgr,ref),'CLEANED');
    const next=store.acquire(fresh.token,{...request,requestId:'new'});assert.equal(next.state,'ACQUIRED');if(next.state==='ACQUIRED')assert.equal(next.generation,lease.generation+1);
  } finally {store.close();jobRig.cleanup();fs.rmSync(parent,{recursive:true,force:true});}
});
