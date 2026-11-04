// Repository-derived board context and deterministic workflow plans. tools/pcb_workflow.py is the Python twin while
// Python modules import it. Native CAD, gate.json and the board registry stay the sources of truth: this module holds
// command adapters, not a second part or design database.
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { sha256File } from './json-file.ts';
import { get, item, osError, PyError, sorted, truthy } from './py-compat.mjs';
import { caught, isFile, isInside, isRelativeTo, joinPath, jsonOf, pathExists, relativeTo, resolvePath, textOf, withSuffix } from './py-path.ts';

const BOARD_ID = /^[A-Z0-9][A-Z0-9-]*$/;
const BOARDS = 'hardware-design/boards';
const NATIVE_EXTENSIONS = ['kicad_pcb', 'kicad_sch', 'kicad_pro'];
const SHARED_SOURCES = ['STATUS', 'REQUIREMENTS', 'INTERFACES', 'CONNECTORS', 'DECISIONS'];
const PACKET_SOURCES = ['STATUS.md', 'DOC-RECONCILIATION.md', 'BOM-VERIFIED.csv', 'SCHEMATIC.md'];
const KICAD_PYTHON_MAC = '/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3';

type Dict = Map<string, unknown>;
interface BoardConfig { folder: string; cfg: Dict; project: string }
interface Blocker { rule: string; path?: string; evidence?: string }

export function sha(path: string): string {
  try {
    return sha256File(path);
  } catch (error) {
    throw osError(error, path);
  }
}

export function boardConfig(root: string, board: string): BoardConfig {
  if (!BOARD_ID.test(board)) throw new PyError('ValueError', 'invalid board ID');
  const folder = joinPath(root, BOARDS, board);
  const cfg = jsonOf(joinPath(folder, 'gate.json'));
  const name = cfg instanceof Map ? cfg.get('project') : null;
  if (!(cfg instanceof Map) || typeof name !== 'string' || !name) throw new PyError('ValueError', 'gate configuration requires a project');
  const project = resolvePath(joinPath(folder, name));
  if (!isInside(project, resolvePath(joinPath(root, BOARDS)))) throw new PyError('ValueError', 'project escapes the board registry tree');
  return { folder, cfg, project };
}

const listOf = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  if (value instanceof Map) return [...value.keys()];
  if (typeof value === 'string') return [...value];
  throw new PyError('TypeError', 'value is not iterable');
};

/** dict(owner=..., directory=..., lifecycle=..., **revision): a repeated keyword is a TypeError, not an overwrite. */
function revisionRow(entry: unknown, revision?: unknown): Dict {
  const row: Dict = new Map([['owner', item(entry, 'id')], ['directory', item(entry, 'directory')], ['lifecycle', get(entry, 'lifecycle')]]);
  for (const [key, value] of (revision as Dict | undefined) ?? []) {
    if (row.has(key)) throw new PyError('TypeError', `dict() got multiple values for keyword argument '${key}'`);
    row.set(key, value);
  }
  return row;
}

export function registryRevision(root: string, board: string): Dict {
  const path = joinPath(root, 'hardware-design/registry/boards.json');
  if (!pathExists(path)) return new Map();
  for (const entry of listOf(get(jsonOf(path), 'boards', []))) {
    for (const revision of listOf(get(entry, 'revisions', []))) {
      if (get(revision, 'gate') === board) return revisionRow(entry, revision);
    }
    if (get(entry, 'id') === board && !truthy(get(entry, 'revisions'))) return revisionRow(entry);
  }
  return new Map();
}

/** The integrated build pipeline of BOARD: the "pipeline" key of its gate.json, when that file exists. */
export function pipeline(root: string, board: string): string | null {
  const path = joinPath(root, BOARDS, board, 'gate.json');
  if (!BOARD_ID.test(board) || !isFile(path)) return null;
  const name = get(jsonOf(path), 'pipeline');
  return typeof name === 'string' && name && isFile(joinPath(root, name)) ? name : null;
}

const after = (text: string, marker: string): string => {
  const at = text.indexOf(marker);
  return at < 0 ? text : text.slice(at + marker.length);
};
const before = (text: string, marker: string): string => {
  const at = text.indexOf(marker);
  return at < 0 ? text : text.slice(0, at);
};
const isFrozen = (focus: string, board: string): boolean =>
  new RegExp(`(?:^|\\n)-\\s+${board}(?:\\s|$)`).test(before(after(focus, '## Frozen'), '\n## '));

/** Old receipts are observations until the gate checks the full dependency closure again: never current from mtime. */
function previousGate(folder: string, blockers: Blocker[]): object | null {
  const latest = joinPath(folder, '.gate/latest.json');
  if (!pathExists(latest)) return null;
  try {
    const evidence = resolvePath(joinPath(folder, '.gate', item(jsonOf(latest), 'run')));
    if (!isRelativeTo(evidence, resolvePath(joinPath(folder, '.gate')))) throw new PyError('ValueError', 'latest gate escapes its evidence directory');
    const report = jsonOf(joinPath(evidence, 'result.json'));
    const gate = {
      evidence, exit: get(report, 'exit'), metrics: get(report, 'metrics'), freshness: 'requires_dependency_verification',
      input_sha256: get(get(report, 'provenance', new Map()), 'input_sha256'),
    };
    if (truthy(get(report, 'exit'))) blockers.push({ rule: 'previous_gate_failed', evidence });
    return gate;
  } catch (error) {
    if (!caught(error, 'OSError', 'ValueError', 'KeyError', 'TypeError')) throw error;
    blockers.push({ rule: 'invalid_latest_gate', evidence: latest });
    return null;
  }
}

function contextSources(root: string, folder: string, focus: string, spec: string): string[] {
  return [
    joinPath(root, 'AGENTS.md'), ...(pathExists(focus) ? [focus] : []), spec, joinPath(folder, 'gate.json'),
    ...SHARED_SOURCES.map(name => joinPath(root, `hardware-design/${name}.md`)),
    ...PACKET_SOURCES.map(name => joinPath(dirname(spec), name)),
  ];
}

function boardCommands(root: string, board: string, manifest: string, reviewed: boolean): object {
  return {
    check: `tools/pcb check ${board} --changed --follow`,
    fresh: `tools/pcb check ${board} --fresh --follow`,
    build: pipeline(root, board) ? `tools/pcb build ${board} --follow` : null,
    edit: `tools/pcb edit ${board} --kind place --spec SPEC.json --follow`,
    route: `tools/pcb route ${board} --spec ROUTES.json --follow`,
    parts: `tools/pcb parts --json status ${board}`,
    part_review: reviewed ? `tools/pcb parts --json verify ${board} --manifest ${manifest}` : null,
    release: `tools/pcb release ${board} --follow`,
  };
}

export function context(rootPath: string, board: string): object {
  const root = resolvePath(rootPath);
  const { folder, cfg, project } = boardConfig(root, board);
  const revision = registryRevision(root, board);
  const focus = joinPath(root, 'FOCUS.md');
  const focusText = pathExists(focus) ? textOf(focus) : '';
  const missing = NATIVE_EXTENSIONS.map(extension => withSuffix(project, `.${extension}`)).filter(path => !isFile(path)).map(path => relativeTo(path, root));
  const blockers: Blocker[] = missing.map(path => ({ rule: 'missing_native_input', path }));
  const gate = previousGate(folder, blockers);
  const spec = joinPath(root, BOARDS, get(revision, 'directory', board), get(revision, 'spec', 'SPEC.md'));
  const sources = contextSources(root, folder, focus, spec);
  const manifestPath = joinPath(root, 'hardware-design/registry/part-reviews', `${board}.json`);
  const manifest = relativeTo(manifestPath, root);
  const reviewed = isFile(manifestPath);
  if (reviewed) sources.push(manifestPath);
  blockers.push(...sources.filter(path => !isFile(path)).map(path => ({ rule: 'missing_context_source', path: relativeTo(path, root) })));
  return {
    schema_version: 1n, board, revision, project: relativeTo(project, root), stage: get(cfg, 'stage', 'G4'),
    frozen: isFrozen(focusText, board), source_of_truth: 'KiCad', configured_checks: get(cfg, 'checks', new Map()), blockers,
    previous_gate: gate,
    engineering: {
      manifest, state: reviewed ? 'requires_native_instance_verification' : 'missing_review', sha256: reviewed ? sha(manifestPath) : null,
      qualified: false, stock_current: false, inspect_command: `tools/pcb parts --json status ${board}`,
    },
    commands: boardCommands(root, board, manifest, reviewed),
    next_action: missing.length ? 'restore missing native inputs'
      : blockers.some(blocker => blocker.rule === 'missing_context_source') ? 'complete missing board packet evidence' : 'run current input checks',
    source_files: sources.map(path => ({ path: relativeTo(path, root), sha256: isFile(path) ? sha(path) : null })),
    focus: focusText,
  };
}

const boardFolders = (directory: string): string[] => {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
};

export function catalog(root: string): object {
  const directory = joinPath(root, BOARDS);
  const names = sorted(boardFolders(directory).filter(name => pathExists(joinPath(directory, name, 'gate.json')))) as string[];
  const boards = names.map(board => ({ board, revision: registryRevision(root, board), build_pipeline: pipeline(root, board) }));
  return { schema_version: 1n, boards };
}

export const pythonNative = (env: NodeJS.ProcessEnv = process.env): string =>
  env.KICAD_PYTHON ?? env.KICAD_PY ?? (process.platform === 'darwin' ? KICAD_PYTHON_MAC : 'python3');

export function operationCommand(root: string, board: string, operation: string, spec?: string | null, kind?: string | null): string[] {
  const { project } = boardConfig(root, board);
  if (operation === 'build') {
    const script = pipeline(root, board);
    if (!script) throw new PyError('ValueError', `no integrated build pipeline for ${board}; use edit/route with an explicit spec`);
    return ['sh', script];
  }
  if (operation !== 'edit' && operation !== 'route') throw new PyError('ValueError', `unknown candidate operation: ${operation}`);
  if (!spec) throw new PyError('ValueError', 'an explicit JSON spec is required');
  const command = operation === 'route' ? 'route' : kind;
  if (command !== 'place' && command !== 'route') throw new PyError('ValueError', 'edit kind must be place or route');
  return [pythonNative(), 'tools/pcbtool.py', command, relativeTo(withSuffix(project, '.kicad_pcb'), root), spec];
}
