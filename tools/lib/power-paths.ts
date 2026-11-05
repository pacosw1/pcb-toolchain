// pcbtool paths: the widest copper path between power pads against the design current, and every supply net listed or exempt.
import type { Board } from './board-types.ts';
import { toMm } from './board-types.ts';
import { DEFAULT_RISE_K, VIA_PLATING_MM } from './copper-current.ts';
import { loadPinRatings } from './pin-ratings.ts';
import { netGraph, padNode, pairCapacity, type Conditions, type NetGraph } from './power-graph.ts';
import { fixed, get, item, number, pyRepr, pyStr, sorted, truthy } from './py-compat.mjs';
import { uncoveredSupplies, type ExemptNet } from './supply-nets.ts';

/** Two consecutive pads of a chain and the current between them; `text` is how Python's str prints it. */
export interface PadPair { net: string; from: string; to: string; amps: number; text: string; parallel: boolean }

/** A net has "amps" and "pads", or "chains" of them. */
export function specPairs(nets: Map<string, unknown>): PadPair[] {
  return [...nets].flatMap(([net, entry]) => ((get(entry, 'chains', [entry])) as unknown[]).flatMap(chain => {
    const pads = item(chain, 'pads') as string[];
    const amps = item(chain, 'amps');
    const parallel = truthy(get(chain, 'parallel', get(entry, 'parallel', false)));
    return pads.slice(1).map((to, i) => ({ net, from: pads[i]!, to, amps: number(amps), text: pyStr(amps), parallel }));
  }));
}

/** Copper thickness per layer from the stackup, in mm. */
export function copperThickness(board: Board): Map<string, number> {
  return new Map(board.stackup.filter(layer => layer.kind === 'Copper').map(layer => [layer.layer, toMm(layer.thickness)]));
}

function exemptNets(spec: unknown): ExemptNet[] {
  return (get(spec, 'exempt', []) as unknown[]).map(entry => ({ net: pyStr(get(entry, 'net')), reason: pyStr(get(entry, 'reason', '')) }));
}

function checkPair(pair: PadPair, graph: NetGraph, limit: number, verbose: boolean, print: (line: string) => void): boolean {
  const { net, from, to, text: need, parallel } = pair;
  const missing = [from, to].filter(pad => !graph.pads.has(pad));
  if (missing.length) {
    print(`LOW ${net} ${from}->${to}: pads not on this net: ${pyRepr(missing)}`);
    return false;
  }
  const { amps, items } = pairCapacity(graph.edges, padNode(from), padNode(to), parallel);
  const tag = parallel ? ' (parallel)' : '';
  if (amps >= pair.amps) {
    if (verbose) print(`OK  ${net} ${from}->${to}${tag}: ${amps === Infinity ? 'pour' : `${fixed(amps, 2)} A`} >= ${need} A`);
    return true;
  }
  if (items.length === 0) {
    print(`LOW ${net} ${from}->${to}${tag}: no copper path (need ${need} A)`);
  } else if (parallel) {   // the min cut: these items together carry all the current
    print(`LOW ${net} ${from}->${to}${tag}: ${fixed(amps, 2)} A < ${need} A; ${items.length} cut items: ${items.slice(0, limit).join('; ')}`);
  } else {
    const onPath = new Set(items);
    const thin = sorted(new Set(graph.edges.filter(e => onPath.has(e.label) && e.amps < pair.amps).map(e => e.label))) as string[];
    print(`LOW ${net} ${from}->${to}: ${fixed(amps, 2)} A < ${need} A; ${thin.length} items under: ${thin.slice(0, limit).join('; ')}`);
  }
  return false;
}

export interface PathOptions { limit: number; verbose: boolean; print: (line: string) => void; supplies: () => ReadonlyMap<string, string> }

/** The report of pcbtool paths, and its exit code. The supplies are asked for after the pairs, as a failed export stops only then. */
export function powerPathReport(board: Board, spec: unknown, { limit, verbose, print, supplies }: PathOptions): number {
  const nets = item(spec, 'nets') as Map<string, unknown>;
  const conditions: Conditions = {
    thickness: copperThickness(board), rise: number(get(spec, 'dT', DEFAULT_RISE_K)), plating: number(get(spec, 'via_plating_mm', VIA_PLATING_MM)), ratings: loadPinRatings(),
  };
  const graphs = new Map<string, NetGraph>();
  let low = 0;
  for (const pair of specPairs(nets)) {
    if (!graphs.has(pair.net)) graphs.set(pair.net, netGraph(board, pair.net, conditions));
    if (!checkPair(pair, graphs.get(pair.net)!, limit, verbose, print)) low += 1;
  }
  print(`${low} power-path pairs below the design current`);
  const uncovered = uncoveredSupplies(supplies(), new Set(nets.keys()), exemptNets(spec));
  for (const [net, why] of uncovered) print(`MISSING ${net} (${why}): supply net not in the spec nets or exempt list`);
  print(`${uncovered.length} supply nets not covered`);
  return low || uncovered.length ? 1 : 0;
}
