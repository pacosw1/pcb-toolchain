// A sealed candidate: continuing one in a new run, and adopting one into canonical CAD. Only adoption changes the board.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, fchmodSync, fchownSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { atomicJson, plainJson, readPyJson } from './json-file.ts';
import { verify } from './pcb-evidence.ts';
import { declaredPours, pcbIdentity } from './pcb-identity.ts';
import { sourceState, type SourceState } from './pcb-sources.ts';
import { boardConfig, context, sha } from './pcb-workflow.ts';
import { PyError } from './py-compat.mjs';
import { isRelativeTo, joinPath, relativeTo, resolvePath, withSuffix } from './py-path.ts';
import { type Dict, sameValue } from './py-values.ts';

const VERIFY_MS = 90_000;

function fail(message: string): never { throw new PyError('ValueError', message); }

export interface RunManifest extends Dict {
  root: string; board: string; operation?: string; node?: string; router?: string; spec?: { pours?: never[] };
}
interface Reference { folder: string; result_sha256: string }
interface Finding { id: string; severity?: string; stage: string }
interface Findings { findings: Finding[]; inputs_valid?: boolean; completed_checks?: string[]; complete?: boolean }
interface GateResult { exit: number; provenance: { inputs: { path: string; sha256: string }[] } }

const nativeBoard = (root: string, board: string): string => withSuffix(boardConfig(root, board).project, '.kicad_pcb');
const terminalOf = (folder: string): Dict => {
  const terminal = plainJson(verify(folder)) as Dict;
  if ((terminal.cleanup as Dict | undefined)?.complete !== true) fail('run did not finish with confirmed process cleanup');
  return terminal;
};

function requireBound(result: Dict, names: string[]): void {
  const evidence = result.evidence_sha256;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) fail('terminal receipt does not bind its evidence; create a new run');
  for (const name of names) {
    if (typeof (evidence as Dict)[name] !== 'string') fail(`terminal receipt does not bind required adoption evidence: ${name}`);
  }
}

function sameIdentity(a: string, b: string, manifest: RunManifest): boolean {
  const pours = declaredPours(manifest as Parameters<typeof declaredPours>[0]);
  return sameValue(pcbIdentity(a, pours), pcbIdentity(b, pours));
}

const noProtectedChanges = (operation: Dict): boolean => Array.isArray(operation.protected_source_changes) && operation.protected_source_changes.length === 0;
const preservesSource = (operation: Dict, terminal: Dict): boolean => operation.identity_preserved === true && noProtectedChanges(operation)
  && operation.source_unchanged === true && (operation.continuation_allowed === undefined || operation.continuation_allowed === true)
  && ['passed', 'failed'].includes(terminal.status as string);

/** Continues a sealed candidate; failed or partial tool output is never CAD. Gives the candidate and its bound evidence. */
export function parentCandidate(rootPath: string, board: string, reference: Reference): { candidate: string; dependencies: Record<string, string> } {
  const root = resolvePath(rootPath), parent = resolvePath(reference.folder);
  if (sha(joinPath(parent, 'result.json')) !== reference.result_sha256) fail('parent candidate terminal receipt changed');
  const terminal = terminalOf(parent);
  const manifest = readPyJson<RunManifest>(joinPath(parent, 'run.json'));
  const operation = readPyJson<Dict>(joinPath(parent, 'operation/result.json'));
  if (resolvePath(manifest.root) !== root || manifest.board !== board || !preservesSource(operation, terminal)) fail('parent lacks settled, source-preserving candidate evidence');
  const sources = readPyJson<SourceState>(joinPath(parent, 'operation/source.json'));
  if (!sameValue(sourceState(root, board, sources.extra_inputs), sources)) fail('canonical inputs changed since parent candidate creation');
  const candidate = resolvePath(operation.candidate as string);
  if (candidate !== nativeBoard(joinPath(parent, 'workspace'), board) || sha(candidate) !== operation.candidate_sha256) fail('parent candidate differs from its sealed receipt');
  if (!sameIdentity(nativeBoard(root, board), candidate, manifest)) fail('parent candidate changes protected board identity');
  const hashes = terminal.evidence_sha256 as Record<string, string>;
  const dependencies = Object.fromEntries(Object.entries(hashes).map(([name, digest]) => [joinPath(parent, name), digest]));
  dependencies[joinPath(parent, 'result.json')] = reference.result_sha256;
  return { candidate, dependencies };
}

function snapshotProbe(node: string, root: string, args: string[], env?: NodeJS.ProcessEnv): { status: number | null; stderr: string } {
  const run = spawnSync(node, [joinPath(root, 'tools/pcb_snapshot_inputs.mjs'), ...args], { encoding: 'utf8', timeout: VERIFY_MS, env: env ?? process.env });
  if (run.error) throw run.error;
  return run;
}

/** Check frozen-baseline metadata only. Fresh native evidence still needs an owned probe before any adoption. */
function checkFrozenBaselineMetadata(root: string, folder: string, board: string, baselinePath: string | null | undefined, defect: string | null | undefined): void {
  if (!baselinePath || !defect) fail('FOCUS.md freezes this board: provide --baseline RUN_ID and --defect FINDING_ID from a current failed check');
  const baseline = baselinePath!;
  const previous = readPyJson<RunManifest>(joinPath(baseline, 'run.json'));
  const prior = terminalOf(baseline);
  requireBound(prior, ['gate/result.json', 'gate/findings.json']);
  const receipt = readPyJson<GateResult>(joinPath(baseline, 'gate/result.json'));
  const findings = readPyJson<Findings>(joinPath(baseline, 'gate/findings.json'));
  if (previous.board !== board || resolvePath(previous.root) !== root || receipt.exit !== 1 || prior.status !== 'failed') fail('defect baseline is not a failed check of this board/checkout');
  const finding = findings.findings.find(row => row.id === defect);
  if (!finding || finding.severity !== 'error' || findings.inputs_valid !== true || !findings.completed_checks?.includes(finding.stage)) fail('defect ID is absent from the failed-check findings');
  const updated = readPyJson<Findings>(joinPath(folder, 'gate/findings.json'));
  if (updated.complete !== true || updated.inputs_valid !== true || updated.findings.some(row => row.id === defect)) fail('candidate did not resolve the named defect with complete evidence');
  const source = readPyJson<SourceState>(joinPath(folder, 'operation/source.json'));
  for (const input of receipt.provenance.inputs) {
    if (input.path in source.files && source.files[input.path] !== input.sha256) fail('defect baseline does not match candidate source');
  }
}

type ChunkWriter = (fd: number, bytes: Buffer, offset: number, length: number) => number;

/** Write the entire candidate before the last freshness check and atomic replacement. */
export function replaceAtomically(target: string, bytes: Buffer, stillCurrent: () => void,
  writeChunk: ChunkWriter = (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length)): void {
  const original = lstatSync(target);
  if (!original.isFile() || original.isSymbolicLink()) throw new Error('canonical PCB must be a regular file');
  const temporary = joinPath(dirname(target), `.pcb-adopt-${randomBytes(6).toString('hex')}`);
  const file = openSync(temporary, 'wx', 0o600);
  let open = true;
  try {
    for (let offset = 0; offset < bytes.length;) {
      const count = writeChunk(file, bytes, offset, bytes.length - offset);
      if (!Number.isInteger(count) || count <= 0 || count > bytes.length - offset) throw new Error('candidate write made invalid progress');
      offset += count;
    }
    const created = fstatSync(file);
    if (created.uid !== original.uid || created.gid !== original.gid) fchownSync(file, original.uid, original.gid);
    fchmodSync(file, original.mode & 0o7777);
    fsyncSync(file);
    closeSync(file);
    open = false;
    stillCurrent();
    const current = lstatSync(target);
    if (!current.isFile() || current.dev !== original.dev || current.ino !== original.ino || current.mode !== original.mode
        || current.uid !== original.uid || current.gid !== original.gid) throw new Error('canonical PCB metadata changed before atomic adoption');
    renameSync(temporary, target);
  } finally {
    if (open) { try { closeSync(file); } catch { /* retain the original write/close error */ } }
    rmSync(temporary, { force: true });
  }
}

function checkAdoptable(root: string, folder: string, manifest: RunManifest, operation: Dict, result: Dict): string {
  if (manifest.operation === 'ml') fail('ML observations cannot adopt native CAD');
  const cleanup = (result.cleanup ?? {}) as Dict;
  if (resolvePath(manifest.root) !== root || result.status !== 'passed' || cleanup.complete !== true) fail('only a successful, settled candidate from this checkout can be adopted');
  requireBound(result, ['operation/result.json', 'operation/source.json', 'gate/result.json', 'gate/findings.json']);
  if (operation.candidate_verified !== true || operation.identity_preserved !== true || !noProtectedChanges(operation)) fail('candidate changes protected design identity or lacks full gate verification');
  const candidate = resolvePath(operation.candidate as string);
  if (candidate !== nativeBoard(joinPath(folder, 'workspace'), manifest.board) || operation.candidate_sha256 !== sha(candidate)) fail('candidate does not match the verified native board');
  if (operation.candidate_sha256 !== result.candidate_sha256) fail('candidate receipt and controller disagree');
  for (const [name, digest] of Object.entries(operation.artifacts as Record<string, string>)) {
    const path = resolvePath(joinPath(folder, name));
    if (!isRelativeTo(path, folder) || path === folder || sha(path) !== digest) fail('candidate evidence changed after verification');
  }
  return candidate;
}

function commitAdoption(root: string, folder: string, manifest: RunManifest, operation: Dict, candidate: string, defect: string | null): Dict {
  const { board } = manifest;
  const sources = readPyJson<SourceState>(joinPath(folder, 'operation/source.json'));
  const unchanged = (message: string): void => {
    if (!sameValue(sourceState(root, board, sources.extra_inputs), sources)) fail(message);
  };
  const target = nativeBoard(root, board);
  unchanged('canonical inputs changed since candidate creation; generate and verify a new candidate');
  const workspace = joinPath(folder, 'workspace');
  const check = snapshotProbe(manifest.node as string, root, [workspace, board, '--verify', joinPath(folder, 'gate')], { ...process.env, IOT_LAB: workspace });
  if (check.status) fail(`candidate native evidence is stale: ${check.stderr.trim()}`);
  // Native and library probes take time: the read before them cannot authorize replacing a board edited meanwhile.
  verify(folder);
  unchanged('canonical inputs changed during adoption verification');
  if (!sameIdentity(target, candidate, manifest)) fail('candidate changes protected design identity');
  const candidateBytes = readFileSync(candidate);
  if (createHash('sha256').update(candidateBytes).digest('hex') !== operation.candidate_sha256) fail('candidate changed during adoption verification');
  const originalBytes = readFileSync(target);
  if (createHash('sha256').update(originalBytes).digest('hex') !== sources.files[relativeTo(target, root)]) fail('canonical PCB changed during adoption verification');
  const backup = joinPath(folder, 'backup');
  mkdirSync(backup);
  const saved = joinPath(backup, basename(target));
  writeFileSync(saved, originalBytes);
  replaceAtomically(target, candidateBytes, () => unchanged('canonical inputs changed before atomic adoption'));
  const receipt: Dict = {
    schema_version: 1, board, target, before_sha256: sha(saved), after_sha256: sha(target), candidate_run: basename(folder), defect,
    adopted_at: Date.now() / 1000,
  };
  atomicJson(joinPath(folder, 'adoption.json'), receipt);
  return receipt;
}

export async function adopt(rootPath: string, folderPath: string, defect?: string | null, baseline?: string | null): Promise<Dict> {
  const root = resolvePath(rootPath), folder = resolvePath(folderPath);
  const result = terminalOf(folder);
  const operation = readPyJson<Dict>(joinPath(folder, 'operation/result.json'));
  const manifest = readPyJson<RunManifest>(joinPath(folder, 'run.json'));
  const candidate = checkAdoptable(root, folder, manifest, operation, result);
  const state = context(root, manifest.board) as { frozen: boolean };
  if (state.frozen) checkFrozenBaselineMetadata(root, folder, manifest.board, baseline, defect);
  // A detached flock helper can die before the rename, and the current backup/receipt
  // sequence is not crash-recoverable. Reject before opening a lock or touching CAD.
  // A future implementation needs target-keyed lock ownership, a durable journal,
  // owned verifier cleanup, and an explicit extended-attribute policy.
  void candidate;
  fail('adoption unavailable until lock continuity and crash recovery are verified');
}
