// Bind terminal receipts to the original run inputs and evidence files. Hash maps are compared without regard to order: rglob order was never stable, so the order
// of evidence_sha256 in a receipt carries no meaning.
import { lstatSync, readdirSync } from 'node:fs';
import { sha } from './pcb-workflow.ts';
import { get, PyError, truthy } from './py-compat.mjs';
import { isFile, isRelativeTo, joinPath, jsonOf, pathExists, relativeTo, resolvePath } from './py-path.ts';

const VERDICTS = new Set(['passed', 'failed']);

/** Everything below `folder`, symlinks listed but not followed. A missing folder is empty, as with rglob. */
function walk(folder: string): string[] {
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  return names.flatMap(name => {
    const path = joinPath(folder, name);
    return lstatSync(path).isDirectory() ? [path, ...walk(path)] : [path];
  });
}

const isLink = (path: string): boolean => lstatSync(path).isSymbolicLink();

function candidateFile(folder: string, candidate: unknown): string {
  const path = resolvePath(joinPath('.', candidate));
  if (!isRelativeTo(path, resolvePath(joinPath(folder, 'workspace')))) throw new PyError('ValueError', 'candidate escapes its isolated workspace');
  return path;
}

function releaseArtifacts(folder: string, directory: unknown): string[] {
  const path = resolvePath(joinPath('.', directory));
  if (path !== resolvePath(joinPath(folder, 'candidate'))) throw new PyError('ValueError', 'release artifacts escape their run candidate');
  const entries = walk(path);
  if (entries.some(isLink)) throw new PyError('ValueError', 'release artifact symlinks cannot be sealed');
  return entries.filter(isFile);
}

function operationFiles(folder: string): string[] {
  const result = joinPath(folder, 'operation/result.json');
  if (!pathExists(result)) return [];
  const operation = jsonOf(result);
  const candidate = get(operation, 'candidate');
  const files = truthy(candidate) ? [candidateFile(folder, candidate)] : [];
  const directory = get(operation, 'artifact_directory');
  return truthy(directory) && pathExists(joinPath('.', directory)) ? [...files, ...releaseArtifacts(folder, directory)] : files;
}

export function evidenceFiles(folderPath: string): Record<string, string> {
  const folder = resolvePath(folderPath);
  const sealed = ['operation', 'gate', 'images'].flatMap(name => walk(joinPath(folder, name)).filter(isFile));
  const paths = [joinPath(folder, 'run.json'), ...sealed, ...operationFiles(folder)];
  const names = [...new Set(paths)].sort();
  return Object.fromEntries(names.map(path => [relativeTo(path, folder), sha(path)]));
}

/** The terminal receipt of a run, once its evidence, verdict and process cleanup all hold. */
function verifyWithVerdicts(folderPath: string, verdicts: ReadonlySet<string>): Map<string, unknown> {
  const folder = resolvePath(folderPath);
  const result = jsonOf(joinPath(folder, 'result.json'));
  const hashes = get(result, 'evidence_sha256');
  if (!(hashes instanceof Map) || !hashes.has('run.json')) throw new PyError('ValueError', 'terminal receipt does not bind its evidence; create a new run');
  for (const [name, digest] of hashes as Map<string, unknown>) {
    const path = resolvePath(joinPath(folder, name));
    if (!isRelativeTo(path, folder) || !isFile(path) || sha(path) !== digest) throw new PyError('ValueError', `verified run evidence changed: ${name}`);
  }
  const complete = get(get(result, 'cleanup', new Map()), 'complete');
  if (!verdicts.has(get(result, 'status') as string) || !truthy(complete)) throw new PyError('ValueError', 'run did not finish with confirmed process cleanup');
  return result as Map<string, unknown>;
}

export function verify(folderPath: string): Map<string, unknown> { return verifyWithVerdicts(folderPath, VERDICTS); }

/** Supervision only: cancellation/timeout receipts never qualify a candidate or permit adoption. */
export function verifySettled(folderPath: string): Map<string, unknown> {
  return verifyWithVerdicts(folderPath, new Set(['passed','failed','error','cancelled','timeout']));
}
