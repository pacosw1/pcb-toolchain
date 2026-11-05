// Internal verifier-job authority. No network API, trust bootstrap or verifier receipt is exposed here.
import { ProtectedTrustStore } from './protected-trust-store.ts';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, SHA=/^[0-9a-f]{64}$/;
export type VerifierRef={project:string;board:string;operation:string;job:string;attempt:string;verification:string};
export type VerifierInputIdentity={sha256:string;size:number;specSha256:string;sourceManifest:string;candidateManifest:string;policySha256:string;verifierImage:string;archiveToolSha256:string};
type Attempt={project:string;board:string;operation:string;generation:number;source_revision:number;alias_revision:number;source_manifest:string;policy_digest:string;runtime_digest:string;toolchain_digest:string};
type Target={state:string;revision:number;alias_revision:number;source_manifest:string;board_path:string};
type Lease={boot_id:string|null;pinned:number;generation:number;expires_at:number;source_manifest:string;operation:string};
type Runtime={attested_image:string|null;archive_tool_digest:string|null};
type Intent={input_sha256:string;input_size:number;spec_sha256:string;source_manifest:string;candidate_manifest:string;policy_digest:string;verifier_image:string;archive_tool_digest:string;state:string};
const valid=(r:VerifierRef):boolean=>!!r&&[r.project,r.board,r.operation,r.job,r.attempt,r.verification].every(x=>typeof x==='string'&&ID.test(x));
export class ProtectedVerifierAuthority extends ProtectedTrustStore {
  constructor(...args:ConstructorParameters<typeof ProtectedTrustStore>){
    super(...args);
    this.db.exec(`CREATE TABLE IF NOT EXISTS protected_verifier_intents (job TEXT NOT NULL,attempt TEXT NOT NULL,verification TEXT NOT NULL,
      input_sha256 TEXT NOT NULL,input_size INTEGER NOT NULL,spec_sha256 TEXT NOT NULL,source_manifest TEXT NOT NULL,candidate_manifest TEXT NOT NULL,
      policy_digest TEXT NOT NULL,verifier_image TEXT NOT NULL,archive_tool_digest TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(job,attempt,verification),UNIQUE(job,attempt)) STRICT;
      CREATE TABLE IF NOT EXISTS protected_verifier_jobs (job TEXT NOT NULL,attempt TEXT NOT NULL,verification TEXT NOT NULL,runtime_job TEXT NOT NULL UNIQUE,attested_image TEXT,
      PRIMARY KEY(job,attempt,verification)) STRICT;
      CREATE TABLE IF NOT EXISTS protected_verifier_cleanup (job TEXT NOT NULL,attempt TEXT NOT NULL,verification TEXT NOT NULL,runtime_job TEXT NOT NULL,
      attested_image TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(job,attempt,verification)) STRICT;`);
  }
  /** Called only inside the authority transaction. */
  private base(ref:VerifierRef,now:number):{attempt:Attempt;target:Target;candidate:string;image:string;archive:string}|null {
    const attempt=this.db.prepare('SELECT * FROM protected_attempt_bindings WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as Attempt|undefined;
    const target=this.db.prepare('SELECT revision,alias_revision,state,source_manifest,board_path FROM protected_targets WHERE project=? AND board=?').get(ref.project,ref.board) as Target|undefined;
    const lease=this.db.prepare('SELECT * FROM protected_leases WHERE project=? AND board=?').get(ref.project,ref.board) as Lease|undefined;
    const cancel=this.db.prepare('SELECT cancelled FROM protected_attempt_cancellation WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as {cancelled:number}|undefined;
    const candidate=this.db.prepare('SELECT manifest,state FROM protected_candidates WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as {manifest:string;state:string}|undefined;
    const runtime=this.db.prepare('SELECT attested_image,archive_tool_digest FROM protected_runtime_jobs WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as Runtime|undefined;
    const current=this.db.prepare('SELECT policy_digest,runtime_digest,toolchain_digest FROM protected_target_policy WHERE project=? AND board=?').get(ref.project,ref.board) as {policy_digest:string;runtime_digest:string;toolchain_digest:string}|undefined;
    if(!attempt||attempt.project!==ref.project||attempt.board!==ref.board||attempt.operation!==ref.operation||!target||target.state!=='ACTIVE'||!target.board_path||target.revision!==attempt.source_revision||
      target.alias_revision!==attempt.alias_revision||target.source_manifest!==attempt.source_manifest||!lease||lease.boot_id!==this.bootId||lease.pinned!==1||lease.expires_at<=now||lease.generation!==attempt.generation||
      lease.source_manifest!==attempt.source_manifest||lease.operation!==ref.operation||!cancel||cancel.cancelled!==0||!candidate||candidate.state!=='STAGED'||!runtime||
      runtime.attested_image!==`sha256:${attempt.runtime_digest}`||!runtime.archive_tool_digest||!current||current.policy_digest!==attempt.policy_digest||current.runtime_digest!==attempt.runtime_digest||current.toolchain_digest!==attempt.toolchain_digest)return null;
    const policy=this.authorizePolicy({digest:attempt.policy_digest,project:ref.project,board:ref.board,operation:ref.operation,boardPath:target.board_path,
      workerDigest:attempt.runtime_digest,toolchainDigest:attempt.toolchain_digest,archiveDigest:runtime.archive_tool_digest},now);
    const approved=this.db.prepare('SELECT enabled FROM protected_approved_digests WHERE kind=? AND digest=?');
    const policyState=this.db.prepare('SELECT enabled FROM protected_policies WHERE digest=?').get(attempt.policy_digest) as {enabled:number}|undefined;
    if(!policy||policyState?.enabled!==1||(approved.get('runtime',attempt.runtime_digest) as {enabled:number}|undefined)?.enabled!==1||(approved.get('verifier-runtime',policy.verifier_image_sha256) as {enabled:number}|undefined)?.enabled!==1||
      (approved.get('toolchain',attempt.toolchain_digest) as {enabled:number}|undefined)?.enabled!==1||(approved.get('archive-tool',runtime.archive_tool_digest) as {enabled:number}|undefined)?.enabled!==1)return null;
    return {attempt,target,candidate:candidate.manifest,image:`sha256:${policy.verifier_image_sha256}`,archive:runtime.archive_tool_digest};
  }
  /** The caller must first obtain input via prepareVerifierInput after worker cleanup. */
  reserveVerifierFromTrustedService(ref:VerifierRef,input:VerifierInputIdentity):void {
    if(!valid(ref)||!input||![input.sha256,input.specSha256,input.sourceManifest,input.candidateManifest,input.policySha256,input.archiveToolSha256].every(x=>typeof x==='string'&&SHA.test(x))||
      !Number.isSafeInteger(input.size)||input.size<1||!/^sha256:[0-9a-f]{64}$/.test(input.verifierImage))throw new Error('invalid verifier intent');
    this.transaction(()=>{
      const now=this.safeNow(),base=this.base(ref,now);
      const cleanup=this.db.prepare('SELECT * FROM protected_worker_cleanup WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as {generation:number;source_manifest:string;candidate_manifest:string;policy_digest:string;state:string}|undefined;
      if(!base||!cleanup||cleanup.state!=='CLEANED'||cleanup.generation!==base.attempt.generation||cleanup.source_manifest!==input.sourceManifest||cleanup.candidate_manifest!==input.candidateManifest||cleanup.policy_digest!==input.policySha256||
        base.attempt.source_manifest!==input.sourceManifest||base.candidate!==input.candidateManifest||base.attempt.policy_digest!==input.policySha256||base.image!==input.verifierImage||base.archive!==input.archiveToolSha256)
        throw new Error('verifier intent is stale');
      const old=this.db.prepare('SELECT * FROM protected_verifier_intents WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as (Intent&{verification:string})|undefined;
      if(old){if(old.verification!==ref.verification||old.input_sha256!==input.sha256||old.input_size!==input.size||old.spec_sha256!==input.specSha256||old.source_manifest!==input.sourceManifest||old.candidate_manifest!==input.candidateManifest||old.policy_digest!==input.policySha256||old.verifier_image!==input.verifierImage||old.archive_tool_digest!==input.archiveToolSha256||!['PREPARED','ATTACHED'].includes(old.state))throw new Error('verifier intent changed');return;}
      this.db.prepare("INSERT INTO protected_verifier_intents VALUES (?,?,?,?,?,?,?,?,?,?,?,'PREPARED')").run(ref.job,ref.attempt,ref.verification,input.sha256,input.size,input.specSha256,input.sourceManifest,input.candidateManifest,input.policySha256,input.verifierImage,input.archiveToolSha256);
    });
  }
  associateVerifierFromTrustedService(ref:VerifierRef,runtimeJob:string):void {
    if(!valid(ref)||!ID.test(runtimeJob))throw new Error('invalid verifier association');
    this.transaction(()=>{
      const now=this.safeNow(),base=this.base(ref,now),intent=this.db.prepare('SELECT * FROM protected_verifier_intents WHERE job=? AND attempt=? AND verification=?').get(ref.job,ref.attempt,ref.verification) as Intent|undefined;
      if(!base||!intent||!['PREPARED','ATTACHED'].includes(intent.state)||intent.source_manifest!==base.attempt.source_manifest||intent.candidate_manifest!==base.candidate||intent.policy_digest!==base.attempt.policy_digest||intent.verifier_image!==base.image||intent.archive_tool_digest!==base.archive)throw new Error('verifier association is stale');
      const old=this.db.prepare('SELECT runtime_job FROM protected_verifier_jobs WHERE job=? AND attempt=? AND verification=?').get(ref.job,ref.attempt,ref.verification) as {runtime_job:string}|undefined;
      if(old){if(old.runtime_job!==runtimeJob)throw new Error('verifier runtime changed');return;}
      this.db.prepare('INSERT INTO protected_verifier_jobs VALUES (?,?,?,?,NULL)').run(ref.job,ref.attempt,ref.verification,runtimeJob);
      this.db.prepare("UPDATE protected_verifier_intents SET state='ATTACHED' WHERE job=? AND attempt=? AND verification=?").run(ref.job,ref.attempt,ref.verification);
    });
  }
  verifierSubmissionFromTrustedService(ref:VerifierRef): (VerifierInputIdentity & {state:string;runtimeJob:string|null})|null {
    if(!valid(ref))throw new Error('invalid verifier reference');
    return this.transaction(()=>{
      this.safeNow();
      const attempt=this.db.prepare('SELECT project,board,operation FROM protected_attempt_bindings WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as {project:string;board:string;operation:string}|undefined;
      if(!attempt||attempt.project!==ref.project||attempt.board!==ref.board||attempt.operation!==ref.operation)throw new Error('protected attempt unavailable');
      const row=this.db.prepare(`SELECT i.*,j.runtime_job FROM protected_verifier_intents i LEFT JOIN protected_verifier_jobs j
        ON j.job=i.job AND j.attempt=i.attempt AND j.verification=i.verification WHERE i.job=? AND i.attempt=? AND i.verification=?`).get(ref.job,ref.attempt,ref.verification) as (Intent&{runtime_job:string|null})|undefined;
      return row?{sha256:row.input_sha256,size:row.input_size,specSha256:row.spec_sha256,sourceManifest:row.source_manifest,candidateManifest:row.candidate_manifest,policySha256:row.policy_digest,verifierImage:row.verifier_image,archiveToolSha256:row.archive_tool_digest,state:row.state,runtimeJob:row.runtime_job}:null;
    });
  }
  verifierIdentityFromTrustedService(ref:VerifierRef,runtimeJob:string):VerifierInputIdentity|null {
    if(!valid(ref)||!ID.test(runtimeJob))return null;
    return this.transaction(()=>{
      this.safeNow();const row=this.db.prepare(`SELECT i.* FROM protected_verifier_intents i JOIN protected_verifier_jobs j ON j.job=i.job AND j.attempt=i.attempt AND j.verification=i.verification
        WHERE i.job=? AND i.attempt=? AND i.verification=? AND j.runtime_job=? AND i.state='ATTACHED'`).get(ref.job,ref.attempt,ref.verification,runtimeJob) as Intent|undefined;
      return row?{sha256:row.input_sha256,size:row.input_size,specSha256:row.spec_sha256,sourceManifest:row.source_manifest,candidateManifest:row.candidate_manifest,policySha256:row.policy_digest,verifierImage:row.verifier_image,archiveToolSha256:row.archive_tool_digest}:null;
    });
  }
  canRunVerifier(ref:VerifierRef,runtimeJob:string,continuing=false):boolean {
    if(!valid(ref)||!ID.test(runtimeJob))return false;
    return this.transaction(()=>this.verifierAllowed(ref,runtimeJob,continuing));
  }
  pendingVerifierCancellations():string[] {
    return this.transaction(()=>{this.safeNow();return (this.db.prepare(`SELECT v.runtime_job FROM protected_verifier_jobs v
      JOIN protected_attempt_cancellation c ON c.job=v.job AND c.attempt=v.attempt WHERE c.cancelled=1 ORDER BY v.runtime_job`).all() as {runtime_job:string}[]).map(row=>row.runtime_job);});
  }
  private verifierAllowed(ref:VerifierRef,runtimeJob:string,continuing:boolean):boolean {
    const now=this.safeNow(),base=this.base(ref,now),intent=this.db.prepare('SELECT * FROM protected_verifier_intents WHERE job=? AND attempt=? AND verification=?').get(ref.job,ref.attempt,ref.verification) as Intent|undefined;
    const job=this.db.prepare('SELECT runtime_job,attested_image FROM protected_verifier_jobs WHERE job=? AND attempt=? AND verification=?').get(ref.job,ref.attempt,ref.verification) as {runtime_job:string;attested_image:string|null}|undefined;
    const cleanup=this.db.prepare('SELECT generation,source_manifest,candidate_manifest,policy_digest,state FROM protected_worker_cleanup WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as {generation:number;source_manifest:string;candidate_manifest:string;policy_digest:string;state:string}|undefined;
    return !!base&&!!cleanup&&cleanup.state==='CLEANED'&&cleanup.generation===base.attempt.generation&&cleanup.source_manifest===base.attempt.source_manifest&&cleanup.candidate_manifest===base.candidate&&cleanup.policy_digest===base.attempt.policy_digest&&!!intent&&intent.state==='ATTACHED'&&intent.source_manifest===base.attempt.source_manifest&&intent.candidate_manifest===base.candidate&&intent.policy_digest===base.attempt.policy_digest&&
      intent.verifier_image===base.image&&intent.archive_tool_digest===base.archive&&!!job&&job.runtime_job===runtimeJob&&(!continuing||job.attested_image===base.image);
  }
  recordVerifierAttestationFromTrustedService(ref:VerifierRef,runtimeJob:string,image:string):boolean {
    if(!valid(ref)||!ID.test(runtimeJob)||!/^sha256:[0-9a-f]{64}$/.test(image))return false;
    return this.transaction(()=>{
      if(!this.verifierAllowed(ref,runtimeJob,false))return false;
      const intent=this.db.prepare('SELECT verifier_image FROM protected_verifier_intents WHERE job=? AND attempt=? AND verification=?').get(ref.job,ref.attempt,ref.verification) as {verifier_image:string}|undefined;
      if(!intent||image!==intent.verifier_image)return false;
      return this.db.prepare('UPDATE protected_verifier_jobs SET attested_image=? WHERE job=? AND attempt=? AND verification=? AND runtime_job=?').run(image,ref.job,ref.attempt,ref.verification,runtimeJob).changes===1;
    });
  }
  /** Internal collector only, after trusted manager cleanup and a fresh missing-container inspection. */
  recordVerifierCleanupFromTrustedService(ref:VerifierRef,runtimeJob:string):void {
    if(!valid(ref)||!ID.test(runtimeJob))throw new Error('invalid verifier cleanup');
    this.transaction(()=>{
      if(!this.verifierAllowed(ref,runtimeJob,true))throw new Error('verifier cleanup is stale');
      const job=this.db.prepare('SELECT attested_image FROM protected_verifier_jobs WHERE job=? AND attempt=? AND verification=? AND runtime_job=?').get(ref.job,ref.attempt,ref.verification,runtimeJob) as {attested_image:string}|undefined;
      if(!job||!/^sha256:[0-9a-f]{64}$/.test(job.attested_image))throw new Error('verifier image is unattested');
      const prior=this.db.prepare('SELECT runtime_job,attested_image,state FROM protected_verifier_cleanup WHERE job=? AND attempt=? AND verification=?').get(ref.job,ref.attempt,ref.verification) as {runtime_job:string;attested_image:string;state:string}|undefined;
      if(prior){if(prior.runtime_job!==runtimeJob||prior.attested_image!==job.attested_image||prior.state!=='CLEANED')throw new Error('verifier cleanup changed');return;}
      this.db.prepare("INSERT INTO protected_verifier_cleanup VALUES (?,?,?,?,?,'CLEANED')").run(ref.job,ref.attempt,ref.verification,runtimeJob,job.attested_image);
    });
  }
  protected override verifierRecordTrusted(ref:VerifierRef,imageDigest:string):boolean {
    const row=this.db.prepare(`SELECT j.runtime_job,j.attested_image,c.state,c.attested_image AS cleanup_image FROM protected_verifier_jobs j
      JOIN protected_verifier_cleanup c ON c.job=j.job AND c.attempt=j.attempt AND c.verification=j.verification AND c.runtime_job=j.runtime_job
      WHERE j.job=? AND j.attempt=? AND j.verification=?`).get(ref.job,ref.attempt,ref.verification) as {runtime_job:string;attested_image:string|null;state:string;cleanup_image:string}|undefined;
    return !!row&&row.state==='CLEANED'&&row.attested_image===`sha256:${imageDigest}`&&row.cleanup_image===row.attested_image&&this.verifierAllowed(ref,row.runtime_job,true);
  }
}
