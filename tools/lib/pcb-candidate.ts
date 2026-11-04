// A sealed candidate: continuing one in a new run, and adopting one into canonical CAD. Only adoption changes the board.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { holdLock } from './file-lock.ts';
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
const terminalOf = (folder: string): Dict => plainJson(verify(folder)) as Dict;

function sameIdentity(a: string, b: string, manifest: RunManifest): boolean {
  const pours = declaredPours(manifest as Parameters<typeof declaredPours>[0]);
  return sameValue(pcbIdentity(a, pours), pcbIdentity(b, pours));
}

const preservesSource = (operation: Dict, terminal: Dict): boolean => operation.identity_preserved === true && !(operation.protected_source_changes as unknown[] | undefined)?.length
  && operation.source_unchanged === true && operation.continuation_allowed !== false && ['passed', 'failed'].includes(terminal.status as string);

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

/** FOCUS.md freezes this board: only a current failed check and one named finding it resolves can change it. */
function checkFrozenBaseline(root: string, folder: string, board: string, node: string, baselinePath: string | null | undefined, defect: string | null | undefined): void {
  if (!baselinePath || !defect) fail('FOCUS.md freezes this board: provide --baseline RUN_ID and --defect FINDING_ID from a current failed check');
  const baseline = baselinePath!;
  const previous = readPyJson<RunManifest>(joinPath(baseline, 'run.json'));
  const prior = terminalOf(baseline);
  const receipt = readPyJson<GateResult>(joinPath(baseline, 'gate/result.json'));
  const findings = readPyJson<Findings>(joinPath(baseline, 'gate/findings.json'));
  if (previous.board !== board || resolvePath(previous.root) !== root || receipt.exit !== 1 || prior.status !== 'failed') fail('defect baseline is not a failed check of this board/checkout');
  const finding = findings.findings.find(row => row.id === defect);
  if (!finding || finding.severity !== 'error' || !findings.inputs_valid || !findings.completed_checks?.includes(finding.stage)) fail('defect ID is absent from the failed-check findings');
  const updated = readPyJson<Findings>(joinPath(folder, 'gate/findings.json'));
  if (!updated.complete || !updated.inputs_valid || updated.findings.some(row => row.id === defect)) fail('candidate did not resolve the named defect with complete evidence');
  const source = readPyJson<SourceState>(joinPath(folder, 'operation/source.json'));
  for (const input of receipt.provenance.inputs) {
    if (input.path in source.files && source.files[input.path] !== input.sha256) fail('defect baseline does not match candidate source');
  }
  const check = snapshotProbe(node, root, [root, board, '--verify-failed', joinPath(baseline, 'gate'), finding!.stage]);
  if (check.status) fail(`defect baseline is stale: ${check.stderr.trim()}`);
}

function replaceAtomically(target: string, bytes: Buffer, stillCurrent: () => void): void {
  const temporary = joinPath(dirname(target), `.pcb-adopt-${randomBytes(6).toString('hex')}`);
  const file = openSync(temporary, 'wx', 0o600);
  try {
    writeSync(file, bytes);
    fsyncSync(file);
    closeSync(file);
    stillCurrent();
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function checkAdoptable(root: string, folder: string, manifest: RunManifest, operation: Dict, result: Dict): string {
  if (manifest.operation === 'ml') fail('ML observations cannot adopt native CAD');
  const cleanup = (result.cleanup ?? {}) as Dict;
  if (resolvePath(manifest.root) !== root || result.status !== 'passed' || !cleanup.complete) fail('only a successful, settled candidate from this checkout can be adopted');
  if (!operation.candidate_verified || !operation.identity_preserved || (operation.protected_source_changes as unknown[] | undefined)?.length) fail('candidate changes protected design identity or lacks full gate verification');
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
  if (state.frozen) checkFrozenBaseline(root, folder, manifest.board, manifest.node as string, baseline, defect);
  const locks = joinPath(root, '.gate/board-locks');
  mkdirSync(locks, { recursive: true });
  const lock = await holdLock(joinPath(locks, `${manifest.board}.lock`));
  try {
    return commitAdoption(root, folder, manifest, operation, candidate, defect ?? null);
  } finally {
    await lock.release();
  }
}
