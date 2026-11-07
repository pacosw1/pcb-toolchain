// The sources a board candidate depends on, and the workspace copy of them. Canonical CAD changes only in adoption, so a
// candidate is judged against this exact file list and its hashes.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { sha256Text } from './fingerprint.ts';
import { boardConfig, sha } from './pcb-workflow.ts';
import { CHANGE_FILE, SEAL_FILE, SNAPSHOT_IGNORED, SNAPSHOT_NOT_SOURCE } from './pcb-source-policy.ts';
import { compare, jsonDumps, PyError } from './py-compat.mjs';
import { isFile, isRelativeTo, joinPath, pathExists, relativeTo, resolvePath, withSuffix } from './py-path.ts';
import { sameValue } from './py-values.ts';
import { schematicDatasheets } from './schematic-datasheets.ts';

const REGISTRY_EVIDENCE = new Set(['evidence', 'datasheets']);
const PROJECT_FILES = ['FOCUS.md', 'AGENTS.md', 'CLAUDE.md'];
const SNAPSHOT_PROBE_MS = 20_000;

export interface SourceState { board: string | null; files: Record<string, string>; sha256: string; extra_inputs?: string[] }

const isSymlink = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
const isDirectoryEntry = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;

/** Path objects sort by their parts, so `a/b` comes before `a-b/c`. */
const byParts = (left: string, right: string): number => {
  const a = left.split('/'), b = right.split('/');
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const order = compare(a[index], b[index]);
    if (order) return order;
  }
  return a.length - b.length;
};

export function walkSources(folder: string, root: string, board: string | null | undefined, found: string[]): void {
  const names = readdirSync(folder).sort(compare);
  const folders = names.filter(name => isDirectoryEntry(joinPath(folder, name)));
  const registry = board && folder === joinPath(root, 'hardware-design/registry');
  const kept = folders.filter(name => !SNAPSHOT_IGNORED.has(name) && !name.endsWith('.3dshapes') && !(registry && REGISTRY_EVIDENCE.has(name)));
  if (kept.some(name => isSymlink(joinPath(folder, name)))) throw new PyError('ValueError', `directory symlinks need an explicit snapshot dependency: ${folder}`);
  for (const name of names) {
    const path = joinPath(folder, name);
    if (folders.includes(name) || name === SEAL_FILE || name === CHANGE_FILE || name.startsWith('.pcb-adopt-') || SNAPSHOT_NOT_SOURCE.has(extname(name)) || !isFile(path)) continue;
    found.push(path);
  }
  for (const name of kept) walkSources(joinPath(folder, name), root, board, found);
}

/** The gate resolves cross-board sheets, original evidence and referenced libraries: exact files, not whole evidence runs. */
function snapshotDependencies(root: string, board: string): string[] {
  const probe = spawnSync(process.env.NODE ?? 'node', [joinPath(root, 'tools/pcb_snapshot_inputs.mjs'), root, board],
    { encoding: 'utf8', timeout: SNAPSHOT_PROBE_MS, maxBuffer: 64 * 1024 * 1024 });
  if (probe.error) throw probe.error;
  if (probe.status) throw new PyError('ValueError', `cannot resolve snapshot dependencies: ${probe.stderr.trim()}`);
  return (JSON.parse(probe.stdout) as string[]).filter(path => isRelativeTo(path, root) && isFile(path));
}

function boardFolders(root: string, board: string): { names: string[]; project: string; datasheets: boolean } {
  const { cfg, project } = boardConfig(root, board);
  const owner = relativeTo(project, joinPath(root, 'hardware-design/boards')).split('/')[0]!;
  return {
    names: ['tools', `hardware-design/boards/${owner}`, 'hardware-design/boards/_art', 'hardware-design/blocks', 'hardware-design/registry'], project,
    datasheets: !!cfg.get('snapshot_schematic_datasheets'),
  };
}

export function sourceFiles(rootPath: string, board?: string | null, extraInputs?: readonly string[] | null): string[] {
  const root = resolvePath(rootPath);
  const found: string[] = [];
  const shape = board ? boardFolders(root, board) : null;
  for (const name of shape?.names ?? ['tools', 'hardware-design']) {
    const folder = joinPath(root, name);
    if (pathExists(folder)) walkSources(folder, root, board, found);
  }
  if (board && shape) {
    const dependencies = snapshotDependencies(root, board);
    found.push(...dependencies);
    const design = joinPath(root, 'hardware-design');
    found.push(...readdirSync(design).map(name => joinPath(design, name)).filter(isFile));
    if (shape.datasheets) found.push(...schematicDatasheets(root, [withSuffix(shape.project, '.kicad_sch'), ...dependencies]));
  }
  found.push(...PROJECT_FILES.map(name => joinPath(root, name)).filter(isFile));
  for (const name of extraInputs ?? []) {
    const path = resolvePath(joinPath(root, name));
    if (!isRelativeTo(path, root) || !isFile(path)) throw new PyError('ValueError', `explicit engineering dependency is missing or outside checkout: ${name}`);
    found.push(path);
  }
  return [...new Set(found)].sort(byParts);
}

export function sourceState(rootPath: string, board?: string | null, extraInputs?: readonly string[] | null): SourceState {
  const root = resolvePath(rootPath);
  const files = Object.fromEntries(sourceFiles(root, board, extraInputs).map(path => [relativeTo(path, root), sha(path)]));
  const sortedFiles = Object.fromEntries(Object.entries(files).sort(([a], [b]) => compare(a, b)));
  const state: SourceState = { board: board ?? null, files, sha256: sha256Text(jsonDumps(sortedFiles)) };
  if (extraInputs?.length) state.extra_inputs = [...new Set(extraInputs)].sort(compare);
  return state;
}

/** Copies the sources into a new folder, materializing file symlinks so a legacy writer cannot follow one back into CAD. */
export function snapshot(rootPath: string, workspacePath: string, board?: string | null, extraInputs?: readonly string[] | null): SourceState {
  const root = resolvePath(rootPath), workspace = resolvePath(workspacePath);
  if (pathExists(workspace)) throw new PyError('ValueError', 'candidate workspace must be new');
  const before = sourceState(root, board, extraInputs);
  mkdirSync(workspace);
  for (const name of Object.keys(before.files)) {
    const source = joinPath(root, name), target = joinPath(workspace, name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    chmodSync(target, statSync(source).mode);
  }
  const changed = Object.entries(before.files).some(([name, digest]) => sha(joinPath(workspace, name)) !== digest);
  if (changed || !sameValue(sourceState(root, board, extraInputs), before)) throw new PyError('ValueError', 'source changed while creating candidate workspace');
  return before;
}
