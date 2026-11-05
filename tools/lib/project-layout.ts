// pcb project-check --layout: does a project's board tree match its registry and the layout of CIP #1332 comment 5278?
// Reads files only: no process, no CAD, no write. A missing value stays a finding: nothing here falls back to a default
// stage, spec name or project. Native ERC/DRC and engineering reviews are other checks.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { validateConfig } from './gate-core.mjs';
import { sha256File } from './json-file.ts';
import { pipeline } from './pcb-workflow.ts';
import { fileRoot } from './project-root.mjs';
import { isDirectory, isFile, isRelativeTo, pathExists, relativeTo, resolvePath } from './py-path.ts';
import { routePlanErrors } from './route-plan-schema.ts';

const BOARD_ID = /^[A-Z0-9][A-Z0-9-]*$(?![\s\S])/;
const BOARDS = 'hardware-design/boards';
const REGISTRY = 'hardware-design/registry/boards.json';
const NOT_BOARDS = new Set(['_art', '.claude']);
const LIFECYCLES = ['active', 'planned', 'historical', 'obsolete'];
const KINDS = ['board', 'variant', 'gate-only'];
const GATE_KEYS = ['about', 'project', 'stage', 'checks', 'release', 'pipeline', 'route_rules', 'route_features', 'plane_via_skip', 'post_verify', 'snapshot_schematic_datasheets', 'isolation_check', 'placement'];
const GATE_STAGES = ['G3', 'G4', 'G5'];
const LAYOUT_STAGES = ['G4', 'G5'];

/**
 * Files a board folder needs, by row. `always` holds at any stage, `layout` from the layout gates on (G4, G5: tools/lib/gate-core.mjs
 * requires DRC there). A planned board only needs more than its SPEC once the registry gives it a gate: conceptual boards get no
 * empty gates or plans. data/ and wip/ are optional in the target layout, so no row names them. Revision SPECs come from the registry.
 */
export const REQUIRED_FILES: Record<string, { always: string[]; layout: string[] }> = {
  'gate-only': { always: ['gate.json'], layout: ['route.json'] },
  'pending-gate-only': { always: ['gate.pending.json'], layout: ['route.json'] },
  active: { always: ['gate.json', 'STATUS.md', 'DOC-RECONCILIATION.md', 'BOM-VERIFIED.csv', 'SCHEMATIC.md', 'reports/'], layout: ['route.json'] },
  'planned-gated': { always: ['gate.json', 'STATUS.md', 'SCHEMATIC.md'], layout: ['DOC-RECONCILIATION.md', 'BOM-VERIFIED.csv', 'reports/', 'route.json'] },
  'planned-pending': { always: ['gate.pending.json', 'STATUS.md', 'SCHEMATIC.md'], layout: ['DOC-RECONCILIATION.md', 'BOM-VERIFIED.csv', 'reports/', 'route.json'] },
  planned: { always: [], layout: [] },
  historical: { always: [], layout: [] },
  obsolete: { always: [], layout: [] },
};

export type Severity = 'error' | 'debt' | 'info';
export interface Finding { type: string; severity: Severity; board: string | null; path?: string; detail: string; [more: string]: unknown }
export interface LayoutBoard { id: string; kind: string | null; lifecycle: string | null; stage: string | null; gate_state: 'active' | 'pending' | null; obsolete: boolean }
export interface LayoutReport {
  schema: 'pcb.project-check.layout.v1'; project: string; mode: 'audit' | 'strict'; boards: LayoutBoard[];
  summary: { boards: number; findings: number; by_type: Record<string, number>; by_severity: Record<string, number>; obsolete: string[] };
  strict?: { board: string; violations: number; pass: boolean };
  findings: Finding[];
}

type Raw = Record<string, unknown>;
interface Entry { raw: Raw; id: string; kind: string | null; lifecycle: string | null; directory: string | null; revisions: Raw[]; pendingGate: string | null }
interface Audit {
  root: string; boards: string; release: Set<string>; toolchain: string; features: Set<string>;
  findings: Map<string, Finding>; toolUsers: Map<string, Set<string>>;
  add(type: string, severity: Severity, board: string | null, path: string | undefined, detail: string, more?: Raw): void;
}

const isObject = (value: unknown): value is Raw => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | null => typeof value === 'string' && value ? value : null;
const exists = (path: string): boolean => { try { lstatSync(path); return true; } catch { return false; } };
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const readJson = (path: string): { value: unknown } | { error: string } => {
  try { return { value: JSON.parse(readFileSync(path, 'utf8')) }; } catch (error) { return { error: message(error) }; }
};

/** The files a project receives from this release: bin/toolchain_sync.mjs copies the same walk. */
function releaseTools(toolchain: string): Set<string> {
  const tools = join(toolchain, 'tools'), found = new Set<string>();
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) { if (!['__pycache__', 'node_modules', 'target'].includes(entry.name)) walk(path); }
      else if (!entry.name.endsWith('.pyc') && !(entry.isSymbolicLink() && isDirectory(path))) found.add(relativeTo(path, tools));
    }
  };
  walk(tools);
  return found;
}

/** The real path of VALUE from BASE, or null when it leaves LIMIT: through "..", a link, an absolute path or an unsafe character. */
function locate(base: string, value: string, limit: string): string | null {
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) return null;
  const path = resolvePath(join(base, value));
  return isRelativeTo(path, limit) ? path : null;
}

function reference(audit: Audit, board: string, from: string, base: string, value: string, type = 'missing_reference', limit = audit.root): void {
  const path = locate(base, value, limit);
  if (!path) { audit.add('path_escape', 'error', board, value, `${from}: ${value} leaves ${limit === audit.root ? 'the project' : BOARDS}`); return; }
  const name = relativeTo(path, audit.root);
  if (name.startsWith('tools/')) {
    const users = audit.toolUsers.get(name) ?? new Set<string>();
    audit.toolUsers.set(name, users.add(board));
    if (audit.release.has(name.slice('tools/'.length))) return;
  }
  if (!isFile(path)) audit.add(type, 'debt', board, name, `${from}: ${name} does not exist`);
}

/** Command text and argv names repository files; {placeholders}, $variables and globs are resolved at run time. */
function commandFiles(value: unknown): string[] {
  const parts = Array.isArray(value) ? value.filter(part => typeof part === 'string') : typeof value === 'string' ? [value] : [];
  return parts.flatMap(part => [...(part as string).matchAll(/(?:^|[\s"'=])((?:tools|hardware-design)\/[^\s"';&|<>()]+)/g)].map(match => match[1]!))
    .filter(name => !/[{}$*]/.test(name));
}

function nativeFiles(audit: Audit, board: string, from: string, project: string, schematicOnly = false): void {
  const stem = relativeTo(project, audit.root);
  const extensions = schematicOnly ? ['kicad_sch', 'kicad_pro'] : ['kicad_sch', 'kicad_pcb', 'kicad_pro'];
  for (const extension of extensions) reference(audit, board, from, audit.root, `${stem}.${extension}`, 'missing_native_file');
  const folder = dirname(project), expand = (value: string): string => value.replaceAll('${KIPRJMOD}', folder).replaceAll('${IOT_LAB}', audit.root);
  const sheets = [`${project}.kicad_sch`], seen = new Set<string>();
  for (let index = 0; index < sheets.length; index++) {
    const sheet = sheets[index]!;
    if (seen.has(sheet) || !isFile(sheet)) continue;
    seen.add(sheet);
    for (const match of readFileSync(sheet, 'utf8').matchAll(/\(property "(?:Sheetfile|Sheet file)" "((?:\\.|[^"\\])*)"/g)) {
      const name = expand(JSON.parse(`"${match[1]}"`) as string), child = resolvePath(name.startsWith('/') ? name : join(dirname(sheet), name));
      if (!isRelativeTo(child, audit.root)) audit.add('path_escape', 'error', board, name, `${from}: sheet of ${relativeTo(sheet, audit.root)} leaves the project`);
      else { if (!isFile(child)) audit.add('missing_native_file', 'debt', board, relativeTo(child, audit.root), `${from}: sheet of ${relativeTo(sheet, audit.root)} does not exist`); sheets.push(child); }
    }
  }
  for (const table of ['sym-lib-table', 'fp-lib-table']) {
    if (!isFile(join(folder, table))) continue;
    for (const match of readFileSync(join(folder, table), 'utf8').matchAll(/\(uri "((?:\\.|[^"\\])*)"/g)) {
      const name = expand(JSON.parse(`"${match[1]}"`) as string);
      if (name.includes('${')) continue;                                    // a KiCad install library
      const path = resolvePath(name.startsWith('/') ? name : join(folder, name));
      if (!isRelativeTo(path, audit.root)) audit.add('path_escape', 'error', board, name, `${from}: ${table} library leaves the project`);
      else if (!pathExists(path)) audit.add('missing_native_file', 'debt', board, relativeTo(path, audit.root), `${from}: ${table} library does not exist`);
    }
  }
}

/** A rule file may name further data files: the same reference rule as tools/lib/gate-inputs.mjs. */
function ruleFiles(audit: Audit, board: string, from: string, folder: string, name: string, project: string | null, seen = new Set<string>()): void {
  reference(audit, board, from, folder, name);
  const path = locate(folder, name, audit.root);
  if (!path || !path.endsWith('.json') || !isFile(path) || seen.has(path)) return;
  seen.add(path);
  const read = readJson(path);
  if ('error' in read) { audit.add('gate_schema', 'debt', board, relativeTo(path, audit.root), `${from}: ${read.error}`); return; }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (isObject(value)) Object.values(value).forEach(visit);
    else if (typeof value === 'string' && !/^[a-z]+:\/\//i.test(value) && !/\s/.test(value) && /\.(?:json|kicad_sch|ibs|pdf)$/.test(value)) {
      const expanded = value.replaceAll('${IOT_LAB}', audit.root).replaceAll('${KIPRJMOD}', project ? dirname(project) : '${KIPRJMOD}');
      if (expanded.includes('${')) return;
      const local = expanded.startsWith(`${audit.root}/`) ? expanded.slice(audit.root.length + 1) : expanded;
      const base = local !== expanded || /^(?:hardware-design|tools)\//.test(local) ? audit.root : dirname(path);
      ruleFiles(audit, board, relativeTo(path, audit.root), base, local, project, seen);
    }
  };
  visit(read.value);
}

function gateSchema(audit: Audit, board: string, name: string, cfg: Raw): void {
  const fail = (detail: string): void => audit.add('gate_schema', 'debt', board, name, detail);
  const stage = cfg.stage;
  if (stage === undefined) audit.add('gate_stage_missing', 'debt', board, name, 'no stage: the stage rows of the required-file matrix are not evaluated');
  const known = typeof stage === 'string' && GATE_STAGES.includes(stage);
  // validateConfig reads a missing stage as G4: which checks a board must run stays open until it declares one.
  for (const error of validateConfig(cfg)) if (known || !(error.startsWith('required check') || (stage === undefined && error.startsWith('unknown gate stage')))) fail(error);
  for (const key of Object.keys(cfg)) if (!GATE_KEYS.includes(key)) fail(`unknown key ${key}`);
  for (const key of ['pipeline', 'route_rules', 'isolation_check', 'placement', 'about']) if (key in cfg && !text(cfg[key])) fail(`${key} must be a non-empty string`);
  if ('snapshot_schematic_datasheets' in cfg && typeof cfg.snapshot_schematic_datasheets !== 'boolean') fail('snapshot_schematic_datasheets must be true or false');
  if ('plane_via_skip' in cfg && !isObject(cfg.plane_via_skip)) fail('plane_via_skip must be an object');
  if ('route_features' in cfg) {
    if (!isObject(cfg.route_features)) fail('route_features must be an object');
    else for (const key of Object.keys(cfg.route_features)) if (!audit.features.has(key)) fail(`route_features: unknown feature ${key}`);
  }
  if ('release' in cfg && !(isObject(cfg.release) && text(cfg.release.maker) && text(cfg.release.fab))) fail('release needs a maker and a fab');
  if ('post_verify' in cfg) {
    const hooks = cfg.post_verify;
    if (!Array.isArray(hooks) || hooks.some(hook => !isObject(hook) || !text(hook.stage) || !Array.isArray(hook.run) || !hook.run.length)) fail('post_verify entries need a stage and a run argv');
  }
}

function gateReferences(audit: Audit, board: string, folder: string, name: string, cfg: Raw, schematicOnly = false): void {
  const project = text(cfg.project) ? locate(folder, cfg.project as string, audit.boards) : null;
  if (text(cfg.project) && !project) audit.add('path_escape', 'error', board, cfg.project as string, `${name}: project leaves ${BOARDS}`);
  if (project) nativeFiles(audit, board, `${name} project`, project, schematicOnly);
  const checks = isObject(cfg.checks) ? cfg.checks : {}, happy = isObject(checks.kicad_happy) ? checks.kicad_happy : {};
  for (const value of [checks.paths, checks.planes, checks.pairs, checks.rf, happy.exempt, happy.return_planes]) {
    if (text(value)) ruleFiles(audit, board, name, folder, value as string, project);
  }
  for (const feature of Object.values(isObject(cfg.route_features) ? cfg.route_features : {})) {
    if (isObject(feature) && text(feature.fast_nets_file)) reference(audit, board, name, folder, feature.fast_nets_file as string);
  }
  const release = isObject(cfg.release) ? cfg.release : {};
  const files = [cfg.pipeline, cfg.route_rules, release.maker, release.check, release.config, ...(Array.isArray(release.inputs) ? release.inputs : [])];
  for (const value of files) if (text(value)) reference(audit, board, name, audit.root, value as string);
  const hooks = [release.pre_checks, release.post_export, cfg.post_verify].flatMap(list => (Array.isArray(list) ? list : []));
  const commands = [cfg.isolation_check, cfg.placement, ...hooks.map(hook => (isObject(hook) ? hook.run : undefined))];
  for (const file of commands.flatMap(commandFiles)) reference(audit, board, name, audit.root, file);
  if (name.endsWith('gate.json') && text(cfg.pipeline) && locate(audit.root, cfg.pipeline as string, audit.root)) {
    try { pipeline(audit.root, board); } catch (error) { audit.add('gate_schema', 'debt', board, name, message(error)); }
  }
}

/** Checks the gate files and route plan of one folder and returns the stage of its gate.json. */
function checkFolder(audit: Audit, board: string, pendingGate: string | null): string | null {
  const folder = join(audit.boards, board);
  let stage: string | null = null;
  for (const file of ['gate.json', 'gate.pending.json']) {
    const name = `${BOARDS}/${board}/${file}`, path = join(folder, file);
    if (!exists(path)) continue;
    const read = readJson(path);
    if ('error' in read) { audit.add('gate_schema', 'debt', board, name, read.error); continue; }
    if (!isObject(read.value)) { audit.add('gate_schema', 'debt', board, name, 'gate configuration must be an object'); continue; }
    gateSchema(audit, board, name, read.value);
    const pending = file === pendingGate && !exists(join(folder, 'gate.json'));
    gateReferences(audit, board, folder, name, read.value, pending && read.value.stage === 'G3');
    if (file === 'gate.json' && typeof read.value.stage === 'string' && GATE_STAGES.includes(read.value.stage)) stage = read.value.stage;
    else if (pending && typeof read.value.stage === 'string' && GATE_STAGES.includes(read.value.stage)) stage = read.value.stage;
  }
  const plan = join(folder, 'route.json'), name = `${BOARDS}/${board}/route.json`;
  if (exists(plan)) {
    const read = readJson(plan);
    if ('error' in read) audit.add('route_schema', 'debt', board, name, read.error);
    else for (const error of routePlanErrors(read.value, audit.features)) audit.add('route_schema', 'debt', board, name, error);
  }
  return stage;
}

/** Validates the registry rows; what is wrong with one row is a finding and the rest of the audit goes on. */
function registryEntries(audit: Audit): Entry[] {
  const read = readJson(join(audit.root, REGISTRY));
  if ('error' in read) { audit.add('registry_schema', 'error', null, REGISTRY, read.error); return []; }
  if (!isObject(read.value) || read.value.schema_version !== 1 || !Array.isArray(read.value.boards)) {
    audit.add('registry_schema', 'error', null, REGISTRY, 'needs schema_version 1 and a boards list');
    if (!isObject(read.value) || !Array.isArray(read.value.boards)) return [];
  }
  const entries = new Map<string, Entry>(), directories = new Set<string>(), gates = new Set<string>();
  const badId = (value: unknown, board: string | null): boolean => {
    if (typeof value === 'string' && BOARD_ID.test(value)) return false;
    if (typeof value === 'string' && /[/\\\0]|^\.\.?$/.test(value)) audit.add('path_escape', 'error', board, value, `board ID ${value} is a path`);
    else audit.add('invalid_board_id', 'error', board, REGISTRY, `invalid board ID ${JSON.stringify(value)}`);
    return true;
  };
  for (const raw of read.value.boards as unknown[]) {
    if (!isObject(raw)) { audit.add('registry_schema', 'error', null, REGISTRY, 'a board entry must be an object'); continue; }
    if (badId(raw.id, null)) continue;
    const id = raw.id as string, fail = (detail: string): void => audit.add('registry_schema', 'error', id, REGISTRY, detail);
    if (entries.has(id)) { audit.add('duplicate_board_id', 'error', id, REGISTRY, `board ID ${id} is registered more than once`); continue; }
    const lifecycle = typeof raw.lifecycle === 'string' && LIFECYCLES.includes(raw.lifecycle) ? raw.lifecycle : null;
    const kind = typeof raw.kind === 'string' && KINDS.includes(raw.kind) ? raw.kind : null;
    if (!lifecycle) fail(`lifecycle must be one of ${LIFECYCLES.join(', ')}`);
    if (!kind) fail(`kind must be one of ${KINDS.join(', ')}`);
    let directory: string | null = null;
    if (raw.directory !== undefined && raw.directory !== null) {
      if (!badId(raw.directory, id) && !locate(audit.boards, raw.directory as string, audit.boards)) audit.add('path_escape', 'error', id, String(raw.directory), `directory ${String(raw.directory)} leaves ${BOARDS}`);
      else if (typeof raw.directory === 'string' && BOARD_ID.test(raw.directory)) {
        directory = raw.directory;
        if (directories.has(directory)) audit.add('duplicate_board_id', 'error', id, directory, `directory ${directory} belongs to more than one board`);
        directories.add(directory);
      }
    } else if (kind !== 'variant') fail('no directory');
    let pendingGate: string | null = null;
    if ('pending_gate' in raw) {
      if (raw.pending_gate !== 'gate.pending.json') fail('pending_gate must be gate.pending.json');
      else if (!directory || !['board', 'gate-only'].includes(kind ?? '')) fail('pending_gate requires a board or gate-only directory');
      else if (lifecycle === 'active') fail('pending_gate cannot classify an active board');
      else {
        pendingGate = raw.pending_gate;
        if (exists(join(audit.boards, directory, 'gate.json'))) fail('pending_gate cannot register an active gate.json');
        reference(audit, id, 'registry pending gate', join(audit.boards, directory), pendingGate, 'missing_required_file', audit.boards);
      }
    }
    const revisions = (Array.isArray(raw.revisions) ? raw.revisions : []).filter(isObject);
    if (kind === 'board' && !revisions.length) fail('board requires explicit revisions');
    for (const revision of revisions) {
      for (const key of ['revision', 'spec', 'state']) if (!text(revision[key])) fail(`revision ${String(revision.revision)} has no ${key}`);
      if (revision.gate === undefined || revision.gate === null || badId(revision.gate, id)) continue;
      if (gates.has(revision.gate as string)) audit.add('duplicate_board_id', 'error', revision.gate as string, REGISTRY, `gate ${String(revision.gate)} belongs to more than one revision`);
      gates.add(revision.gate as string);
    }
    entries.set(id, { raw, id, kind, lifecycle, directory, revisions, pendingGate });
  }
  for (const entry of entries.values()) {
    if (entry.kind === 'gate-only') {
      const owner = entries.get(String(entry.raw.owner));
      const revision = owner?.revisions.find(revision => revision.revision === entry.raw.revision);
      if (owner?.kind !== 'board' || !revision || (entry.pendingGate ? !!text(revision.gate) : revision.gate !== entry.id)) {
        audit.add('registry_schema', 'error', entry.id, REGISTRY, entry.pendingGate
          ? 'a pending gate-only entry must resolve to an owner revision with no active gate'
          : 'a gate-only entry must resolve to an owner revision');
      } else if (entry.pendingGate && entry.directory && owner.directory) {
        const cfg = readJson(join(audit.boards, entry.directory, entry.pendingGate));
        if (!text(revision.project) || ('value' in cfg && isObject(cfg.value) && text(cfg.value.project)
          && locate(join(audit.boards, entry.directory), cfg.value.project as string, audit.boards)
            !== locate(join(audit.boards, owner.directory), revision.project as string, audit.boards))) {
          audit.add('gate_project_mismatch', 'debt', entry.id, `${BOARDS}/${entry.directory}/${entry.pendingGate}`, 'pending gate project is not its owner revision project');
        }
      }
    }
    if (entry.kind === 'variant' && !entries.has(String(entry.raw.variant_of))) audit.add('registry_schema', 'error', entry.id, REGISTRY, 'a variant must resolve to a board');
    if (entry.kind === 'board' && entry.pendingGate && entry.directory) {
      const folder = join(audit.boards, entry.directory), cfg = readJson(join(folder, entry.pendingGate));
      const value = 'value' in cfg && isObject(cfg.value) ? cfg.value : null;
      if (value && !entry.revisions.some(revision => !text(revision.gate) && text(revision.project)
        && text(value.project) && locate(folder, value.project as string, audit.boards) === locate(folder, revision.project as string, audit.boards))) {
        audit.add('gate_project_mismatch', 'debt', entry.id, `${BOARDS}/${entry.directory}/${entry.pendingGate}`, 'pending gate must resolve to a revision with no active gate');
      }
    }
  }
  return [...entries.values()];
}

function boardFolders(audit: Audit, entries: Entry[]): string[] {
  const registered = new Set(entries.flatMap(entry => [entry.directory, ...entry.revisions.map(revision => revision.gate)]).filter(name => typeof name === 'string' && BOARD_ID.test(name)) as string[]);
  let names: { name: string; link: boolean; folder: boolean }[];
  try {
    names = readdirSync(audit.boards, { withFileTypes: true }).map(item => ({ name: item.name, link: item.isSymbolicLink(), folder: item.isDirectory() }));
  } catch (error) {
    audit.add('missing_board_folder', 'error', null, BOARDS, message(error));
    return [];
  }
  // excluded_directories hides a retained draft from the packet check, but it gives the folder no lifecycle: it stays reported here.
  const listed = readJson(join(audit.root, REGISTRY));
  const skipped = 'value' in listed && isObject(listed.value) && Array.isArray(listed.value.excluded_directories) ? listed.value.excluded_directories : [];
  for (const { name, link, folder } of names) {
    if (NOT_BOARDS.has(name) || !(folder || (link && isDirectory(join(audit.boards, name))))) continue;
    if (link && !isRelativeTo(resolvePath(join(audit.boards, name)), audit.boards)) audit.add('path_escape', 'error', name, `${BOARDS}/${name}`, `board folder ${name} links out of ${BOARDS}`);
    if (registered.has(name)) continue;
    const more = skipped.includes(name) ? { registry_excluded: true } : {};
    if (BOARD_ID.test(name)) audit.add('unregistered_board_folder', 'debt', name, `${BOARDS}/${name}`, `${name} has no board entry or revision gate in the registry`, more);
    else audit.add('undeclared_board_folder', 'debt', name, `${BOARDS}/${name}`, `${name} is not a board ID and is not a declared non-board folder`, more);
  }
  for (const name of registered) if (!isDirectory(join(audit.boards, name))) audit.add('missing_board_folder', 'debt', name, `${BOARDS}/${name}`, `registered board folder ${name} does not exist`);
  return [...registered].filter(name => isDirectory(join(audit.boards, name))).sort(compare);
}

/** The row of REQUIRED_FILES for this board and what it asks for; a stage row with no known stage is not evaluated. */
export function requiredFiles(row: string, stage: string | null, perRevisionBom = false): string[] {
  const { always, layout } = REQUIRED_FILES[row]!;
  return [...always, ...(stage && LAYOUT_STAGES.includes(stage) ? layout : [])].filter(file => !(perRevisionBom && file === 'BOM-VERIFIED.csv'));
}

function checkEntry(audit: Audit, entry: Entry, stages: Map<string, string | null>, entries: Entry[]): void {
  if (text(entry.raw.source)) reference(audit, entry.id, 'registry source', audit.boards, entry.raw.source as string, 'missing_required_file', audit.boards);
  if (!entry.directory) return;
  const folder = join(audit.boards, entry.directory), board = entry.id;
  if (!isDirectory(folder)) return;
  const inFolder = (value: unknown, from: string): void => { if (text(value)) reference(audit, board, from, folder, value as string, 'missing_required_file', audit.boards); };
  for (const revision of entry.revisions) {
    const from = `registry revision ${String(revision.revision)}`;
    inFolder(revision.spec, `${from} spec`);
    for (const key of ['bom', 'bom_scope', 'selection']) inFolder(revision[key], `${from} ${key}`);
    if (typeof revision.gate === 'string' && BOARD_ID.test(revision.gate) && isDirectory(join(audit.boards, revision.gate)) && !exists(join(audit.boards, revision.gate, 'gate.json'))) {
      audit.add('missing_required_file', 'debt', revision.gate, `${BOARDS}/${revision.gate}/gate.json`, `${from} names this gate`);
    }
    if (text(revision.project)) {
      const project = locate(folder, revision.project as string, audit.boards);
      if (!project) audit.add('path_escape', 'error', board, revision.project as string, `${from} project leaves ${BOARDS}`);
      else {
        const pending = text(revision.gate) ? undefined : entry.pendingGate ? entry : entries.find(candidate => candidate.pendingGate
          && candidate.kind === 'gate-only' && candidate.raw.owner === entry.id && candidate.raw.revision === revision.revision);
        const pendingFolder = pending?.directory ? join(audit.boards, pending.directory) : null;
        const pendingFile = pendingFolder && pending?.pendingGate ? locate(pendingFolder, pending.pendingGate, audit.boards) : null;
        const pendingConfig = pendingFile && pendingFolder && !exists(join(pendingFolder, 'gate.json')) ? readJson(pendingFile) : null;
        const schematicOnly = !!pendingConfig && 'value' in pendingConfig && isObject(pendingConfig.value)
          && pendingConfig.value.stage === 'G3' && !!pendingFolder && !!text(pendingConfig.value.project)
          && locate(pendingFolder, pendingConfig.value.project as string, audit.boards) === project;
        nativeFiles(audit, board, `${from} project`, project, schematicOnly);
        const gate = text(revision.gate) ? readJson(join(audit.boards, revision.gate as string, 'gate.json')) : null;
        if (gate && 'value' in gate && isObject(gate.value) && text(gate.value.project)
          && locate(join(audit.boards, revision.gate as string), gate.value.project as string, audit.boards) !== project) {
          audit.add('gate_project_mismatch', 'debt', board, `${BOARDS}/${String(revision.gate)}/gate.json`, `gate project ${String(gate.value.project)} is not ${from} project ${String(revision.project)}`);
        }
      }
    }
  }
  if (isObject(entry.raw.variants) && text(entry.raw.variants.file)) inFolder(entry.raw.variants.file, 'registry variants');
  const gated = !entry.pendingGate && (entry.revisions.some(revision => revision.gate === entry.directory) || entry.kind === 'gate-only');
  if (exists(join(folder, 'gate.json')) && !gated) audit.add('unregistered_gate', 'debt', board, `${BOARDS}/${entry.directory}/gate.json`, 'gate.json exists but no registry revision names this gate');
  if (!entry.lifecycle || !entry.kind) return;
  const row = entry.kind === 'gate-only' ? entry.pendingGate ? 'pending-gate-only' : 'gate-only'
    : entry.lifecycle === 'planned' && entry.pendingGate ? 'planned-pending'
    : entry.lifecycle === 'planned' && gated ? 'planned-gated' : entry.lifecycle;
  if (!(row in REQUIRED_FILES)) return;
  const stage = stages.get(entry.directory) ?? null;
  for (const file of requiredFiles(row, stage, entry.raw.bom_policy === 'per-revision')) {
    if (pathExists(join(folder, file))) continue;
    const pending = file === 'gate.json' && exists(join(folder, 'gate.pending.json')) ? '; gate.pending.json is not a registered gate' : '';
    audit.add('missing_required_file', 'debt', board, `${BOARDS}/${entry.directory}/${file}`, `${file} is required for row ${row} at stage ${stage ?? 'unknown'}${pending}`);
  }
}

function shadowedTools(audit: Audit): void {
  if (audit.root === audit.toolchain) return;
  const tools = join(audit.root, 'tools'), listing = join(tools, '.toolchain-files');
  const synced = new Set(isFile(listing) ? readFileSync(listing, 'utf8').split('\n').filter(Boolean) : []);
  for (const name of [...audit.release].sort(compare)) {
    const path = join(tools, name);
    if (synced.has(name) || !exists(path)) continue;
    const identical = isFile(path) && sha256File(path) === sha256File(join(audit.toolchain, 'tools', name));
    const boards = [...audit.toolUsers.get(`tools/${name}`) ?? []].sort(compare);
    audit.add('shadowed_tool', 'error', null, `tools/${name}`, `project file shadows the synced tools/${name}`, { identical, boards });
  }
}

const tally = (values: string[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const value of [...values].sort(compare)) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
};

/** The audit of the project at ROOT. With `strict`, also the verdict on that one board. */
export function auditLayout(rootPath: string, options: { strict?: string; toolchain?: string } = {}): LayoutReport {
  const root = resolvePath(rootPath), toolchain = resolvePath(options.toolchain ?? fileRoot);
  const findings = new Map<string, Finding>();
  const featureFile = readJson(join(toolchain, 'tools/route-features.json'));
  const audit: Audit = {
    root, boards: resolvePath(join(root, BOARDS)), toolchain, release: releaseTools(toolchain), findings, toolUsers: new Map(),
    features: new Set(Object.keys('value' in featureFile && isObject(featureFile.value) && isObject(featureFile.value.features) ? featureFile.value.features : {})),
    add(type, severity, board, path, detail, more = {}) {
      const key = JSON.stringify([type, board, path, type.startsWith('missing_') ? '' : detail]);   // a file is missing once, however many configs name it
      if (!findings.has(key)) findings.set(key, { type, severity, board, ...(path === undefined ? {} : { path }), detail, ...more });
    },
  };
  const entries = registryEntries(audit), stages = new Map<string, string | null>();
  for (const board of boardFolders(audit, entries)) {
    try { stages.set(board, checkFolder(audit, board, entries.find(entry => entry.directory === board)?.pendingGate ?? null)); } catch (error) { audit.add('check_error', 'error', board, `${BOARDS}/${board}`, message(error)); }
  }
  for (const entry of entries) {
    try { checkEntry(audit, entry, stages, entries); } catch (error) { audit.add('check_error', 'error', entry.id, REGISTRY, message(error)); }
  }
  shadowedTools(audit);
  const obsolete = new Set(entries.filter(entry => entry.lifecycle === 'obsolete').map(entry => entry.id));
  const ids = new Set(entries.flatMap(entry => [entry.id, ...entry.revisions.map(revision => revision.gate)]).filter(id => typeof id === 'string') as string[]);
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const boards = [...ids].sort(compare).map(id => {
    const entry = byId.get(id);
    const folder = join(audit.boards, entry?.directory ?? id);
    const gateState: LayoutBoard['gate_state'] = entry?.pendingGate ? 'pending' : exists(join(folder, 'gate.json')) ? 'active' : null;
    return { id, kind: entry?.kind ?? null, lifecycle: entry?.lifecycle ?? null, stage: stages.get(entry?.directory ?? id) ?? null, gate_state: gateState, obsolete: obsolete.has(id) };
  });
  if (options.strict && !ids.has(options.strict)) audit.add('unknown_board', 'error', options.strict, undefined, `${options.strict} is not a registered board`);
  const rows = [...findings.values()].sort((a, b) => compare(a.board ?? '', b.board ?? '') || compare(a.type, b.type) || compare(a.path ?? '', b.path ?? '') || compare(a.detail, b.detail));
  const report: LayoutReport = {
    schema: 'pcb.project-check.layout.v1', project: root, mode: options.strict ? 'strict' : 'audit', boards,
    summary: { boards: boards.length, findings: rows.length, by_type: tally(rows.map(row => row.type)), by_severity: tally(rows.map(row => row.severity)), obsolete: [...obsolete].sort(compare) },
    findings: rows,
  };
  if (options.strict) {
    const board = options.strict;
    const violations = rows.filter(row => row.severity !== 'info' && (row.board === board || (row.boards as string[] | undefined)?.includes(board))).length;
    report.strict = { board, violations, pass: violations === 0 };
  }
  return report;
}
