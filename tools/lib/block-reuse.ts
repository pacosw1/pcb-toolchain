// Read-only retrieval of existing KiCad blocks. It never grants design qualification: a receipt applies only through
// block-qualification.ts.
import { lstatSync, readdirSync } from 'node:fs';
import { basename, dirname, extname } from 'node:path';
import { parseFootprints, validateFacts, type Facts, type Part } from './block-parts.ts';
import { identity } from './fingerprint.ts';
import { readObject, readPyJson, sha256File } from './json-file.ts';
import { compare, jsonDumps, pyStr } from './py-compat.mjs';
import { isDirectory, isFile, isRelativeTo, joinPath, pathExists, relativeTo, resolvePath, textOf } from './py-path.ts';

const BOUND_SUFFIXES = new Set(['.kicad_sch', '.kicad_pcb', '.kicad_pro', '.kicad_dru', '.kicad_sym', '.kicad_mod', '.json']);
const REQUIRED_EXTENSIONS = ['.kicad_sch', '.kicad_pcb', '.kicad_pro'];
const TARGET_CHECKS = [
  'exact parts, pin mapping and footprints',
  'port net mapping, operating limits and ground/isolation domains',
  'stackup, layer mapping, copper thickness and target rules',
  'boundary copper, return paths, keepouts and connector access',
  'native ERC/DRC/parity and applicable board electrical gates',
  'current part availability and attributable validation evidence',
];

export interface BlockPort { name?: unknown; net?: string; limits?: unknown; [key: string]: unknown }

export interface BlockRow {
  schema: 'iot-lab.block-reuse.v1';
  id: string;
  description: unknown;
  keywords: unknown;
  source_directory: string;
  source_sha256: string;
  files: Map<string, string>;
  parts: Part[];
  ports: BlockPort[];
  layout_rules: unknown[];
  declared_level: unknown;
  source_note: unknown;
  declared_gate_notes: unknown;
  open_items: string[];
  facts_errors: string[];
  missing_files: string[];
  qualification: string;
  target_checks_required: string[];
  [key: string]: unknown;
}

export interface TargetPlan {
  block_id?: unknown;
  source_sha256?: unknown;
  target_sha256?: unknown;
  port_map?: unknown;
}

/** Files under `folder` in Path order; a symlink to a folder is not followed, as rglob did not. */
function* filesUnder(folder: string): Generator<string> {
  for (const name of readdirSync(folder).sort(compare)) {
    const path = joinPath(folder, name);
    if (lstatSync(path).isDirectory()) yield* filesUnder(path);
    else if (isFile(path)) yield path;
  }
}

const isBoundFile = (path: string): boolean => {
  const name = basename(path);
  return BOUND_SUFFIXES.has(name.startsWith('.') ? '' : extname(name)) || name.endsWith('lib-table');
};

/** All local CAD, rules, library tables and metadata of a block, not GUI state. */
export function snapshot(directory: string): { digest: string; files: Map<string, string> } {
  const root = resolvePath(directory);
  const files = new Map<string, string>();
  for (const path of filesUnder(root)) {
    if (!isBoundFile(path)) continue;
    if (!isRelativeTo(resolvePath(path), root)) throw new Error(`external block file: ${basename(path)}`);
    files.set(relativeTo(path, root), sha256File(path));
  }
  return { digest: identity(files), files };
}

const sameSnapshot = (a: ReturnType<typeof snapshot>, b: ReturnType<typeof snapshot>): boolean =>
  a.digest === b.digest && jsonDumps(a.files) === jsonDumps(b.files);

const blockId = (directory: string): string => basename(directory).replace(/\.kicad_block$/, '');

export function readBlock(directory: string): BlockRow {
  const before = snapshot(directory);
  const id = blockId(directory);
  const object = (name: string): Facts => {
    const path = joinPath(directory, name);
    return pathExists(path) ? readObject<Facts>(path, `${path}: expected object`) : {};
  };
  const meta = object(`${id}.json`);
  const facts = object('facts.json');
  const pcb = joinPath(directory, `${id}.kicad_pcb`);
  const parts = pathExists(pcb) ? parseFootprints(textOf(pcb)) : [];
  if (!sameSnapshot(snapshot(directory), before)) throw new Error(`${id}: source changed during retrieval; inspect again`);
  return {
    schema: 'iot-lab.block-reuse.v1', id,
    description: meta.description ?? '', keywords: meta.keywords ?? '',
    source_directory: resolvePath(directory), source_sha256: before.digest, files: before.files,
    parts, ports: (facts.ports ?? []) as BlockPort[],
    layout_rules: facts.layout_rules ?? [],
    declared_level: facts.level ?? null,
    source_note: facts.source ?? null, declared_gate_notes: facts.gates ?? null,
    open_items: (facts.open_items ?? []) as string[],
    facts_errors: validateFacts(facts),
    missing_files: REQUIRED_EXTENSIONS.map(extension => id + extension).filter(name => !isFile(joinPath(directory, name))),
    qualification: 'unverified_for_target',
    target_checks_required: [...TARGET_CHECKS],
  };
}

/** Path.glob('*.kicad_block'), which unlike glob.glob also sees dot names. */
export const blockFolders = (library: string): string[] => !isDirectory(library) ? [] :
  readdirSync(library).filter(name => name.endsWith('.kicad_block')).sort(compare).map(name => joinPath(library, name));

export const catalog = (library: string): BlockRow[] => blockFolders(library).map(readBlock);

/** str.casefold for the part names and keywords a query meets. */
const casefold = (text: string): string => text.toUpperCase().toLowerCase();

/** All query tokens must match. Exact part filters narrow discovery, not approval. */
export function find(library: string, query: string, mpn?: string | null, footprint?: string | null) {
  const tokens = [...new Set(casefold(query).match(/[\p{L}\p{N}_]+/gu) ?? [])].sort(compare);
  const results = [];
  for (const row of catalog(library)) {
    if (mpn && !row.parts.some(part => casefold(part.mpn) === casefold(mpn))) continue;
    if (footprint && !row.parts.some(part => part.footprint === footprint)) continue;
    const fields: [string, string][] = [
      ['id', casefold(row.id)], ['description', casefold(pyStr(row.description))], ['keywords', casefold(pyStr(row.keywords))],
      ['parts', casefold(jsonDumps(row.parts))], ['ports', casefold(jsonDumps(row.ports))],
    ];
    const matches = new Map(tokens.map(token => [token, fields.filter(([, text]) => text.includes(token)).map(([name]) => name)]));
    if ([...matches.values()].every(names => names.length)) {
      const { id, description, declared_level, source_sha256, qualification, open_items, missing_files } = row;
      results.push({ id, description, declared_level, source_sha256, qualification, open_items, missing_files, matches });
    }
  }
  return results;
}

export function reuse(library: string, id: string, expectedSha256?: string | null): BlockRow {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('invalid block ID');
  const path = joinPath(library, `${id}.kicad_block`);
  if (!isDirectory(path)) throw new Error(`unknown block: ${id}`);
  const row = readBlock(path);
  if (expectedSha256 && row.source_sha256 !== expectedSha256) throw new Error('stale block: source fingerprint changed; inspect again');
  return row;
}

function targetInputs(manifest: string): Map<string, string> {
  const spec = readPyJson<{ inputs?: unknown } | null>(manifest);
  const names = spec !== null && typeof spec === 'object' && !Array.isArray(spec) ? spec.inputs : undefined;
  if (!Array.isArray(names) || !names.length) throw new Error('target manifest requires a nonempty inputs list');
  const inputs = new Map<string, string>();
  for (const name of names) {
    if (typeof name !== 'string' || !name) throw new Error('target input paths must be nonempty strings');
    inputs.set(name, sha256File(resolvePath(joinPath(dirname(manifest), name))));
  }
  inputs.set('$manifest', sha256File(manifest));
  return inputs;
}

function checkedPortMap(mapping: TargetPlan, names: string[]): Map<string, string | null> {
  const given = mapping.port_map;
  if (given === null || typeof given !== 'object' || Array.isArray(given)) throw new Error('port map must cover exactly the block ports');
  const ports = new Map(given instanceof Map ? given : Object.entries(given)) as Map<string, unknown>;
  if (ports.size !== names.length || names.some(name => !ports.has(name))) throw new Error('port map must cover exactly the block ports');
  for (const value of ports.values()) {
    if (value !== null && (typeof value !== 'string' || !value.trim())) throw new Error('port destinations must be nonempty net names or null');
  }
  return ports as Map<string, string | null>;
}

/**
 * Bind explicit target inputs and a port mapping without granting CAD approval. `target` is a JSON file listing paths
 * relative to itself; callers choose the dependency closure. `mapping` is a prior plan whose fingerprints must match.
 */
export function targetPlan(library: string, id: string, target: string, mapping?: TargetPlan | null) {
  const manifest = resolvePath(target);
  const inputs = targetInputs(manifest);
  const digest = identity(inputs);
  const row = reuse(library, id);
  const names = row.ports.map(port => port.name);
  if (names.some(name => typeof name !== 'string' || !name) || new Set(names).size !== names.length) {
    throw new Error('block ports require unique nonempty names');
  }
  let ports = new Map<string, string | null>((names as string[]).map(name => [name, null]));
  if (mapping !== null && mapping !== undefined) {
    if (mapping.block_id !== id || mapping.source_sha256 !== row.source_sha256 || mapping.target_sha256 !== digest) {
      throw new Error('stale reuse plan: block or target inputs changed');
    }
    ports = checkedPortMap(mapping, names as string[]);
  }
  return {
    schema: 'iot-lab.target-reuse-plan.v1', block_id: id,
    source_sha256: row.source_sha256, target_manifest: manifest,
    target_sha256: digest, target_inputs: inputs, port_map: ports,
    unmapped_ports: [...ports].filter(([, net]) => net === null).map(([name]) => name),
    qualification: 'unverified_for_target',
    missing_block_files: row.missing_files, facts_errors: row.facts_errors,
    open_items: row.open_items, target_checks_required: row.target_checks_required,
  };
}
