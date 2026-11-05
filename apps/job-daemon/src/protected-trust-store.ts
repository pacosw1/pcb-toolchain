// Internal bootstrap; callers must choose a fixed service-owned trust path, never a network-provided path.
import { createPublicKey, type KeyObject } from 'node:crypto';
import { ProtectedCommitStore } from './protected-commit.ts';
import { readPolicyTrust } from './protected-trust.ts';
import { verifySignedPolicy } from './protected-policy.ts';
import type { SignedVerificationPolicy } from './protected-policy.ts';

export class ProtectedTrustStore extends ProtectedCommitStore {
  private trustFile:string;
  private trustUid:number;
  private trustDigest:string;
  constructor(root:string,limits:{maxBlobBytes:number;quotaBytes:number},trustFile:string,ownerUid:number,now:()=>number=Date.now,monotonic:()=>bigint=process.hrtime.bigint){
    const snapshot=readPolicyTrust(trustFile,ownerUid);
    super(root,limits,now,monotonic);
    this.trustFile=trustFile;this.trustUid=ownerUid;this.trustDigest=snapshot.sha256;
    this.db.exec(`CREATE TABLE IF NOT EXISTS protected_trust_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL,sha256 TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS protected_policy_signers (key_id TEXT PRIMARY KEY,pem TEXT NOT NULL,revoked INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS protected_signed_policies (digest TEXT PRIMARY KEY,key_id TEXT NOT NULL,signature TEXT NOT NULL,issued_at INTEGER NOT NULL,expires_at INTEGER NOT NULL) STRICT;`);
    try {this.transaction(()=>{
      this.safeNow();
      const prior=this.db.prepare('SELECT version,sha256 FROM protected_trust_state WHERE singleton=1').get() as {version:number;sha256:string}|undefined;
      if(prior&&(snapshot.version<prior.version||(snapshot.version===prior.version&&snapshot.sha256!==prior.sha256)))throw new Error('policy trust configuration rollback or version conflict');
      this.db.prepare('UPDATE protected_policy_signers SET revoked=1').run();
      const upsert=this.db.prepare('INSERT INTO protected_policy_signers VALUES (?,?,?) ON CONFLICT(key_id) DO UPDATE SET pem=excluded.pem,revoked=excluded.revoked');
      for(const signer of snapshot.signers)upsert.run(signer.keyId,signer.pem,signer.revoked?1:0);
      this.db.prepare('INSERT INTO protected_trust_state VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET version=excluded.version,sha256=excluded.sha256').run(snapshot.version,snapshot.sha256);
    });}catch(error){this.close();throw error;}
  }
  private verifiedPolicy(bytes:Uint8Array,signature:string,keyId:string,now:number):{policy:SignedVerificationPolicy;policySha256:string;keyId:string}{
    if(readPolicyTrust(this.trustFile,this.trustUid).sha256!==this.trustDigest)throw new Error('policy trust configuration changed; reload required');
    const signer=this.db.prepare('SELECT pem,revoked FROM protected_policy_signers WHERE key_id=?').get(keyId) as {pem:string;revoked:number}|undefined;
    if(!signer||signer.revoked!==0)throw new Error('policy signer is not authorized');
    return verifySignedPolicy(bytes,signature,createPublicKey(signer.pem),keyId,false,now);
  }
  protected override authorizePolicy(input:{digest:string;project:string;board:string;operation:string;boardPath:string;workerDigest:string;toolchainDigest:string;archiveDigest:string},now:number):SignedVerificationPolicy|null {
    const row=this.db.prepare('SELECT key_id,signature FROM protected_signed_policies WHERE digest=?').get(input.digest) as {key_id:string;signature:string}|undefined;
    if(!row)return null;
    try {
      const verified=this.verifiedPolicy(this.read(input.digest),row.signature,row.key_id,now),p=verified.policy;
      if(verified.policySha256!==input.digest||p.project_id!==input.project||p.board_id!==input.board||p.operation!==input.operation||p.board_path!==input.boardPath||
          p.worker_image_sha256!==input.workerDigest||p.toolchain_sha256!==input.toolchainDigest||p.archive_tool_sha256!==input.archiveDigest)return null;
      return p;
    } catch {return null;}
  }
  /** Internal verifier collector only; checks the live trust file and current signer before returning policy material. */
  policyMaterialFromTrustedService(digest:string):{bytes:Buffer;signature:string;keyId:string;key:KeyObject;policy:SignedVerificationPolicy;nowMs:number} {
    return this.transaction(()=>{
      const nowMs=this.safeNow(),row=this.db.prepare('SELECT key_id,signature FROM protected_signed_policies WHERE digest=?').get(digest) as {key_id:string;signature:string}|undefined;
      if(!row)throw new Error('signed policy unavailable');
      const bytes=this.read(digest),verified=this.verifiedPolicy(bytes,row.signature,row.key_id,nowMs),signer=this.db.prepare('SELECT pem,revoked FROM protected_policy_signers WHERE key_id=?').get(row.key_id) as {pem:string;revoked:number}|undefined;
      if(verified.policySha256!==digest||!signer||signer.revoked!==0)throw new Error('signed policy unavailable');
      return {bytes,signature:row.signature,keyId:row.key_id,key:createPublicKey(signer.pem),policy:verified.policy,nowMs};
    });
  }
  /** Internal local-admin path only. Persisted policy is not a target activation or a verifier receipt. */
  registerSignedPolicyFromTrustedService(bytes:Uint8Array,signature:string,keyId:string):string {
    const verified=this.transaction(()=>this.verifiedPolicy(bytes,signature,keyId,this.safeNow()));
    this.put(verified.policySha256,bytes);
    return this.transaction(()=>{
      const current=this.verifiedPolicy(bytes,signature,keyId,this.safeNow());
      if(current.policySha256!==verified.policySha256||!this.blobReady(current.policySha256))throw new Error('signed policy changed');
      const prior=this.db.prepare('SELECT key_id,signature FROM protected_signed_policies WHERE digest=?').get(current.policySha256) as {key_id:string;signature:string}|undefined;
      if(prior&&(prior.key_id!==keyId||prior.signature!==signature))throw new Error('signed policy already has different signer');
      if(!prior){
        this.db.prepare('INSERT INTO protected_signed_policies VALUES (?,?,?,?,?)').run(current.policySha256,keyId,signature,current.policy.issued_at_ms,current.policy.expires_at_ms);
        this.db.prepare('INSERT INTO protected_policies (digest,required_checks,parity_na,enabled) VALUES (?,?,?,1)').run(current.policySha256,JSON.stringify(current.policy.required_checks),current.policy.parity_not_applicable_allowed?1:0);
        this.pinBlobs('policy',current.policySha256,[current.policySha256]);
      }
      return current.policySha256;
    });
  }
}
