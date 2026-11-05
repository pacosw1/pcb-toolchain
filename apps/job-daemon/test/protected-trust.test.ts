import assert from 'node:assert/strict';import {createHash,generateKeyPairSync,sign} from 'node:crypto';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {test} from 'node:test';
import {parseCanonicalJson} from '../src/canonical-json.ts';import {readPolicyTrust} from '../src/protected-trust.ts';
import {ProtectedTrustStore} from '../src/protected-trust-store.ts';
class TrustFixture extends ProtectedTrustStore {
  policy(digest:string){return this.transaction(()=>this.authorizePolicy({digest,project:'p',board:'b',operation:'route',boardPath:'board',workerDigest:'e'.repeat(64),toolchainDigest:'b'.repeat(64),archiveDigest:'c'.repeat(64)},this.safeNow()));}
}
const encode=(v:unknown)=>parseCanonicalJson(Buffer.from(JSON.stringify(v)),{maxBytes:10000,maxNodes:1000,maxDepth:8}).canonical;
test('loads only a private-owner canonical Ed25519 trust file and rejects symlinks and writable files',()=>{
 const parent=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'pcb-trust-')),file=path.join(parent,'trust.json'),uid=process.getuid!(),{publicKey}=generateKeyPairSync('ed25519');
 const pem=publicKey.export({type:'spki',format:'pem'}).toString(),id=createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex');
 const bytes=encode({schema:'pcb.policy-trust.v1',version:1,signers:[{key_id:id,public_key_pem:pem,revoked:false}]});
 try {
  fs.writeFileSync(file,bytes,{mode:0o600});const trust=readPolicyTrust(file,uid);assert.equal(trust.signers[0].keyId,id);assert.equal(trust.version,1);
  fs.chmodSync(file,0o622);assert.throws(()=>readPolicyTrust(file,uid),/unsafe/);fs.chmodSync(file,0o600);
  fs.symlinkSync(file,path.join(parent,'link'));assert.throws(()=>readPolicyTrust(path.join(parent,'link'),uid));
  const alias=parent+'-alias';fs.symlinkSync(parent,alias);try{assert.throws(()=>readPolicyTrust(path.join(alias,'trust.json'),uid),/unsafe/);}finally{fs.unlinkSync(alias);}
  fs.chmodSync(parent,0o770);assert.throws(()=>readPolicyTrust(file,uid),/unsafe/);fs.chmodSync(parent,0o700);
  fs.writeFileSync(file,Buffer.from('{"schema":"pcb.policy-trust.v1","schema":"pcb.policy-trust.v1"}'));assert.throws(()=>readPolicyTrust(file,uid));
 } finally {fs.rmSync(parent,{recursive:true,force:true});}
});
test('registered policies are signed by enrolled keys and trust version cannot roll back',()=>{
 const parent=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'pcb-trust-store-')),file=path.join(parent,'trust.json'),uid=process.getuid!(),{publicKey,privateKey}=generateKeyPairSync('ed25519');
 const pem=publicKey.export({type:'spki',format:'pem'}).toString(),id=createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex');
 const trust=(version:number,revoked:boolean)=>encode({schema:'pcb.policy-trust.v1',version,signers:[{key_id:id,public_key_pem:pem,revoked}]});
 const policy=encode({schema:'pcb.verification-policy.v1',policy_id:'policy',project_id:'p',board_id:'b',operation:'route',board_path:'board',gate_board:'X',gate_project:'cad/X',required_checks:['erc'],warnings_as_errors:false,parity_not_applicable_allowed:false,worker_image_sha256:'e'.repeat(64),verifier_image_sha256:'a'.repeat(64),toolchain_sha256:'b'.repeat(64),archive_tool_sha256:'c'.repeat(64),tool_versions:{kicad:'10'},external_inputs:[],allowed_pours:[],issued_at_ms:100,expires_at_ms:1000});
 const signature=sign(null,Buffer.concat([Buffer.from('pcb.verification-policy.v1\0'),policy]),privateKey).toString('base64'),root=path.join(parent,'store');fs.writeFileSync(file,trust(1,false),{mode:0o600});
 let store=new TrustFixture(root,{maxBlobBytes:10000,quotaBytes:100000},file,uid,()=>200,()=>0n);
 try {
  const digest=store.registerSignedPolicyFromTrustedService(policy,signature,id);assert.equal(digest,createHash('sha256').update(policy).digest('hex'));
  assert.equal(store.registerSignedPolicyFromTrustedService(policy,signature,id),digest);
  assert.equal(store.policy(digest)?.board_id,'b');
  fs.writeFileSync(file,trust(2,true));assert.equal(store.policy(digest),null);
  assert.throws(()=>store.registerSignedPolicyFromTrustedService(policy,signature,id),/configuration changed/);
  store.close();store=new TrustFixture(root,{maxBlobBytes:10000,quotaBytes:100000},file,uid,()=>200,()=>0n);
  assert.equal(store.policy(digest),null);
  assert.throws(()=>store.registerSignedPolicyFromTrustedService(policy,signature,id),/not authorized/);
  store.close();fs.writeFileSync(file,trust(1,false));assert.throws(()=>new ProtectedTrustStore(root,{maxBlobBytes:10000,quotaBytes:100000},file,uid,()=>200,()=>0n),/rollback/);
 } finally {try{store.close();}catch{} fs.rmSync(parent,{recursive:true,force:true});}
});
