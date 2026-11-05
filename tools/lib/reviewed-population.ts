/** Reconstruct a limited native identity/net population from an API-supplied snapshot.
 * This is partial evidence, never a reviewed-manifest authorization. */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {readPopulation, parseNative, children, single, properties, sha256} from './kicad-population.mjs';
import type {Tree} from './kicad-population.mjs';

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
  const forms = new Map<string, Tree>();
  for (const form of children(board, 'footprint')) {
    const ref = properties(form).Reference;
    if (!ref || forms.has(ref)) throw new Error('duplicate PCB reference');
    forms.set(ref, form);
  }
  const parts: Record<string, {required: boolean; mpn: string; lcsc: string; footprint: string; pad_net_map: Record<string, string>}> = {};
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
      mpn: symbol.mpn, lcsc: symbol.lcsc, footprint: symbol.footprint, pad_net_map: Object.fromEntries(nets)}});
  }
  for (const key of keys) {
    if (sha256(readFileSync(resolve(root, key))) !== actual[key]) throw new Error('snapshot changed during reconstruction');
  }
  return {scope: 'partial_native_population', verified_review: false, source_hashes: actual, parts};
}
