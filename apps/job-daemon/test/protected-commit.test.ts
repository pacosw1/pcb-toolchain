import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { test } from 'node:test';
import { ProtectedCommitStore } from '../src/protected-commit.ts'; import { parseCanonicalJson } from '../src/canonical-json.ts';
const hash=(b:Uint8Array):string=>createHash('sha256').update(b).digest('hex');
const encode=(x:unknown):Buffer=>parseCanonicalJson(Buffer.from(JSON.stringify(x)),{maxBytes:1_000_000,maxNodes:1000,maxDepth:12}).canonical;
class Fixture extends ProtectedCommitStore {
  seed(source:string,policy:string,runtime:string,toolchain:string):void {
    this.db.prepare("INSERT INTO protected_targets VALUES ('p','b',1,1,'ACTIVE',?,'board')").run(source);
    this.db.prepare("INSERT INTO protected_aliases VALUES ('p','alias','b',1)").run();
    this.db.prepare("INSERT INTO protected_target_policy VALUES ('p','b',?,?,?)").run(policy,runtime,toolchain);
    this.db.prepare("INSERT INTO protected_policies VALUES (?, ?, 0, 1)").run(policy,JSON.stringify(['drc']));
    this.db.prepare("INSERT INTO protected_approved_digests VALUES ('runtime',?,1),('toolchain',?,1)").run(runtime,toolchain);
    this.db.prepare("INSERT INTO protected_verifiers VALUES ('verifier',1)").run();
  }
  verified(candidate:string,evidence:string,receipt:Buffer):void {
    this.db.prepare("INSERT INTO protected_verified_attempts VALUES ('job','attempt','verification',?,?,'verifier',?,'VERIFIED',0,0)").run(candidate,evidence,receipt);
  }
  revision():number { return (this.db.prepare("SELECT revision FROM protected_targets WHERE project='p' AND board='b'").get() as {revision:number}).revision; }
  pins(): {kind:string;owner:string;sha256:string}[] { return this.db.prepare('SELECT * FROM protected_blob_pins').all() as {kind:string;owner:string;sha256:string}[]; }
  revoke():void { this.db.prepare("UPDATE protected_verifiers SET enabled=0 WHERE id='verifier'").run(); }
  seedVerifierForTest():void { this.db.prepare("UPDATE protected_verifiers SET enabled=1 WHERE id='verifier'").run(); }
  resetCancellationForTest():void { this.db.prepare("UPDATE protected_attempt_cancellation SET cancelled=0 WHERE job='job' AND attempt='attempt'").run(); }
}
test('fenced verified commit atomically advances the target and replays its durable result',()=>{
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'pcb-commit-')); const now=1000;
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
    assert.throws(()=>store.stageCandidate(submit.token,candidateRef),/not authorized/);
    store.stageCandidate(worker.token,candidateRef); store.stageCandidate(worker.token,candidateRef);
    assert.throws(()=>store.stageCandidate(worker.token,{...candidateRef,manifest:source}),/candidate changed/);
    assert.ok(store.pins().some(p=>p.kind==='attempt-candidate'&&p.sha256===candidate));
    const receipt=encode({schema:'pcb.verification.v1',verification_id:'verification',job_id:'job',attempt_id:'attempt',project_id:'p',board_id:'b',alias_revision:1,lease_generation:lease.generation,source_revision:1,source_manifest_sha256:source,candidate_manifest_sha256:candidate,toolchain_digest:toolchain,runtime_digest:runtime,policy_digest:policy,evidence_manifest_sha256:evidence,verifier_identity:'verifier',issued_at_ms:now,expires_at_ms:5000,checks:[{id:'drc',outcome:'passed',evidence_manifest_sha256:evidence}],schematic_parity:'passed',worker_cleanup:'confirmed',cancellation:'not_cancelled',outcome:'passed'});
    store.verified(candidate,evidence,receipt);
    const request={schema:'pcb.commit-request.v1' as const,request_id:'request',job_id:'job',attempt_id:'attempt',verification_id:'verification',project_id:'p',board_id:'b',alias_revision:1,source_revision:1,candidate_manifest_sha256:candidate,lease_generation:lease.generation,lease_token:lease.token};
    assert.throws(()=>store.commit(commit.token,{...request,lease_token:'0'.repeat(64)}),/preconditions/); assert.equal(store.revision(),1);
    store.revoke(); assert.throws(()=>store.commit(commit.token,request),/authority/); assert.equal(store.revision(),1);
    store.seedVerifierForTest();
    store.cancelAttempt(cancel.token,candidateRef);
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
  } finally {store.close();fs.rmSync(parent,{recursive:true,force:true});}
});
