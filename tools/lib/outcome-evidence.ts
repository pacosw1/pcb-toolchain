// Sealed run evidence for outcome comparison: every file read is hashed, and a run must match its terminal seal.
import { lstatSync, readdirSync } from 'node:fs';
import { sha256File } from './json-file.ts';
import { jsonLoad } from './py-compat.mjs';
import { isFile, isRelativeTo, joinPath, relativeTo, resolvePath } from './py-path.ts';
import { readObject } from './json-file.ts';
import { isDict, need, type Dict } from './py-values.ts';

export const TERMINAL = ['passed', 'failed', 'error', 'timeout', 'cancelled'];

/** A finite number that is not negative. */
export const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export const asDict = (value: unknown): Dict => isDict(value) ? value : {};

export class Evidence {
  readonly root: string;
  readonly inputs = new Map<string, string | null>();

  constructor(root: string) {
    this.root = resolvePath(root);
  }

  file(name: string, expected?: string | null): string {
    const path = resolvePath(joinPath(this.root, name));
    const digest = sha256File(path);
    if (expected !== undefined && expected !== null && digest !== expected) throw new Error(`evidence changed: ${path}`);
    if (this.inputs.has(path) && this.inputs.get(path) !== digest) throw new Error('evidence changed during observation');
    this.inputs.set(path, digest);
    return path;
  }

  read(name: string, expected?: string | null): Dict {
    const path = this.file(name, expected);
    return readObject<Dict>(path, `expected evidence JSON object: ${path}`);
  }

  /** The same file with int and float kept apart, for a value that goes into a hash: 2.0 and 2 hash differently. */
  exact(name: string): Map<string, unknown> {
    return jsonLoad(this.file(name)) as Map<string, unknown>;
  }
}

function* filesBelow(folder: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return;
  }
  for (const name of names) {
    const path = joinPath(folder, name);
    if (lstatSync(path).isDirectory()) yield* filesBelow(path);
    else if (isFile(path)) yield path;
  }
}

export interface SealedRun {
  folder: string;
  terminal: Dict;
  manifest: Dict;
  operation: Dict;
  candidate: string | null;
}

function archivedCandidate(folder: string, operation: Dict): string {
  const recorded = need<string>(operation, 'candidate');
  const workspace = (operation.workspace as string) ?? recorded.slice(0, recorded.lastIndexOf('/'));
  if (!isRelativeTo(recorded, workspace)) throw new Error('candidate escapes recorded workspace');
  const archive = joinPath(folder, 'workspace');
  const candidate = resolvePath(joinPath(archive, relativeTo(recorded, workspace)));
  if (!isRelativeTo(candidate, archive)) throw new Error('candidate path escapes archived workspace');
  return candidate;
}

export function sealedRun(evidence: Evidence, folderName: string, expected: string): SealedRun {
  const folder = resolvePath(joinPath(evidence.root, folderName));
  const terminal = evidence.read(joinPath(folder, 'result.json'), expected);
  if (!TERMINAL.includes(terminal.status as string) || asDict(terminal.cleanup).complete !== true) {
    throw new Error('run is not terminal with confirmed owned cleanup');
  }
  const hashes = terminal.evidence_sha256 ?? {};
  if (!isDict(hashes) || !('run.json' in hashes)) throw new Error('run has no terminal evidence seal');
  for (const [name, digest] of Object.entries(hashes)) {
    const path = resolvePath(joinPath(folder, name));
    if (!isRelativeTo(path, folder)) throw new Error('sealed run path escapes its folder');
    evidence.file(path, digest as string);
  }
  const manifest = evidence.read(joinPath(folder, 'run.json'));
  const actual = new Set(['run.json']);
  for (const directory of ['operation', 'gate']) {
    for (const path of filesBelow(joinPath(folder, directory))) actual.add(relativeTo(path, folder));
  }
  const resultPath = joinPath(folder, 'operation/result.json');
  const operation = isFile(resultPath) ? evidence.read(resultPath) : {};
  let candidate: string | null = null;
  if (operation.candidate) {
    candidate = archivedCandidate(folder, operation);
    actual.add(relativeTo(candidate, folder));
    evidence.file(candidate, operation.candidate_sha256 as string | undefined);
  }
  const sealed = Object.keys(hashes);
  if (sealed.length !== actual.size || sealed.some(name => !actual.has(name))) throw new Error('run evidence inventory differs from its terminal seal');
  return { folder, terminal, manifest, operation, candidate };
}
