/** Reconstruct a limited native identity/net population from an API-supplied snapshot.
 * This is partial evidence, never a reviewed-manifest authorization. */
import {readFileSync} from 'node:fs';
import {basename, resolve} from 'node:path';
import {readPopulation, parseNative, children, single, properties, sha256} from './kicad-population.mjs';
import type {Tree} from './kicad-population.mjs';
import {footprintHashes, symbolHash} from './reviewed-native-hashes.ts';
import {reconstructGeometry} from './reviewed-native-geometry.ts';

export function reconstructSnapshot(root: string, project: string, expected: Record<string, string>) {
  const population = readPopulation(root, project);
  const actual = population.sources;
  const keys = Object.keys(actual).sort();
  if (JSON.stringify(keys) !== JSON.stringify(Object.keys(expected).sort()) ||
      keys.some(key => actual[key] !== expected[key])) throw new Error('snapshot sources differ from API-provided identities');
  const boardPath = project + '.kicad_pcb';
  const boardBytes = readFileSync(resolve(root, boardPath));
  if (sha256(boardBytes) !== actual[boardPath]) throw new Error('snapshot PCB changed during read');
  const board = parseNative(boardBytes.toString());
  const schematicTrees = keys.filter(key => key.endsWith('.kicad_sch'))
    .map(key => ({key, tree: parseNative(readFileSync(resolve(root, key)).toString())}));
  const primary = schematicTrees.find(s => s.key === project + '.kicad_sch');
  const rootUuid = primary && single(primary.tree, 'uuid')?.[1];
  if (typeof rootUuid !== 'string' || !rootUuid) throw new Error('native schematic root UUID missing');
  const forms = new Map<string, Tree>();
  for (const form of children(board, 'footprint')) {
    const ref = properties(form).Reference;
    if (!ref || forms.has(ref)) throw new Error('duplicate PCB reference');
    forms.set(ref, form);
  }
  const parts: Record<string, {required: boolean; mpn: string; lcsc: string; footprint: string;
    pad_net_map: Record<string, string>; pin_map: Record<string, {name: string; type: string}>;
    symbol_sha256: string; footprint_sha256: string; land_geometry_sha256: string}> = {};
  for (const [ref, fp] of population.footprints) {
    if (!population.symbols.has(ref) && !(fp.board_only && fp.excluded)) throw new Error(`unmatched footprint ${ref}`);
  }
  for (const [ref, symbol] of population.symbols) {
    if (!symbol.on_board || !symbol.footprint) continue;
    const fp = population.footprints.get(ref);
    const form = forms.get(ref);
    if (!fp || !form) throw new Error(`missing footprint ${ref}`);
    if (symbol.mpn !== fp.mpn || symbol.lcsc !== fp.lcsc || symbol.footprint !== fp.footprint ||
        symbol.dnp !== fp.dnp || symbol.in_bom === fp.excluded) throw new Error(`schematic/PCB identity mismatch ${ref}`);
    if (!fp.path) throw new Error(`native symbol path missing ${ref}`);
    const slash = fp.path.lastIndexOf('/');
    const context = fp.path.slice(0, slash);
    const primaryUuid = fp.path.slice(slash + 1);
    const instanceContext = context.startsWith('/' + rootUuid) ? context : '/' + rootUuid + context;
    let matched = 0;
    const pins = new Map<string, {name: string; type: string}>();
    const assets: {unit:number; definitions:Tree[]}[] = [];
    for (const {key, tree} of schematicTrees) {
      for (const placed of children(tree, 'symbol')) {
        const instances = single(placed, 'instances');
        let unit: string | Tree | undefined;
        if (instances) {
          const projects = children(instances, 'project').filter(p => p[1] === basename(project));
          const paths = projects.flatMap(p => children(p, 'path')).filter(entry =>
            entry[1] === instanceContext && single(entry, 'reference')?.[1] === ref);
          if (paths.length > 1) throw new Error(`ambiguous schematic instance ${ref}`);
          if (paths.length === 1) unit = single(paths[0], 'unit')?.[1];
        } else if (key === project + '.kicad_sch' && properties(placed).Reference === ref &&
                   single(placed, 'uuid')?.[1] === primaryUuid) {
          unit = single(placed, 'unit')?.[1];
        }
        if (unit === undefined) continue;
        if (typeof unit !== 'string' || !/^[1-9]\d*$/.test(unit)) throw new Error(`invalid symbol unit ${ref}`);
        const selectedUnit = unit;
        if (single(placed, 'uuid')?.[1] === primaryUuid) matched++;
        const libraries = single(tree, 'lib_symbols');
        if (!libraries) throw new Error(`embedded symbol definitions missing ${ref}`);
        const definitions = new Map(children(libraries, 'symbol').map(definition => [definition[1], definition]));
        const libId = single(placed, 'lib_id')?.[1];
        if (typeof libId !== 'string') throw new Error(`symbol library ID missing ${ref}`);
        const resolveDefinition = (id: string, stack: string[] = []): Tree[] => {
          if (stack.includes(id) || stack.length >= 64) throw new Error(`cyclic symbol inheritance ${ref}`);
          const definition = definitions.get(id);
          if (!definition) throw new Error(`embedded symbol missing ${ref}`);
          const parent = single(definition, 'extends')?.[1];
          if (parent === undefined) return [definition];
          if (typeof parent !== 'string') throw new Error(`invalid symbol inheritance ${ref}`);
          const qualified = id.includes(':') && !parent.includes(':') ? id.slice(0,id.lastIndexOf(':')+1) + parent : parent;
          const candidates = [...new Set([parent,qualified].filter(name => definitions.has(name)))];
          if (candidates.length !== 1) throw new Error(`ambiguous symbol parent ${ref}`);
          return [...resolveDefinition(candidates[0], [...stack,id]), definition];
        };
        const visit = (node: Tree, active = true): void => {
          if (node[0] === 'symbol' && typeof node[1] === 'string') {
            const suffix = /_(\d+)_(\d+)$/.exec(node[1]);
            if (suffix) {
              if (!['0','1'].includes(suffix[2])) throw new Error(`alternate symbol body unsupported ${ref}`);
              active = ['0',selectedUnit].includes(suffix[1]);
            }
          }
          if (node[0] === 'pin' && active) {
            const number = single(node, 'number')?.[1], name = single(node, 'name')?.[1], type = node[1];
            if (typeof number !== 'string' || typeof name !== 'string' || typeof type !== 'string') throw new Error(`invalid symbol pin ${ref}`);
            const previous = pins.get(number);
            if (previous && (previous.name !== name || previous.type !== type)) throw new Error(`ambiguous symbol pin ${ref}`);
            pins.set(number, {name,type});
          }
          for (const child of node.slice(1)) if (Array.isArray(child)) visit(child, active);
        };
        const selected = resolveDefinition(libId);
        for (const definition of selected) visit(definition);
        assets.push({unit:Number(selectedUnit), definitions:selected});
      }
    }
    if (matched !== 1) throw new Error(`native PCB path does not bind a schematic instance ${ref}`);
    if (!pins.size) throw new Error(`native symbol has no pins ${ref}`);
    const nets = new Map<string, string>();
    for (const pad of children(form, 'pad')) {
      const number = pad[1];
      if (typeof number !== 'string' || (number === '' && pad[2] !== 'np_thru_hole')) throw new Error(`invalid pad ${ref}`);
      const net = single(pad, 'net');
      const name = net?.at(-1) ?? '';
      if (typeof name !== 'string' || /^\d+$/.test(name)) throw new Error(`unsupported pad net ${ref}`);
      if (number && nets.has(number) && nets.get(number) !== name) throw new Error(`inconsistent duplicate pad ${ref}`);
      if (number) nets.set(number, name);
    }
    if (!children(form, 'pad').length) throw new Error(`native footprint has no pads ${ref}`);
    Object.defineProperty(parts, ref, {enumerable: true, value: {required: symbol.in_bom && !symbol.dnp,
      mpn: symbol.mpn, lcsc: symbol.lcsc, footprint: symbol.footprint, pad_net_map: Object.fromEntries(nets),
      pin_map: Object.fromEntries(pins), symbol_sha256:symbolHash(assets), ...footprintHashes(form)}});
  }
  for (const key of keys) {
    if (sha256(readFileSync(resolve(root, key))) !== actual[key]) throw new Error('snapshot changed during reconstruction');
  }
  return {scope: 'partial_native_population', verified_review: false, source_hashes: actual, parts,
    geometry: reconstructGeometry(boardBytes.toString())};
}

/** Compare reviewed native declarations against independently read snapshot facts.
 * Evidence documents, ranges, budgets and constraint geometry require additional checks. */
export function compareNativeManifest(manifest: unknown, population: ReturnType<typeof reconstructSnapshot>): void {
  function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected reviewed object');
    return value as Record<string, unknown>;
  }
  function canonical(value: unknown): string {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') {
      const o = object(value);
      return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
    }
    return JSON.stringify(value);
  }
  const parts = object(manifest).parts;
  if (!Array.isArray(parts) || !parts.length) throw new Error('reviewed parts missing');
  const seen = new Set<string>();
  for (const value of parts) {
    const part = object(value);
    if ('profile' in part) throw new Error('reviewed profiles unsupported');
    const ref = part.reference;
    if (typeof ref !== 'string' || !ref || seen.has(ref) || !Object.hasOwn(population.parts,ref)) throw new Error('duplicate or absent native reference');
    seen.add(ref);
    const actual = population.parts[ref], native = object(part.native);
    if (typeof part.mpn !== 'string' || !part.mpn || part.mpn.trim() !== part.mpn ||
        typeof part.lcsc !== 'string' || !/^C[0-9]+$/.test(part.lcsc) ||
        part.mpn !== actual.mpn || part.lcsc !== actual.lcsc) throw new Error(`native part identity differs ${ref}`);
    for (const key of ['symbol_sha256','pin_map','footprint','footprint_sha256','land_geometry_sha256','pad_net_map'] as const) {
      if (!(key in native) || canonical(native[key]) !== canonical(actual[key])) throw new Error(`native ${key} differs ${ref}`);
    }
    if (Object.values(actual.pin_map).some(pin => pin.type === 'unspecified')) throw new Error(`unspecified electrical pin ${ref}`);
    const mechanical = native.non_electrical_pads;
    if (!Array.isArray(mechanical) || mechanical.some(v => typeof v !== 'string') || new Set(mechanical).size !== mechanical.length) throw new Error(`invalid mechanical pads ${ref}`);
    const pinNumbers = new Set(Object.keys(actual.pin_map));
    const padNumbers = new Set(Object.keys(actual.pad_net_map));
    if (mechanical.some(n => pinNumbers.has(n)) || canonical([...new Set([...pinNumbers,...mechanical])].sort()) !== canonical([...padNumbers].sort())) {
      throw new Error(`native pin/pad coverage differs ${ref}`);
    }
  }
  for (const [ref, part] of Object.entries(population.parts)) {
    if (part.required && !seen.has(ref)) throw new Error(`required native part lacks review ${ref}`);
  }
}
