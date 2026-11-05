// Internal, unwired transaction. No API may expose this until trusted policy/target activation, verifier issuance,
// cancellation/cleanup, filesystem isolation and fail-closed clock/recovery are implemented and authenticated.
import { timingSafeEqual } from 'node:crypto';
import { parseCanonicalJson } from './canonical-json.ts';
import { resolveManifestClosure } from './protected-closure.ts';
import { ProtectedLeaseStore, protectedLeaseHash } from './protected-leases.ts';
import { parseTrustedVerification } from './protected-verification.ts';
import { assertBoardOnlyChange } from './protected-manifest.ts';
import type { SignedVerificationPolicy } from './protected-policy.ts';
import type { ManifestClosure } from './protected-closure.ts';
import type { CommitRequestV1, CommitResultV1 } from '../../../contracts/pcb-system-v1.ts';

const SHA = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
type Target = { revision: number; alias_revision: number; state: string; source_manifest: string; board_path: string };
type Lease = { generation: number; token_hash: Uint8Array; expires_at: number; pinned: number; source_revision: number; alias_revision: number; source_manifest: string; operation: string; boot_id: string | null };
type Attempt = { project: string; board: string; generation: number; source_revision: number; alias_revision: number; operation: string; source_manifest: string; policy_digest: string; runtime_digest: string; toolchain_digest: string };
type Verified = { candidate_manifest: string; evidence_manifest: string; verifier: string; verifier_image_digest:string|null; receipt: Uint8Array; state: string; cancelled: number; revoked: number };

export class ProtectedCommitStore extends ProtectedLeaseStore {
  constructor(root: string, limits: { maxBlobBytes: number; quotaBytes: number }, now: () => number = Date.now, monotonic: () => bigint = process.hrtime.bigint) {
    super(root, limits, now, monotonic);
    this.db.exec(`CREATE TABLE IF NOT EXISTS protected_target_policy (project TEXT NOT NULL, board TEXT NOT NULL, policy_digest TEXT NOT NULL, runtime_digest TEXT NOT NULL, toolchain_digest TEXT NOT NULL, PRIMARY KEY(project,board)) STRICT;
      CREATE TABLE IF NOT EXISTS protected_policies (digest TEXT PRIMARY KEY, required_checks TEXT NOT NULL, parity_na INTEGER NOT NULL, enabled INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS protected_approved_digests (kind TEXT NOT NULL, digest TEXT NOT NULL, enabled INTEGER NOT NULL, PRIMARY KEY(kind,digest)) STRICT;
      CREATE TABLE IF NOT EXISTS protected_verifiers (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS protected_verified_attempts (job TEXT NOT NULL, attempt TEXT NOT NULL, verification TEXT NOT NULL,
        candidate_manifest TEXT NOT NULL, evidence_manifest TEXT NOT NULL, verifier TEXT NOT NULL, receipt BLOB NOT NULL,
        state TEXT NOT NULL, cancelled INTEGER NOT NULL, revoked INTEGER NOT NULL, verifier_image_digest TEXT, PRIMARY KEY(job,attempt,verification)) STRICT;
      CREATE TABLE IF NOT EXISTS protected_candidates (job TEXT NOT NULL, attempt TEXT NOT NULL, manifest TEXT NOT NULL, state TEXT NOT NULL,
        PRIMARY KEY(job,attempt)) STRICT;
      CREATE TABLE IF NOT EXISTS protected_runtime_jobs (job TEXT NOT NULL, attempt TEXT NOT NULL, runtime_job TEXT NOT NULL UNIQUE, input_sha256 TEXT, input_size INTEGER, spec_sha256 TEXT, attested_image TEXT, archive_tool_digest TEXT,
        PRIMARY KEY(job,attempt)) STRICT;
      CREATE TABLE IF NOT EXISTS protected_submission_intents (job TEXT NOT NULL, attempt TEXT NOT NULL, input_sha256 TEXT NOT NULL, input_size INTEGER NOT NULL,
        spec_sha256 TEXT NOT NULL, archive_tool_digest TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(job,attempt)) STRICT;
      CREATE TABLE IF NOT EXISTS protected_revisions (project TEXT NOT NULL, board TEXT NOT NULL, revision INTEGER NOT NULL,
        manifest TEXT NOT NULL, verification TEXT NOT NULL, PRIMARY KEY(project,board,revision)) STRICT;
      CREATE TABLE IF NOT EXISTS protected_commit_results (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, revision INTEGER NOT NULL, manifest TEXT NOT NULL) STRICT;`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS protected_recoveries (job TEXT NOT NULL, attempt TEXT NOT NULL, generation INTEGER NOT NULL,
      runtime_job TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(job,attempt)) STRICT;`);
    const runtimeColumns = this.db.prepare('PRAGMA table_info(protected_runtime_jobs)').all() as {name:string}[];
    if (!runtimeColumns.some(column => column.name === 'input_sha256')) this.db.exec('ALTER TABLE protected_runtime_jobs ADD COLUMN input_sha256 TEXT');
    if (!runtimeColumns.some(column => column.name === 'input_size')) this.db.exec('ALTER TABLE protected_runtime_jobs ADD COLUMN input_size INTEGER');
    if (!runtimeColumns.some(column => column.name === 'spec_sha256')) this.db.exec('ALTER TABLE protected_runtime_jobs ADD COLUMN spec_sha256 TEXT');
    if (!runtimeColumns.some(column => column.name === 'attested_image')) this.db.exec('ALTER TABLE protected_runtime_jobs ADD COLUMN attested_image TEXT');
    if (!runtimeColumns.some(column => column.name === 'archive_tool_digest')) this.db.exec('ALTER TABLE protected_runtime_jobs ADD COLUMN archive_tool_digest TEXT');
    const verificationColumns = this.db.prepare('PRAGMA table_info(protected_verified_attempts)').all() as {name:string}[];
    if (!verificationColumns.some(column => column.name === 'verifier_image_digest')) this.db.exec('ALTER TABLE protected_verified_attempts ADD COLUMN verifier_image_digest TEXT');
  }
  /** The base store has no trust root and therefore cannot authorize protected execution or commit. */
  protected authorizePolicy(_input:{digest:string;project:string;board:string;operation:string;boardPath:string;workerDigest:string;toolchainDigest:string;archiveDigest:string},_now:number): SignedVerificationPolicy|null { return null; }
  /** Persist the exact prepared archive and command before creating any runtime job. */
  reserveSubmissionFromTrustedService(ref: {project:string;board:string;operation:string;job:string;attempt:string}, input: {sha256:string;size:number;specSha256:string;archiveToolSha256:string}): void {
    if (!ref || ![ref.project,ref.board,ref.operation,ref.job,ref.attempt].every(x => typeof x === 'string' && ID.test(x)) || !input ||
        ![input.sha256,input.specSha256,input.archiveToolSha256].every(x => typeof x === 'string' && SHA.test(x)) || !Number.isSafeInteger(input.size) || input.size < 1)
      throw new Error('invalid protected submission intent');
    this.transaction(() => {
      const now = this.clock();
      const attempt = this.db.prepare('SELECT * FROM protected_attempt_bindings WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as Attempt | undefined;
      const lease = this.db.prepare('SELECT * FROM protected_leases WHERE project=? AND board=?').get(ref.project,ref.board) as Lease | undefined;
      const target = this.db.prepare('SELECT revision,alias_revision,state,source_manifest FROM protected_targets WHERE project=? AND board=?').get(ref.project,ref.board) as Target | undefined;
      const cancel = this.db.prepare('SELECT cancelled FROM protected_attempt_cancellation WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as {cancelled:number} | undefined;
      const tool = this.db.prepare("SELECT enabled FROM protected_approved_digests WHERE kind='archive-tool' AND digest=?").get(input.archiveToolSha256) as {enabled:number} | undefined;
      if (!attempt || attempt.project !== ref.project || attempt.board !== ref.board || attempt.operation !== ref.operation ||
          !target || target.state !== 'ACTIVE' || target.revision !== attempt.source_revision || target.alias_revision !== attempt.alias_revision || target.source_manifest !== attempt.source_manifest ||
          !lease || lease.boot_id !== this.bootId || lease.pinned !== 1 || lease.expires_at <= now || lease.generation !== attempt.generation || lease.source_manifest !== attempt.source_manifest ||
          !cancel || cancel.cancelled !== 0 || tool?.enabled !== 1) throw new Error('protected submission intent is stale');
      const prior = this.db.prepare('SELECT * FROM protected_submission_intents WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as {input_sha256:string;input_size:number;spec_sha256:string;archive_tool_digest:string;state:string} | undefined;
      if (prior) { if (prior.input_sha256 !== input.sha256 || prior.input_size !== input.size || prior.spec_sha256 !== input.specSha256 || prior.archive_tool_digest !== input.archiveToolSha256 || !['PREPARED','ATTACHED'].includes(prior.state)) throw new Error('protected submission intent changed'); return; }
      this.db.prepare("INSERT INTO protected_submission_intents VALUES (?,?,?,?,?,?,'PREPARED')").run(ref.job,ref.attempt,input.sha256,input.size,input.specSha256,input.archiveToolSha256);
    });
  }
  submissionFromTrustedService(ref: {project:string;board:string;operation:string;job:string;attempt:string}):
    {sha256:string;size:number;specSha256:string;archiveToolSha256:string;state:string;runtimeJob:string|null} | null {
    return this.transaction(() => {
      this.safeNow();
      const attempt = this.db.prepare('SELECT project,board,operation FROM protected_attempt_bindings WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as {project:string;board:string;operation:string} | undefined;
      if (!attempt || attempt.project !== ref.project || attempt.board !== ref.board || attempt.operation !== ref.operation) throw new Error('protected attempt unavailable');
      const row = this.db.prepare(`SELECT i.input_sha256,i.input_size,i.spec_sha256,i.archive_tool_digest,i.state,r.runtime_job
        FROM protected_submission_intents i LEFT JOIN protected_runtime_jobs r ON r.job=i.job AND r.attempt=i.attempt WHERE i.job=? AND i.attempt=?`).get(ref.job,ref.attempt) as
        {input_sha256:string;input_size:number;spec_sha256:string;archive_tool_digest:string;state:string;runtime_job:string|null} | undefined;
      return row ? {sha256:row.input_sha256,size:row.input_size,specSha256:row.spec_sha256,archiveToolSha256:row.archive_tool_digest,state:row.state,runtimeJob:row.runtime_job} : null;
    });
  }
  /** Internal recovery only: associate an unstarted manager record with its prepared intent while cancelling it. */
  associateOrphanForRecoveryFromTrustedService(ref: {project:string;board:string;operation:string;job:string;attempt:string}, runtimeJob:string): void {
    if (!ref || ![ref.project,ref.board,ref.operation,ref.job,ref.attempt,runtimeJob].every(x => typeof x === 'string' && ID.test(x))) throw new Error('invalid orphan recovery');
    this.transaction(() => {
      this.safeNow();
      const attempt = this.db.prepare('SELECT * FROM protected_attempt_bindings WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as Attempt | undefined;
      const lease = this.db.prepare('SELECT * FROM protected_leases WHERE project=? AND board=?').get(ref.project,ref.board) as Lease | undefined;
      const intent = this.db.prepare('SELECT * FROM protected_submission_intents WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as {input_sha256:string;input_size:number;spec_sha256:string;archive_tool_digest:string;state:string} | undefined;
      const existing = this.db.prepare('SELECT runtime_job FROM protected_runtime_jobs WHERE job=? AND attempt=?').get(ref.job,ref.attempt);
      if (!attempt || attempt.project !== ref.project || attempt.board !== ref.board || attempt.operation !== ref.operation ||
          !lease || lease.generation !== attempt.generation || lease.pinned !== 1 || !intent || intent.state !== 'PREPARED' || existing)
        throw new Error('protected orphan recovery is unavailable');
      if (this.db.prepare('UPDATE protected_attempt_cancellation SET cancelled=1 WHERE job=? AND attempt=?').run(ref.job,ref.attempt).changes !== 1)
        throw new Error('protected cancellation state unavailable');
      this.db.prepare('INSERT INTO protected_runtime_jobs (job,attempt,runtime_job,input_sha256,input_size,spec_sha256,archive_tool_digest) VALUES (?,?,?,?,?,?,?)')
        .run(ref.job,ref.attempt,runtimeJob,intent.input_sha256,intent.input_size,intent.spec_sha256,intent.archive_tool_digest);
      this.db.prepare("UPDATE protected_submission_intents SET state='ATTACHED' WHERE job=? AND attempt=?").run(ref.job,ref.attempt);
    });
  }
  /** Internal only; approval entries themselves require an authenticated trust bootstrap. */
  approvedArtifactFromTrustedService(kind: 'archive-tool', digest: string): boolean {
    if (!SHA.test(digest)) return false;
    return this.transaction(() => {
      this.safeNow();
      return (this.db.prepare('SELECT enabled FROM protected_approved_digests WHERE kind=? AND digest=?').get(kind,digest) as {enabled:number} | undefined)?.enabled === 1;
    });
  }
  /** Internal recovery orchestrator only. Cancellation becomes durable before any runtime operation. */
  beginAbandonFromTrustedService(ref: {project:string;board:string;operation:string;job:string;attempt:string}): {runtimeJob:string;generation:number} {
    if (!ref || ![ref.project,ref.board,ref.operation,ref.job,ref.attempt].every(x => typeof x === 'string' && ID.test(x))) throw new Error('invalid recovery attempt');
    return this.transaction(() => {
      this.safeNow();
      const attempt = this.db.prepare('SELECT * FROM protected_attempt_bindings WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as Attempt | undefined;
      const lease = this.db.prepare('SELECT * FROM protected_leases WHERE project=? AND board=?').get(ref.project,ref.board) as Lease | undefined;
      const runtime = this.db.prepare('SELECT runtime_job FROM protected_runtime_jobs WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as {runtime_job:string} | undefined;
      const candidate = this.db.prepare('SELECT state FROM protected_candidates WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as {state:string} | undefined;
      if (!attempt || attempt.project !== ref.project || attempt.board !== ref.board || attempt.operation !== ref.operation || !runtime || !lease ||
          lease.generation !== attempt.generation || lease.pinned !== 1 || candidate?.state === 'COMMITTED') throw new Error('protected recovery is unavailable');
      const recovery = this.db.prepare('SELECT generation,runtime_job,state FROM protected_recoveries WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as {generation:number;runtime_job:string;state:string} | undefined;
      if (recovery && (recovery.generation !== attempt.generation || recovery.runtime_job !== runtime.runtime_job || recovery.state !== 'PENDING')) throw new Error('protected recovery changed');
      if (this.db.prepare('UPDATE protected_attempt_cancellation SET cancelled=1 WHERE job=? AND attempt=?').run(ref.job,ref.attempt).changes !== 1)
        throw new Error('protected cancellation state unavailable');
      if (!recovery) this.db.prepare("INSERT INTO protected_recoveries VALUES (?,?,?,?,'PENDING')").run(ref.job,ref.attempt,attempt.generation,runtime.runtime_job);
      return {runtimeJob:runtime.runtime_job,generation:attempt.generation};
    });
  }
  recoveryStatusFromTrustedService(ref: {project:string;board:string;operation:string;job:string;attempt:string}): 'PENDING' | 'CLEANED' | null {
    return this.transaction(() => {
      this.safeNow();
      const row = this.db.prepare(`SELECT a.project,a.board,a.operation,r.state FROM protected_recoveries r
        JOIN protected_attempt_bindings a ON a.job=r.job AND a.attempt=r.attempt WHERE r.job=? AND r.attempt=?`).get(ref.job,ref.attempt) as
        {project:string;board:string;operation:string;state:string} | undefined;
      if (!row || row.project !== ref.project || row.board !== ref.board || row.operation !== ref.operation) return null;
      return row.state === 'PENDING' || row.state === 'CLEANED' ? row.state : null;
    });
  }
  /** Internal cleanup callback only; never expose this method to clients or accept a client cleanup claim. */
  finishAbandonFromTrustedService(ref: {project:string;board:string;operation:string;job:string;attempt:string}, runtimeJob:string, generation:number): void {
    this.transaction(() => {
      const now = this.safeNow();
      const attempt = this.db.prepare('SELECT * FROM protected_attempt_bindings WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as Attempt | undefined;
      const lease = this.db.prepare('SELECT * FROM protected_leases WHERE project=? AND board=?').get(ref.project,ref.board) as Lease | undefined;
      const recovery = this.db.prepare('SELECT generation,runtime_job,state FROM protected_recoveries WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as {generation:number;runtime_job:string;state:string} | undefined;
      const cancellation = this.db.prepare('SELECT cancelled FROM protected_attempt_cancellation WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as {cancelled:number} | undefined;
      if (!attempt || attempt.project !== ref.project || attempt.board !== ref.board || attempt.operation !== ref.operation || attempt.generation !== generation ||
          !lease || lease.generation !== generation || lease.pinned !== 1 || !recovery || recovery.state !== 'PENDING' || recovery.generation !== generation ||
          recovery.runtime_job !== runtimeJob || cancellation?.cancelled !== 1) throw new Error('protected recovery changed');
      this.db.prepare("UPDATE protected_candidates SET state='ABANDONED' WHERE job=? AND attempt=? AND state='STAGED'").run(ref.job,ref.attempt);
      this.db.prepare("DELETE FROM protected_blob_pins WHERE kind IN ('attempt-source','attempt-candidate') AND owner=?").run(JSON.stringify([ref.job,ref.attempt]));
      this.db.prepare("UPDATE protected_recoveries SET state='CLEANED' WHERE job=? AND attempt=?").run(ref.job,ref.attempt);
      this.db.prepare('UPDATE protected_leases SET pinned=0,expires_at=0,token_hash=?,owner=? WHERE project=? AND board=? AND generation=?').run(Buffer.alloc(32),'',ref.project,ref.board,generation);
      this.db.prepare('INSERT INTO protected_lease_audit VALUES (?,?,?,?,?,?)').run(ref.project,ref.board,generation,'coordinator','abandoned-cleanup',now);
    });
  }
  /** Internal launcher only: snapshot preparation must recheck this binding after producing its archive. */
  sourceForAttemptFromTrustedService(ref: {project:string;board:string;operation:string;job:string;attempt:string}): {manifest:string;runtimeDigest:string;closure:ManifestClosure} {
    if (!ref || ![ref.project,ref.board,ref.operation,ref.job,ref.attempt].every(x => typeof x === 'string' && ID.test(x))) throw new Error('invalid protected attempt');
    return this.transaction(() => {
      const now = this.clock();
      const attempt = this.db.prepare('SELECT * FROM protected_attempt_bindings WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as Attempt | undefined;
      const lease = this.db.prepare('SELECT * FROM protected_leases WHERE project=? AND board=?').get(ref.project,ref.board) as Lease | undefined;
      const target = this.db.prepare('SELECT revision,alias_revision,state,source_manifest,board_path FROM protected_targets WHERE project=? AND board=?').get(ref.project,ref.board) as Target | undefined;
      const cancel = this.db.prepare('SELECT cancelled FROM protected_attempt_cancellation WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as {cancelled:number} | undefined;
      if (!attempt || attempt.project !== ref.project || attempt.board !== ref.board || attempt.operation !== ref.operation || !target || target.state !== 'ACTIVE' ||
          target.revision !== attempt.source_revision || target.alias_revision !== attempt.alias_revision || target.source_manifest !== attempt.source_manifest ||
          !lease || lease.boot_id !== this.bootId || lease.pinned !== 1 || lease.generation !== attempt.generation || lease.expires_at <= now || lease.operation !== ref.operation || lease.source_manifest !== attempt.source_manifest ||
          !cancel || cancel.cancelled !== 0) throw new Error('protected source attempt is stale');
      const blob = this.db.prepare("SELECT size FROM protected_uploads WHERE sha256=? AND state='ready'");
      const closure = resolveManifestClosure(attempt.source_manifest, sha => this.read(sha), sha => (blob.get(sha) as {size:number} | undefined)?.size ?? null,
        {maxDepth:16,maxManifests:256,maxNodes:100_000,maxBytes:64*1024**3,maxManifestBytes:64*1024**2});
      if (!target.board_path || closure.rootProject !== ref.project || !closure.rootManifest.required_paths.includes(target.board_path) ||
          !closure.rootManifest.entries.some(entry => entry.kind === 'file' && entry.path === target.board_path)) throw new Error('protected source board unavailable');
      return {manifest:attempt.source_manifest,runtimeDigest:attempt.runtime_digest,closure};
    });
  }
  /** Trusted verifier preparation only. Worker completion and cleanup must be proven by the manager separately. */
  verificationContextFromTrustedService(ref:{project:string;board:string;operation:string;job:string;attempt:string}):
    {sourceDigest:string;candidateDigest:string;policyDigest:string;runtimeJob:string;policy:SignedVerificationPolicy;source:ManifestClosure;candidate:ManifestClosure} {
    if(!ref||![ref.project,ref.board,ref.operation,ref.job,ref.attempt].every(x=>typeof x==='string'&&ID.test(x)))throw new Error('invalid protected verification attempt');
    return this.transaction(()=>{
      const now=this.clock(),attempt=this.db.prepare('SELECT * FROM protected_attempt_bindings WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as Attempt|undefined;
      const target=this.db.prepare('SELECT revision,alias_revision,state,source_manifest,board_path FROM protected_targets WHERE project=? AND board=?').get(ref.project,ref.board) as Target|undefined;
      const lease=this.db.prepare('SELECT * FROM protected_leases WHERE project=? AND board=?').get(ref.project,ref.board) as Lease|undefined;
      const cancel=this.db.prepare('SELECT cancelled FROM protected_attempt_cancellation WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as {cancelled:number}|undefined;
      const staged=this.db.prepare('SELECT manifest,state FROM protected_candidates WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as {manifest:string;state:string}|undefined;
      const runtime=this.db.prepare('SELECT runtime_job,attested_image,archive_tool_digest FROM protected_runtime_jobs WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as {runtime_job:string;attested_image:string|null;archive_tool_digest:string|null}|undefined;
      if(!attempt||attempt.project!==ref.project||attempt.board!==ref.board||attempt.operation!==ref.operation||!target||target.state!=='ACTIVE'||!target.board_path||
        target.revision!==attempt.source_revision||target.alias_revision!==attempt.alias_revision||target.source_manifest!==attempt.source_manifest||!lease||lease.boot_id!==this.bootId||
        lease.pinned!==1||lease.generation!==attempt.generation||lease.expires_at<=now||lease.operation!==ref.operation||lease.source_manifest!==attempt.source_manifest||
        !cancel||cancel.cancelled!==0||!staged||staged.state!=='STAGED'||!runtime||runtime.attested_image!==`sha256:${attempt.runtime_digest}`||!runtime.archive_tool_digest)
        throw new Error('protected verification attempt is stale');
      const policy=this.authorizePolicy({digest:attempt.policy_digest,project:ref.project,board:ref.board,operation:ref.operation,boardPath:target.board_path,
        workerDigest:attempt.runtime_digest,toolchainDigest:attempt.toolchain_digest,archiveDigest:runtime.archive_tool_digest},now);
      const approved=this.db.prepare('SELECT enabled FROM protected_approved_digests WHERE kind=? AND digest=?');
      if(!policy||(approved.get('runtime',attempt.runtime_digest) as {enabled:number}|undefined)?.enabled!==1||
        (approved.get('toolchain',attempt.toolchain_digest) as {enabled:number}|undefined)?.enabled!==1||
        (approved.get('verifier-runtime',policy.verifier_image_sha256) as {enabled:number}|undefined)?.enabled!==1||
        (approved.get('archive-tool',runtime.archive_tool_digest) as {enabled:number}|undefined)?.enabled!==1)throw new Error('protected verifier policy is unavailable');
      const blob=this.db.prepare("SELECT size FROM protected_uploads WHERE sha256=? AND state='ready'"),resolve=(hash:string)=>resolveManifestClosure(hash,s=>this.read(s),s=>(blob.get(s) as {size:number}|undefined)?.size??null,
        {maxDepth:16,maxManifests:256,maxNodes:100_000,maxBytes:64*1024**3,maxManifestBytes:64*1024**2});
      const source=resolve(attempt.source_manifest),candidate=resolve(staged.manifest);
      if(source.rootProject!==ref.project||candidate.rootProject!==ref.project||!source.rootManifest.required_paths.includes(target.board_path)||!candidate.rootManifest.required_paths.includes(target.board_path))
        throw new Error('protected verifier board is unavailable');
      assertBoardOnlyChange(source.rootManifest,candidate.rootManifest,target.board_path);
      return {sourceDigest:attempt.source_manifest,candidateDigest:staged.manifest,policyDigest:attempt.policy_digest,runtimeJob:runtime.runtime_job,policy,source,candidate};
    });
  }
  /** Internal orchestrator only: persist runtime identity; the future launcher must enforce its admission barrier. */
  associateRuntimeFromTrustedService(ref: { project:string; board:string; operation:string; job:string; attempt:string }, runtimeJob: string, input: {sha256:string;size:number;specSha256:string;archiveToolSha256:string}): void {
    if (!ref || ![ref.project,ref.board,ref.operation,ref.job,ref.attempt,runtimeJob].every(x => typeof x === 'string' && ID.test(x)))
      throw new Error('invalid protected runtime association');
    if (!input || typeof input.sha256 !== 'string' || !SHA.test(input.sha256) || typeof input.specSha256 !== 'string' || !SHA.test(input.specSha256) || typeof input.archiveToolSha256 !== 'string' || !SHA.test(input.archiveToolSha256) || !Number.isSafeInteger(input.size) || input.size < 1) throw new Error('invalid protected input identity');
    this.transaction(() => {
      const now = this.clock();
      const attempt = this.db.prepare('SELECT * FROM protected_attempt_bindings WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as Attempt | undefined;
      const lease = this.db.prepare('SELECT * FROM protected_leases WHERE project=? AND board=?').get(ref.project,ref.board) as Lease | undefined;
      const cancellation = this.db.prepare('SELECT cancelled FROM protected_attempt_cancellation WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as {cancelled:number} | undefined;
      const tool = this.db.prepare("SELECT enabled FROM protected_approved_digests WHERE kind='archive-tool' AND digest=?").get(input.archiveToolSha256) as {enabled:number} | undefined;
      const intent = this.db.prepare('SELECT * FROM protected_submission_intents WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as {input_sha256:string;input_size:number;spec_sha256:string;archive_tool_digest:string;state:string} | undefined;
      if (!attempt || attempt.project !== ref.project || attempt.board !== ref.board || attempt.operation !== ref.operation ||
          !lease || lease.boot_id !== this.bootId || lease.pinned !== 1 || lease.expires_at <= now || lease.generation !== attempt.generation ||
          !cancellation || cancellation.cancelled !== 0 || tool?.enabled !== 1 || !intent || !['PREPARED','ATTACHED'].includes(intent.state) ||
          intent.input_sha256 !== input.sha256 || intent.input_size !== input.size || intent.spec_sha256 !== input.specSha256 || intent.archive_tool_digest !== input.archiveToolSha256) throw new Error('protected runtime association is stale');
      const prior = this.db.prepare('SELECT runtime_job,input_sha256,input_size,spec_sha256,archive_tool_digest FROM protected_runtime_jobs WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as {runtime_job:string;input_sha256:string|null;input_size:number|null;spec_sha256:string|null;archive_tool_digest:string|null} | undefined;
      if (prior) { if (prior.runtime_job !== runtimeJob || prior.input_sha256 !== input.sha256 || prior.input_size !== input.size || prior.spec_sha256 !== input.specSha256 || prior.archive_tool_digest !== input.archiveToolSha256) throw new Error('protected runtime job changed'); return; }
      this.db.prepare('INSERT INTO protected_runtime_jobs (job,attempt,runtime_job,input_sha256,input_size,spec_sha256,archive_tool_digest) VALUES (?,?,?,?,?,?,?)').run(ref.job,ref.attempt,runtimeJob,input.sha256,input.size,input.specSha256,input.archiveToolSha256);
      this.db.prepare("UPDATE protected_submission_intents SET state='ATTACHED' WHERE job=? AND attempt=?").run(ref.job,ref.attempt);
    });
  }
  /** Identity to compare with the manager's private archive before starting the worker. */
  runtimeInputIdentity(ref: {job:string;attempt:string}, runtimeJob: string): {sha256:string;size:number;specSha256:string;image:string} | null {
    return this.transaction(() => {
      this.safeNow();
      const row = this.db.prepare(`SELECT r.input_sha256,r.input_size,r.spec_sha256,a.runtime_digest FROM protected_runtime_jobs r
        JOIN protected_attempt_bindings a ON a.job=r.job AND a.attempt=r.attempt WHERE r.job=? AND r.attempt=? AND r.runtime_job=?`).get(ref.job,ref.attempt,runtimeJob) as {input_sha256:string|null;input_size:number|null;spec_sha256:string|null;runtime_digest:string} | undefined;
      if (!row || typeof row.input_sha256 !== 'string' || !SHA.test(row.input_sha256) || !Number.isSafeInteger(row.input_size) || row.input_size! < 1 || typeof row.spec_sha256 !== 'string' || !SHA.test(row.spec_sha256) || !SHA.test(row.runtime_digest)) return null;
      return { sha256:row.input_sha256, size:row.input_size!,specSha256:row.spec_sha256,image:`sha256:${row.runtime_digest}` };
    });
  }
  /** Read cancelled runtime jobs for an internal reconciler; cancellation is durable before signalling. */
  pendingRuntimeCancellations(): { job:string; attempt:string; runtimeJob:string }[] {
    return this.transaction(() => {
      this.safeNow();
      return this.db.prepare(`SELECT r.job,r.attempt,r.runtime_job AS runtimeJob FROM protected_runtime_jobs r
        JOIN protected_attempt_cancellation c ON c.job=r.job AND c.attempt=r.attempt WHERE c.cancelled=1 ORDER BY r.job,r.attempt`).all() as
        { job:string; attempt:string; runtimeJob:string }[];
    });
  }
  /** Admission guard for the manager; does not attest the runtime or authorize a verification verdict. */
  canDispatchProtected(ref: { project:string; board:string; operation:string; job:string; attempt:string }, runtimeJob: string, continuing = false): boolean {
    if (!ref || ![ref.project,ref.board,ref.operation,ref.job,ref.attempt,runtimeJob].every(x => typeof x === 'string' && ID.test(x))) return false;
    return this.transaction(() => this.dispatchAllowed(ref,runtimeJob,continuing));
  }
  private dispatchAllowed(ref: { project:string; board:string; operation:string; job:string; attempt:string }, runtimeJob: string, continuing: boolean): boolean {
      const now = this.clock();
      const attempt = this.db.prepare('SELECT * FROM protected_attempt_bindings WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as Attempt | undefined;
      const target = this.db.prepare('SELECT revision,alias_revision,state,source_manifest,board_path FROM protected_targets WHERE project=? AND board=?').get(ref.project,ref.board) as Target | undefined;
      const lease = this.db.prepare('SELECT * FROM protected_leases WHERE project=? AND board=?').get(ref.project,ref.board) as Lease | undefined;
      const cancel = this.db.prepare('SELECT cancelled FROM protected_attempt_cancellation WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as {cancelled:number} | undefined;
      const runtime = this.db.prepare('SELECT runtime_job,input_sha256,input_size,spec_sha256,attested_image,archive_tool_digest FROM protected_runtime_jobs WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as {runtime_job:string;input_sha256:string|null;input_size:number|null;spec_sha256:string|null;attested_image:string|null;archive_tool_digest:string|null} | undefined;
      const current = this.db.prepare('SELECT policy_digest,runtime_digest,toolchain_digest FROM protected_target_policy WHERE project=? AND board=?').get(ref.project,ref.board) as {policy_digest:string;runtime_digest:string;toolchain_digest:string} | undefined;
      const policy = attempt && this.db.prepare('SELECT enabled FROM protected_policies WHERE digest=?').get(attempt.policy_digest) as {enabled:number} | undefined;
      const approved = this.db.prepare('SELECT enabled FROM protected_approved_digests WHERE kind=? AND digest=?');
      const signed = attempt && target?.board_path && runtime?.archive_tool_digest ? this.authorizePolicy({digest:attempt.policy_digest,project:ref.project,board:ref.board,operation:ref.operation,
        boardPath:target.board_path,workerDigest:attempt.runtime_digest,toolchainDigest:attempt.toolchain_digest,archiveDigest:runtime.archive_tool_digest},now) : null;
      return !!attempt && attempt.project === ref.project && attempt.board === ref.board && attempt.operation === ref.operation &&
        !!target && target.state === 'ACTIVE' && target.revision === attempt.source_revision && target.alias_revision === attempt.alias_revision && target.source_manifest === attempt.source_manifest &&
        !!lease && lease.boot_id === this.bootId && lease.pinned === 1 && lease.expires_at > now && lease.generation === attempt.generation && lease.operation === ref.operation && lease.source_manifest === attempt.source_manifest &&
        !!cancel && cancel.cancelled === 0 && runtime?.runtime_job === runtimeJob && typeof runtime.input_sha256 === 'string' && SHA.test(runtime.input_sha256) && Number.isSafeInteger(runtime.input_size) && runtime.input_size! > 0 && typeof runtime.spec_sha256 === 'string' && SHA.test(runtime.spec_sha256) && (!continuing || runtime.attested_image === `sha256:${attempt.runtime_digest}`) && !!current && current.policy_digest === attempt.policy_digest && current.runtime_digest === attempt.runtime_digest && current.toolchain_digest === attempt.toolchain_digest &&
        !!signed && policy?.enabled === 1 && !!runtime.archive_tool_digest && (approved.get('archive-tool',runtime.archive_tool_digest) as {enabled:number} | undefined)?.enabled === 1 && (approved.get('runtime',attempt.runtime_digest) as {enabled:number} | undefined)?.enabled === 1 &&
        (approved.get('toolchain',attempt.toolchain_digest) as {enabled:number} | undefined)?.enabled === 1 &&
        (continuing || !this.db.prepare('SELECT 1 FROM protected_candidates WHERE job=? AND attempt=?').get(ref.job,ref.attempt));
  }
  /** Called only by the daemon after inspecting the container it just launched. */
  recordRuntimeAttestationFromTrustedService(ref: {project:string;board:string;operation:string;job:string;attempt:string}, runtimeJob: string, image: string): boolean {
    if (!/^sha256:[0-9a-f]{64}$/.test(image)) return false;
    return this.transaction(() => {
      if (!this.dispatchAllowed(ref,runtimeJob,false)) return false;
      const attempt = this.db.prepare('SELECT runtime_digest FROM protected_attempt_bindings WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as {runtime_digest:string} | undefined;
      if (!attempt || image !== `sha256:${attempt.runtime_digest}`) return false;
      return this.db.prepare('UPDATE protected_runtime_jobs SET attested_image=? WHERE job=? AND attempt=? AND runtime_job=?').run(image,ref.job,ref.attempt,runtimeJob).changes === 1;
    });
  }
  /** Persist cancellation before the orchestrator stops a worker. Pins remain until trusted cleanup. */
  cancelAttempt(capability: string, ref: { project: string; board: string; operation: string; job: string; attempt: string }): void {
    if (!ref || ![ref.project,ref.board,ref.operation,ref.job,ref.attempt].every(x => typeof x === 'string' && ID.test(x))) throw new Error('invalid protected cancellation');
    this.withCapability(capability, { role:'cancel',project:ref.project,board:ref.board,operation:ref.operation,job:ref.job,attempt:ref.attempt }, () => {
      const attempt = this.db.prepare('SELECT * FROM protected_attempt_bindings WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as Attempt | undefined;
      if (!attempt || attempt.project !== ref.project || attempt.board !== ref.board || attempt.operation !== ref.operation) throw new Error('protected attempt unavailable');
      const candidate = this.db.prepare('SELECT state FROM protected_candidates WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as {state:string} | undefined;
      if (candidate?.state === 'COMMITTED') throw new Error('protected attempt is already committed');
      const changed = this.db.prepare('UPDATE protected_attempt_cancellation SET cancelled=1 WHERE job=? AND attempt=?').run(ref.job,ref.attempt);
      if (changed.changes !== 1) throw new Error('protected cancellation state unavailable');
    });
  }
  /** Records unverified worker output as a pinned candidate; this is not a verdict or permission to commit. */
  stageCandidate(capability: string, ref: { project: string; board: string; operation: string; job: string; attempt: string; manifest: string }): void {
    if (!ref || ![ref.project,ref.board,ref.operation,ref.job,ref.attempt].every(x => typeof x === 'string' && ID.test(x)) ||
        typeof ref.manifest !== 'string' || !SHA.test(ref.manifest)) throw new Error('invalid protected candidate');
    this.withCapability(capability, { role:'worker',project:ref.project,board:ref.board,operation:ref.operation,job:ref.job,attempt:ref.attempt }, () => {
      const now = this.clock();
      const attempt = this.db.prepare('SELECT * FROM protected_attempt_bindings WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as Attempt | undefined;
      const target = this.db.prepare('SELECT revision,alias_revision,state,source_manifest,board_path FROM protected_targets WHERE project=? AND board=?').get(ref.project,ref.board) as Target | undefined;
      const lease = this.db.prepare('SELECT * FROM protected_leases WHERE project=? AND board=?').get(ref.project,ref.board) as Lease | undefined;
      const cancellation = this.db.prepare('SELECT cancelled FROM protected_attempt_cancellation WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as {cancelled:number} | undefined;
      const runtime = this.db.prepare('SELECT attested_image,archive_tool_digest FROM protected_runtime_jobs WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as {attested_image:string|null;archive_tool_digest:string|null} | undefined;
      const tool = runtime?.archive_tool_digest ? this.db.prepare("SELECT enabled FROM protected_approved_digests WHERE kind='archive-tool' AND digest=?").get(runtime.archive_tool_digest) as {enabled:number} | undefined : undefined;
      if (!attempt || attempt.project !== ref.project || attempt.board !== ref.board || attempt.operation !== ref.operation ||
          !target || target.state !== 'ACTIVE' || !target.board_path || target.revision !== attempt.source_revision || target.alias_revision !== attempt.alias_revision || target.source_manifest !== attempt.source_manifest ||
          !lease || lease.boot_id !== this.bootId || lease.pinned !== 1 || lease.expires_at <= now || lease.generation !== attempt.generation || lease.operation !== ref.operation || lease.source_manifest !== attempt.source_manifest || !cancellation || cancellation.cancelled !== 0 || runtime?.attested_image !== `sha256:${attempt.runtime_digest}` || tool?.enabled !== 1)
        throw new Error('protected candidate attempt is stale');
      if (!runtime.archive_tool_digest || !this.authorizePolicy({digest:attempt.policy_digest,project:ref.project,board:ref.board,operation:ref.operation,
        boardPath:target.board_path,workerDigest:attempt.runtime_digest,toolchainDigest:attempt.toolchain_digest,archiveDigest:runtime.archive_tool_digest},now))
        throw new Error('protected candidate policy is not authorized');
      const prior = this.db.prepare('SELECT manifest,state FROM protected_candidates WHERE job=? AND attempt=?').get(ref.job,ref.attempt) as {manifest:string;state:string} | undefined;
      if (prior) { if (prior.manifest !== ref.manifest || prior.state !== 'STAGED') throw new Error('protected candidate changed'); return; }
      const blob = this.db.prepare("SELECT size FROM protected_uploads WHERE sha256=? AND state='ready'");
      const closure = resolveManifestClosure(ref.manifest, sha => this.read(sha), sha => (blob.get(sha) as {size:number} | undefined)?.size ?? null,
        {maxDepth:16,maxManifests:256,maxNodes:100_000,maxBytes:64*1024**3,maxManifestBytes:64*1024**2});
      if (closure.rootProject !== ref.project || !closure.rootManifest.required_paths.includes(target.board_path) ||
          !closure.rootManifest.entries.some(entry => entry.kind === 'file' && entry.path === target.board_path)) throw new Error('protected candidate board unavailable');
      for (const hash of new Set(closure.nodes.filter(node => node.kind === 'file').map(node => node.sha256))) this.read(hash);
      this.pinClosure('attempt-candidate', JSON.stringify([ref.job,ref.attempt]), closure);
      this.db.prepare("INSERT INTO protected_candidates VALUES (?,?,?,'STAGED')").run(ref.job,ref.attempt,ref.manifest);
    });
  }
  /** Only use after a trusted service has recorded independently verified policy, runtime, receipt and cleanup. */
  commit(capability: string, request: CommitRequestV1): CommitResultV1 {
    const keys = ['schema','request_id','job_id','attempt_id','verification_id','project_id','board_id','alias_revision','source_revision','candidate_manifest_sha256','lease_generation','lease_token'];
    if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).length !== keys.length || !keys.every(k => Object.hasOwn(request,k)) ||
        request.schema !== 'pcb.commit-request.v1' || ![request.request_id,request.job_id,request.attempt_id,request.verification_id,request.project_id,request.board_id].every(x => typeof x === 'string' && ID.test(x)) ||
        ![request.alias_revision,request.source_revision,request.lease_generation].every(x => Number.isSafeInteger(x) && x > 0) ||
        !SHA.test(request.candidate_manifest_sha256) || !SHA.test(request.lease_token)) throw new Error('invalid protected commit request');
    const tokenHash = protectedLeaseHash(request.lease_token);
    const fingerprint = parseCanonicalJson(Buffer.from(JSON.stringify({ ...request, lease_token: tokenHash.toString('hex') })), { maxBytes: 16_384, maxNodes: 100, maxDepth: 4 }).sha256;
    // Commit capabilities are scoped to the exact attempt and operation; determine operation inside the transaction.
    const binding = this.db.prepare('SELECT operation FROM protected_attempt_bindings WHERE job=? AND attempt=?').get(request.job_id, request.attempt_id) as { operation: string } | undefined;
    if (!binding) throw new Error('protected attempt unavailable');
    return this.withCapability(capability, { role: 'commit', project: request.project_id, board: request.board_id, operation: binding.operation, job: request.job_id, attempt: request.attempt_id }, () => {
      const prior = this.db.prepare('SELECT fingerprint,revision,manifest FROM protected_commit_results WHERE request_id=?').get(request.request_id) as { fingerprint: string; revision: number; manifest: string } | undefined;
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error('commit request ID reused with different content');
        return { schema: 'pcb.commit-result.v1', request_id: request.request_id, state: 'COMMITTED', revision: prior.revision, manifest_sha256: prior.manifest } as const;
      }
      const now = this.clock(), target = this.db.prepare('SELECT revision,alias_revision,state,source_manifest,board_path FROM protected_targets WHERE project=? AND board=?').get(request.project_id,request.board_id) as Target | undefined;
      const lease = this.db.prepare('SELECT * FROM protected_leases WHERE project=? AND board=?').get(request.project_id,request.board_id) as Lease | undefined;
      const attempt = this.db.prepare('SELECT * FROM protected_attempt_bindings WHERE job=? AND attempt=?').get(request.job_id,request.attempt_id) as Attempt | undefined;
      const verified = this.db.prepare('SELECT * FROM protected_verified_attempts WHERE job=? AND attempt=? AND verification=?').get(request.job_id,request.attempt_id,request.verification_id) as Verified | undefined;
      const staged = this.db.prepare('SELECT manifest,state FROM protected_candidates WHERE job=? AND attempt=?').get(request.job_id,request.attempt_id) as {manifest:string;state:string} | undefined;
      const cancellation = this.db.prepare('SELECT cancelled FROM protected_attempt_cancellation WHERE job=? AND attempt=?').get(request.job_id,request.attempt_id) as {cancelled:number} | undefined;
      const runtime = this.db.prepare('SELECT attested_image,archive_tool_digest FROM protected_runtime_jobs WHERE job=? AND attempt=?').get(request.job_id,request.attempt_id) as {attested_image:string|null;archive_tool_digest:string|null} | undefined;
      const targetPolicy = this.db.prepare('SELECT policy_digest,runtime_digest,toolchain_digest FROM protected_target_policy WHERE project=? AND board=?').get(request.project_id,request.board_id) as { policy_digest:string; runtime_digest:string; toolchain_digest:string } | undefined;
      if (!Number.isSafeInteger(now) || now < 1 || !target || target.state !== 'ACTIVE' || !target.board_path || target.revision !== request.source_revision || target.alias_revision !== request.alias_revision ||
          !lease || lease.boot_id !== this.bootId || lease.pinned !== 1 || lease.expires_at <= now || lease.generation !== request.lease_generation || lease.source_revision !== target.revision || lease.alias_revision !== target.alias_revision ||
          lease.source_manifest !== target.source_manifest || lease.token_hash.byteLength !== 32 || !timingSafeEqual(Buffer.from(lease.token_hash),tokenHash) ||
          !attempt || attempt.project !== request.project_id || attempt.board !== request.board_id || attempt.generation !== lease.generation || attempt.source_revision !== target.revision ||
          attempt.alias_revision !== target.alias_revision || attempt.source_manifest !== target.source_manifest || attempt.operation !== lease.operation || attempt.operation !== binding.operation || !targetPolicy ||
          attempt.policy_digest !== targetPolicy.policy_digest || attempt.runtime_digest !== targetPolicy.runtime_digest || attempt.toolchain_digest !== targetPolicy.toolchain_digest ||
          !staged || staged.state !== 'STAGED' || staged.manifest !== request.candidate_manifest_sha256 || !cancellation || cancellation.cancelled !== 0 || runtime?.attested_image !== `sha256:${attempt.runtime_digest}` ||
          !verified || verified.state !== 'VERIFIED' || verified.cancelled !== 0 || verified.revoked !== 0 || verified.candidate_manifest !== request.candidate_manifest_sha256)
        throw new Error('protected commit preconditions failed');
      const policy = this.db.prepare('SELECT required_checks,parity_na,enabled FROM protected_policies WHERE digest=?').get(attempt.policy_digest) as { required_checks:string; parity_na:number; enabled:number } | undefined;
      const approved = this.db.prepare('SELECT enabled FROM protected_approved_digests WHERE kind=? AND digest=?');
      const verifier = this.db.prepare('SELECT enabled FROM protected_verifiers WHERE id=?').get(verified.verifier) as { enabled:number } | undefined;
      if (!policy || policy.enabled !== 1 || ![0,1].includes(policy.parity_na) || verifier?.enabled !== 1 || !runtime?.archive_tool_digest ||
          (approved.get('archive-tool',runtime.archive_tool_digest) as {enabled:number} | undefined)?.enabled !== 1 ||
          (approved.get('runtime',attempt.runtime_digest) as { enabled:number } | undefined)?.enabled !== 1 ||
          (approved.get('toolchain',attempt.toolchain_digest) as { enabled:number } | undefined)?.enabled !== 1) throw new Error('protected authority is unavailable');
      let checks: string[]; try { checks = JSON.parse(policy.required_checks) as string[]; } catch { throw new Error('invalid protected policy'); }
      const signed=this.authorizePolicy({digest:attempt.policy_digest,project:request.project_id,board:request.board_id,operation:attempt.operation,
        boardPath:target.board_path,workerDigest:attempt.runtime_digest,toolchainDigest:attempt.toolchain_digest,archiveDigest:runtime.archive_tool_digest},now);
      if (!signed || verified.verifier_image_digest !== signed.verifier_image_sha256 || JSON.stringify(checks)!==JSON.stringify(signed.required_checks) ||
          (policy.parity_na===1)!==signed.parity_not_applicable_allowed) throw new Error('protected signed policy is unavailable or changed');
      const blob = this.db.prepare("SELECT size FROM protected_uploads WHERE sha256=? AND state='ready'");
      const source = resolveManifestClosure(attempt.source_manifest, sha => this.read(sha), sha => (blob.get(sha) as { size:number } | undefined)?.size ?? null,
        { maxDepth:16,maxManifests:256,maxNodes:100_000,maxBytes:64*1024**3,maxManifestBytes:64*1024**2 });
      if (source.rootProject !== request.project_id || !source.rootManifest.required_paths.includes(target.board_path) ||
          !source.rootManifest.entries.some(entry => entry.kind === 'file' && entry.path === target.board_path)) throw new Error('source board is unavailable');
      const candidate = resolveManifestClosure(request.candidate_manifest_sha256, sha => this.read(sha), sha => (blob.get(sha) as { size:number } | undefined)?.size ?? null,
        { maxDepth:16,maxManifests:256,maxNodes:100_000,maxBytes:64*1024**3,maxManifestBytes:64*1024**2 });
      if (candidate.rootProject !== request.project_id || !candidate.rootManifest.required_paths.includes(target.board_path) ||
          !candidate.rootManifest.entries.some(entry => entry.kind === 'file' && entry.path === target.board_path)) throw new Error('candidate board is unavailable');
      assertBoardOnlyChange(source.rootManifest,candidate.rootManifest,target.board_path);
      for (const hash of new Set([...source.nodes, ...candidate.nodes].filter(node => node.kind === 'file').map(node => node.sha256))) this.read(hash);
      const parsed = parseTrustedVerification(verified.receipt, { verification_id:request.verification_id, job_id:request.job_id, attempt_id:request.attempt_id,
        project_id:request.project_id, board_id:request.board_id, alias_revision:request.alias_revision, lease_generation:request.lease_generation,
        source_revision:request.source_revision, source_manifest_sha256:attempt.source_manifest, candidate_manifest_sha256:request.candidate_manifest_sha256,
        toolchain_digest:attempt.toolchain_digest,runtime_digest:attempt.runtime_digest,policy_digest:attempt.policy_digest,evidence_manifest_sha256:verified.evidence_manifest,
        verifier_identity:verified.verifier,required_checks:checks,parity_not_applicable_allowed:policy.parity_na===1,now_ms:now,max_receipt_age_ms:300_000 });
      if (!this.blobReady(verified.evidence_manifest) || parsed.receipt.checks.some(check => !check.evidence_manifest_sha256 || !this.blobReady(check.evidence_manifest_sha256)))
        throw new Error('verification evidence unavailable');
      for (const hash of new Set([verified.evidence_manifest, ...parsed.receipt.checks.map(check => check.evidence_manifest_sha256!)])) this.read(hash);
      const revision = target.revision + 1; if (!Number.isSafeInteger(revision)) throw new Error('protected revision exhausted');
      const revisionOwner = JSON.stringify([request.project_id, request.board_id, revision]);
      this.pinClosure('revision', JSON.stringify([request.project_id, request.board_id, target.revision]), source);
      this.pinClosure('revision', revisionOwner, candidate);
      this.pinBlobs('revision-evidence', revisionOwner, [verified.evidence_manifest, ...parsed.receipt.checks.map(check => check.evidence_manifest_sha256!)]);
      const changed = this.db.prepare('UPDATE protected_targets SET revision=?,source_manifest=? WHERE project=? AND board=? AND revision=? AND source_manifest=? AND alias_revision=? AND state=?')
        .run(revision,request.candidate_manifest_sha256,request.project_id,request.board_id,target.revision,target.source_manifest,target.alias_revision,'ACTIVE');
      if (changed.changes !== 1) throw new Error('protected revision changed');
      this.db.prepare('INSERT INTO protected_revisions VALUES (?,?,?,?,?)').run(request.project_id,request.board_id,revision,request.candidate_manifest_sha256,request.verification_id);
      this.db.prepare('INSERT INTO protected_commit_results VALUES (?,?,?,?)').run(request.request_id,fingerprint,revision,request.candidate_manifest_sha256);
      this.db.prepare("DELETE FROM protected_blob_pins WHERE kind='attempt-source' AND owner=?").run(JSON.stringify([request.job_id, request.attempt_id]));
      this.db.prepare("DELETE FROM protected_blob_pins WHERE kind='attempt-candidate' AND owner=?").run(JSON.stringify([request.job_id, request.attempt_id]));
      this.db.prepare("UPDATE protected_candidates SET state='COMMITTED' WHERE job=? AND attempt=?").run(request.job_id,request.attempt_id);
      this.db.prepare('UPDATE protected_leases SET pinned=0,expires_at=0,token_hash=?,owner=? WHERE project=? AND board=?').run(Buffer.alloc(32),'',request.project_id,request.board_id);
      this.db.prepare('INSERT INTO protected_lease_audit VALUES (?,?,?,?,?,?)').run(request.project_id,request.board_id,lease.generation,verified.verifier,'committed-cleanup',now);
      return { schema:'pcb.commit-result.v1',request_id:request.request_id,state:'COMMITTED',revision,manifest_sha256:request.candidate_manifest_sha256 } as const;
    });
  }
}
