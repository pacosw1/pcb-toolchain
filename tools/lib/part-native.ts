// Read installed KiCad part identities without changing CAD or loading pcbnew.
//
// Uses the strict population parser of kicad-population.mjs, including hierarchical instance resolution. Pad angles
// follow the block_bindings local-angle convention. The hashes here are stored in reviewed manifests, so their input
// text (Decimal normal form, sorted compact JSON) must stay what the Python reader produced.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Decimal } from './decimal.ts';
import { children, parseNative, readPopulation, sha256, single as onlyChild, type NativeFootprint, type NativeSymbol, type Population, type Tree } from './kicad-population.mjs';
import { compare, item, jsonCanonical, jsonLoads, osError, PyError } from './py-compat.mjs';
import { isFile, joinPath, relativeTo, resolvePath } from './py-path.ts';

const BOARD_ID = /^[A-Z0-9][A-Z0-9-]*$/;
const GRAPHICS = new Set(['fp_line', 'fp_rect', 'fp_circle', 'fp_arc', 'fp_poly', 'zone']);
const VOLATILE = new Set(['uuid', 'tstamp']);
const PAD_NOT_SHAPE = new Set(['net', 'uuid', 'tstamp', 'pinfunction', 'pintype']);
const MAX_INHERITANCE = 64;
const FULL_TURN = Decimal.of('360');
const POPULATION_READER = join(dirname(fileURLToPath(import.meta.url)), 'kicad-population.mjs');

export interface Pin { name: string; type: string }
export interface Blocker { code: string; reference?: string; detail: string }

export interface PartFacts extends NativeSymbol {
  pcb_path: string;
  symbol_sha256: string;
  pin_map: Map<string, Pin>;
  footprint_sha256: string;
  land_geometry_sha256: string;
  pad_net_map: Map<string, string>;
  pad_numbers: string[];
  required: boolean;
  pose: Tree;
}

export interface NativeBoard {
  board: string;
  project: string;
  parts: Map<string, PartFacts>;
  blockers: Blocker[];
  native_inputs: Record<string, string>;
  reader_inputs: Record<string, string>;
}

const valueError = (message: string) => new PyError('ValueError', message);
const isList = (node: unknown): node is Tree => Array.isArray(node);
const head = (node: unknown): unknown => (isList(node) ? node[0] : undefined);

export const encoded = (value: unknown): Buffer => Buffer.from(jsonCanonical(value, { ascii: false }));
export const digest = sha256;
const byEncoded = <T>(values: T[]): T[] =>
  values.map(value => ({ value, key: encoded(value) })).sort((a, b) => Buffer.compare(a.key, b.key)).map(entry => entry.value);
const sortedEntries = <T>(map: Map<string, T>): Map<string, T> => new Map([...map].sort(([a], [b]) => compare(a, b)));

function single(node: Tree, name: string): Tree | undefined {
  const values = children(node, name);
  if (values.length > 1) throw valueError(`ambiguous native field: ${name}`);
  return values[0];
}

export function properties(node: Tree): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const property of children(node, 'property')) {
    const name = property[1] as string;
    if (property.length < 3 || result.has(name)) throw valueError('duplicate/malformed native property');
    result.set(name, property[2]);
  }
  return result;
}

/** The file of a repository-relative evidence path, which must stay inside `root`. */
export function owned(root: string, name: unknown): string {
  if (typeof name !== 'string' || name.startsWith('/') || name.includes('\\') || name.split('/').some(part => ['', '.', '..'].includes(part))) {
    throw valueError('expected repository-relative evidence path');
  }
  const path = resolvePath(joinPath(root, name));
  relativeTo(path, resolvePath(root));
  if (!isFile(path)) throw valueError(`missing evidence file: ${name}`);
  return path;
}

function canonicalNumber(text: string): string {
  const value = Decimal.parse(text);
  if (value === null) throw valueError('nonfinite native geometry');
  return value.isZero ? '0' : value.normalize().toString();
}

/** A tree with its timestamps gone and every atom that reads as a number in one form. */
function normalized(node: string | Tree): string | Tree {
  if (isList(node)) return node.filter(child => !VOLATILE.has(head(child) as string)).map(normalized);
  try {
    return canonicalNumber(node);
  } catch {
    return node;
  }
}

/** The pad angle relative to the footprint, so that a rotated part keeps its identity. */
function padAt(at: Tree, rotation: Decimal): Tree {
  const angle = at.length === 4 ? Decimal.of(at[3] as string) : Decimal.of('0');
  const local = angle.sub(rotation).add(FULL_TURN).mod(FULL_TURN);
  return ['at', canonicalNumber(at[1] as string), canonicalNumber(at[2] as string), canonicalNumber(local.toString())];
}

function padShape(pad: Tree, rotation: Decimal): Tree {
  const shape: Tree = [];
  for (const part of pad.slice(2)) {
    if (!isList(part)) shape.push(part);
    else if (part[0] === 'at') shape.push(padAt(part, rotation));
    else if (!PAD_NOT_SHAPE.has(part[0] as string)) shape.push(normalized(part));
  }
  return shape;
}

function pads(form: Tree): { geometry: { number: string; definition: Tree }[]; nets: Map<string, string> } {
  const at = single(form, 'at');
  const rotation = at && at.length > 3 ? Decimal.of(at[3] as string) : Decimal.of('0');
  const geometry: { number: string; definition: Tree }[] = [];
  const nets = new Map<string, string>();
  for (const pad of children(form, 'pad')) {
    if (pad.length < 4) throw valueError('malformed native pad');
    const number = pad[1] as string;
    if (!number && pad[2] !== 'np_thru_hole') throw valueError('unnumbered electrical pad requires explicit native support');
    const net = single(pad, 'net');
    const netName = net ? net.at(-1) as string : '';
    if (/^\p{Nd}+$/u.test(netName)) throw valueError('legacy numeric pad net requires normalization');
    if (number && nets.has(number) && nets.get(number) !== netName) throw valueError('duplicate pad number has inconsistent nets');
    if (number) nets.set(number, netName);
    geometry.push({ number, definition: padShape(pad, rotation) });
  }
  if (!geometry.length) throw valueError('native footprint has no pads');
  return { geometry: byEncoded(geometry), nets: sortedEntries(nets) };
}

/** The embedded symbol and the symbols it extends, parents first. */
function resolveLibrary(libraries: Map<string, Tree>, identifier: string, visiting: string[] = []): Tree[] {
  if (visiting.includes(identifier) || visiting.length >= MAX_INHERITANCE) throw valueError('cyclic/excessive native symbol inheritance');
  const node = libraries.get(identifier);
  if (!node) throw valueError(`embedded symbol definition missing: ${identifier}`);
  const parent = single(node, 'extends');
  if (!parent) return [node];
  const name = parent[1] as string;
  const library = identifier.slice(0, identifier.lastIndexOf(':'));
  const qualified = identifier.includes(':') && !name.includes(':') ? `${library}:${name}` : name;
  const candidates = [...new Set([name, qualified])].filter(key => libraries.has(key));
  if (candidates.length !== 1) throw valueError('ambiguous/missing embedded parent symbol');
  return [...resolveLibrary(libraries, candidates[0] as string, [...visiting, identifier]), node];
}

function symbolPins(definitions: Tree[], unit: number): Map<string, Pin> {
  const pins = new Map<string, Pin>();
  const visit = (node: Tree, parentActive: boolean): void => {
    let active = parentActive;
    if (node[0] === 'symbol' && node.length > 1) {
      const match = /_(\d+)_(\d+)$/.exec(node[1] as string);
      if (match) {
        if (![0, 1].includes(Number(match[2]))) throw valueError('alternate symbol body requires explicit native support');
        active = [0, unit].includes(Number(match[1]));
      }
    }
    if (node[0] === 'pin' && active) addPin(pins, node);
    for (const child of node.slice(1)) if (isList(child) && child.length) visit(child, active);
  };
  for (const definition of definitions) visit(definition, true);
  if (!pins.size) throw valueError('native symbol has no selected unit pins');
  return pins;
}

function addPin(pins: Map<string, Pin>, node: Tree): void {
  const number = single(node, 'number');
  const name = single(node, 'name');
  if (!number || !name) throw valueError('native symbol pin number/name missing');
  const value: Pin = { name: name[1] as string, type: node[1] as string };
  const key = number[1] as string;
  const known = pins.get(key);
  if (known && (known.name !== value.name || known.type !== value.type)) throw valueError('ambiguous inherited symbol pin definition');
  pins.set(key, value);
}

interface Schematic { rootUuid: string; libraries: Tree; placed: Tree[] }
interface Native extends Population { schematics: Map<string, Schematic>; pcb: Tree[] }

function readNative(root: string, project: string): Native {
  try {
    const population = readPopulation(root, project);
    const schematics = new Map<string, Schematic>();
    let pcb: Tree[] = [];
    for (const file of Object.keys(population.sources)) {
      const tree = parseNative(readFileSync(`${root}/${file}`, 'utf8'));
      if (file.endsWith('.kicad_sch')) {
        schematics.set(file, {
          rootUuid: onlyChild(tree, 'uuid')?.[1] as string, libraries: onlyChild(tree, 'lib_symbols') ?? ['lib_symbols'],
          placed: children(tree, 'symbol'),
        });
      } else pcb = children(tree, 'footprint');
    }
    return { ...population, schematics, pcb };
  } catch (error) {
    throw valueError(`native population reader failed: ${(error as Error).message}`);
  }
}

/** The unit of a placed symbol for this instance, or null when it is another reference or sheet. */
function placedUnit(placed: Tree, ref: string, projectName: string, context: string, primaryUuid: string): number | null {
  const instances = single(placed, 'instances');
  if (!instances) {
    const own = properties(placed).get('Reference') === ref && single(placed, 'uuid')?.[1] === primaryUuid;
    return own ? Number((single(placed, 'unit') as Tree)[1]) : null;
  }
  let unit: number | null = null;
  for (const project of children(instances, 'project').filter(p => p[1] === projectName)) {
    for (const instance of children(project, 'path')) {
      if (instance[1] === context && single(instance, 'reference')?.[1] === ref) {
        unit = Number((single(instance, 'unit') as Tree)[1]);
      }
    }
  }
  return unit;
}

interface SymbolBinding { pins: Map<string, Pin>; assets: { unit: number; definitions: Tree[] }[]; uuids: string[] }

function bindSymbol(native: Native, ref: string, projectName: string, context: string, primaryUuid: string): SymbolBinding {
  const binding: SymbolBinding = { pins: new Map(), assets: [], uuids: [] };
  for (const schematic of native.schematics.values()) {
    const libraries = new Map(children(schematic.libraries, 'symbol').map(form => [form[1] as string, form]));
    for (const placed of schematic.placed) {
      const unit = placedUnit(placed, ref, projectName, context, primaryUuid);
      if (unit === null) continue;
      const definitions = resolveLibrary(libraries, (single(placed, 'lib_id') as Tree)[1] as string);
      binding.uuids.push((single(placed, 'uuid')?.[1] ?? '') as string);
      for (const [number, value] of symbolPins(definitions, unit)) {
        const known = binding.pins.get(number);
        if (known && (known.name !== value.name || known.type !== value.type)) throw valueError(`inconsistent multi-unit native pin: ${ref}`);
        binding.pins.set(number, value);
      }
      binding.assets.push({ unit, definitions });
    }
  }
  return binding;
}

function identityBlockers(ref: string, symbol: NativeSymbol, footprint: NativeFootprint): Blocker[] {
  const blockers: Blocker[] = [];
  for (const field of ['mpn', 'lcsc', 'footprint', 'dnp'] as const) {
    if (symbol[field] !== footprint[field]) blockers.push({ code: 'native_identity_mismatch', reference: ref, detail: `schematic/PCB differs: ${field}` });
  }
  if (symbol.in_bom === footprint.excluded) blockers.push({ code: 'native_identity_mismatch', reference: ref, detail: 'schematic/PCB BOM inclusion differs' });
  return blockers;
}

/** Installed package identity is independent of translation, rotation and net assignment. */
function partFacts(metadata: NativeSymbol, form: Tree, path: string, binding: SymbolBinding): PartFacts {
  const { geometry, nets } = pads(form);
  const graphics = form.slice(2).filter(child => isList(child) && GRAPHICS.has(child[0] as string));
  const packageIdentity = { identifier: form[1], pads: geometry, graphics: normalized(graphics) };
  return {
    ...metadata, pcb_path: path, symbol_sha256: digest(encoded(byEncoded(binding.assets))), pin_map: sortedEntries(binding.pins),
    footprint_sha256: digest(encoded(packageIdentity)), land_geometry_sha256: digest(encoded(geometry)), pad_net_map: nets,
    pad_numbers: [...nets.keys()], required: metadata.in_bom && !metadata.dnp, pose: (single(form, 'at') ?? ['at']).slice(1),
  };
}

function readerInputs(): Record<string, string> {
  const files = [POPULATION_READER, resolvePath(fileURLToPath(import.meta.url)), resolvePath(process.execPath)];
  return Object.fromEntries(files.map(file => [file, digest(readBytes(file))]));
}

function readBytes(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    throw osError(error, path);
  }
}

export function readBoard(rootPath: string, board: unknown): NativeBoard {
  const root = resolvePath(rootPath);
  if (typeof board !== 'string' || !BOARD_ID.test(board)) throw valueError('expected configured board ID');
  const configName = `hardware-design/boards/${board}/gate.json`;
  const configPath = owned(root, configName);
  const configBytes = readBytes(configPath);
  const stem = resolvePath(joinPath(dirname(configPath), item(jsonLoads(configBytes), 'project')));
  const project = relativeTo(stem, root);
  if (!project.startsWith(`hardware-design/boards/${board}/`)) throw valueError('native project escapes board owner');
  const native = readNative(root, project);
  const rootUuid = (native.schematics.get(`${project}.kicad_sch`) as Schematic).rootUuid;
  const projectName = stem.slice(stem.lastIndexOf('/') + 1);
  const byReference = new Map(native.pcb.map(form => [properties(form).get('Reference') as string, form]));
  const facts = new Map<string, PartFacts>();
  const blockers: Blocker[] = [];
  for (const [ref, footprint] of native.footprints) {
    if (!native.symbols.has(ref) && !(footprint.board_only && footprint.excluded)) {
      blockers.push({ code: 'native_unmatched_footprint', reference: ref, detail: 'PCB reference has no schematic identity and is not excluded board-only mechanics' });
    }
  }
  for (const [ref, metadata] of sortedEntries(native.symbols)) {
    if (!metadata.on_board || !metadata.footprint) continue;
    const form = byReference.get(ref);
    if (!form) {
      blockers.push({ code: 'native_missing_footprint', reference: ref, detail: 'physical schematic reference missing from PCB' });
      continue;
    }
    const footprint = native.footprints.get(ref) as NativeFootprint;
    blockers.push(...identityBlockers(ref, metadata, footprint));
    const path = footprint.path || '';
    const slash = path.lastIndexOf('/');
    const context = slash < 0 ? '' : path.slice(0, slash);
    const primaryUuid = path.slice(slash + 1);
    const expected = context.startsWith(`/${rootUuid}`) ? context : `/${rootUuid}${context}`;
    const binding = bindSymbol(native, ref, projectName, expected, primaryUuid);
    if (!binding.assets.length || !binding.uuids.includes(primaryUuid)) {
      blockers.push({ code: 'native_symbol_binding', reference: ref, detail: 'PCB path does not identify a schematic instance' });
      continue;
    }
    facts.set(ref, partFacts(metadata, form, path, binding));
  }
  const inputs: Record<string, string> = { [configName]: digest(configBytes), ...native.sources };
  for (const [file, expected] of Object.entries(inputs)) {
    if (digest(readBytes(owned(root, file))) !== expected) throw valueError(`native source changed during inspection: ${file}`);
  }
  return { board, project, parts: facts, blockers, native_inputs: inputs, reader_inputs: readerInputs() };
}
