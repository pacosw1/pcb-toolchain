// The pure part of block membership: the schematic, the assignment, the match with a reference, the tighten of one block.
// membership.ts has the rules and the command line.
import { fixed, Float } from '../lib/py-compat.mjs';
import { hypot } from '../lib/py-math.ts';
import { round } from '../lib/py-numbers.ts';
import { atom, forms, kids, one, pose, type SExpr, type SList } from '../lib/sexpr.ts';

const PASSIVE = ['R', 'C', 'L', 'FB', 'D', 'Y'];
export const CONNECTOR = ['J', 'P', 'CN'];
const GROUND = ['GND'];
const RAIL_DEG = 6;      // a net on more parts is a rail: only a part with no signal net (a decap) ties through rails
const TIGHT_GAP = 0.25;  // mm courtyard to courtyard inside a block (D-040 passive class is 0.5 between units)

export type Box = [number, number, number, number];
export interface SchematicPart { group: string | null; desc: string; xy: [number, number] }
export interface Members { blocks: Map<string, string[]>; components: Map<string, string[]>; why: Map<string, string> }
export type Pads = Map<string, string[]>;
type Sheet = Map<string, { group?: string | null; desc?: string }>;

export const prefix = (ref: string): string => /^[A-Za-z_]+/.exec(ref)?.[0] ?? '';

/** The order of references: letters, then the number by value, then the rest. */
export function compareRefs(a: string, b: string): number {
  const parts = (ref: string): [string, number, string] => {
    const match = /^([A-Za-z_]+)(\d*)(.*)$/.exec(ref);
    if (!match) throw new Error(`bad reference ${ref}`);
    return [match[1]!, Number(match[2] || 0), match[3]!];
  };
  const [x, y] = [parts(a), parts(b)];
  return compareText(x[0], y[0]) || x[1] - y[1] || compareText(x[2], y[2]);
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const natural = (refs: Iterable<string>): string[] => [...refs].sort(compareRefs);
const plainSort = (refs: Iterable<string>): string[] => [...refs].sort(compareText);

const holds = (node: SExpr, form: string, value: string): boolean =>
  Array.isArray(node) && ((node[0] === form && node[1] === value) || node.some(child => holds(child, form, value)));

/** Each placed symbol (power symbols skipped) with its group, and the section titles (bold texts) by y. */
export function parseSchematic(source: string): { parts: Map<string, SchematicPart>; titles: [number, string][] } {
  const root = forms(source)[0] as SList;
  const titles: [number, string][] = kids(root, 'text').filter(t => one(t, 'at') && holds(t, 'bold', 'yes')).map(t => [pose(t).y, atom(t, 1)]);
  titles.sort((a, b) => a[0] - b[0] || compareText(a[1], b[1]));
  const parts = new Map<string, SchematicPart>();
  for (const symbol of kids(root, 'symbol')) {
    if (atom(one(symbol, 'lib_id') ?? ['lib_id', ''], 1).startsWith('power:')) continue;
    const props = new Map(kids(symbol, 'property').map(p => [atom(p, 1), atom(p, 2)]));
    const ref = props.get('Reference') ?? '';
    if (!ref || ref.startsWith('#')) continue;
    const { x, y } = pose(symbol);
    parts.set(ref, { group: props.get('Group') ?? null, desc: props.get('Description') ?? '', xy: [x, y] });
  }
  for (const part of parts.values()) {
    part.group ||= titles.filter(([y]) => y <= part.xy[1]).at(-1)?.[1] ?? 'board';
  }
  return { parts, titles };
}

/** True when `desc` names `ref` as a whole reference. */
const names = (desc: string, ref: string): boolean => new RegExp(`(?<![A-Za-z0-9])${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`).test(desc);

/** Which nets of each part count: not the ground, not an unconnected pad. How many parts each is on. */
function netSets(pads: Pads, ground: string[]) {
  const nets = new Map([...pads].map(([r, ns]) => [r, new Set(ns.filter(n => n && !ground.includes(n) && !n.startsWith('unconnected-')))]));
  const deg = new Map<string, number>();
  for (const set of nets.values()) for (const n of set) deg.set(n, (deg.get(n) ?? 0) + 1);
  return { nets, deg };
}

export function derive(sch: Sheet, pads: Pads, ground = GROUND): Members {
  const { nets, deg } = netSets(pads, ground);
  const desc = (r: string): string => sch.get(r)?.desc ?? '';
  const group = new Map([...pads.keys()].map(r => [r, sch.get(r)?.group || 'board']));
  const refs = [...pads.keys()];
  const anchors = plainSort(refs.filter(r => prefix(r) === 'U' && pads.get(r)!.length > 3));
  const block = new Map(anchors.map(a => [a, a]));
  const why = new Map(anchors.map(a => [a, 'anchor']));
  const indicator = new Set(plainSort(refs.filter(r => prefix(r) === 'D' && /\bLED\b/.test(desc(r)))));
  for (const r of indicator) why.set(r, 'indicator LED (not a datasheet part of an IC)');
  let free = plainSort(refs.filter(r => !block.has(r) && PASSIVE.includes(prefix(r)) && !indicator.has(r)));
  const signal = new Map(refs.map(r => [r, new Set([...nets.get(r)!].filter(n => deg.get(n)! <= RAIL_DEG))]));
  // 1. the Description names one IC of the same group; a part that names a connector and no IC is connector support
  const connectors = refs.filter(r => CONNECTOR.includes(prefix(r)));
  for (const r of [...free]) {
    const named = anchors.filter(a => group.get(a) === group.get(r) && names(desc(r), a));
    if (!named.length && connectors.some(j => group.get(j) === group.get(r) && names(desc(r), j))) {
      why.set(r, 'connector support (Description names a connector)');
      free = free.filter(x => x !== r);
    } else if (named.length === 1) {
      block.set(r, named[0]!);
      why.set(r, `description names ${named[0]}`);
      free = free.filter(x => x !== r);
    }
  }
  // 2. greedy net affinity, strongest first
  for (;;) {
    let best: { score: number; size: number; anchor: string; ref: string } | null = null;
    for (const r of free) {
      const ties = new Map<string, number>();
      const own = signal.get(r)!.size ? signal.get(r)! : nets.get(r)!;   // a part with a signal net ties through it only
      for (const [m, a] of block) {
        if (group.get(m) !== group.get(r)) continue;
        for (const n of plainSort(own)) if (nets.get(m)!.has(n)) ties.set(a, (ties.get(a) ?? 0) + 1 / Math.max(deg.get(n)! - 1, 1));
      }
      for (const [anchor, score] of ties) {
        const size = pads.get(anchor)!.length;
        if (!best || score > best.score || (score === best.score && (size > best.size || (size === best.size && anchor > best.anchor)))) best = { score, size, anchor, ref: r };
      }
    }
    if (!best) break;
    block.set(best.ref, best.anchor);
    why.set(best.ref, `net affinity ${fixed(best.score, 3)} to ${best.anchor}`);
    free = free.filter(x => x !== best!.ref);
  }
  const grouped = new Map<string, string[]>();
  for (const r of plainSort(block.keys())) grouped.set(block.get(r)!, [...(grouped.get(block.get(r)!) ?? []), r]);
  const blocks = new Map([...grouped].filter(([, m]) => m.length >= 2).map(([a, m]) => [a, natural(m)]));
  const inBlock = new Set([...blocks.values()].flat());
  const comps = new Map<string, string[]>();
  const add = (g: string, member: string) => comps.set(g, [...(comps.get(g) ?? []), member]);
  for (const [name, m] of blocks) add(group.get(m[0]!)!, name);
  for (const r of natural(refs)) {
    if (!inBlock.has(r) && !/^H\d+$/.test(r) && prefix(r) !== 'TP') {
      add(group.get(r)!, r);
      if (!why.has(r)) why.set(r, 'loose (no block)');
    }
  }
  return { blocks, components: new Map([...comps].filter(([, m]) => m.length >= 2)), why };
}

/**
 * Part-level agreement of two block memberships: for each reference block the derived block with the largest overlap, Jaccard per
 * block, and the share of reference block parts that the best derived block holds.
 */
export function match(derived: Map<string, string[]>, reference: Map<string, string[]>) {
  const rows = [];
  let hit = 0, total = 0;
  for (const name of plainSort(reference.keys())) {
    const wanted = new Set(reference.get(name)!);
    const common = (refs: string[]): string[] => [...new Set(refs)].filter(r => wanted.has(r));
    let best: [string | null, string[]] = [null, []];
    for (const row of derived) if (best[0] === null || common(row[1]).length > common(best[1]).length) best = row;
    const found = new Set(best[1]), inter = common(best[1]);
    const union = new Set([...wanted, ...found]).size;
    rows.push({ reference: name, derived: best[0], jaccard: new Float(best[0] === null ? 0 : round(inter.length / union, 3)), common: inter.length,
      missing: natural([...wanted].filter(r => !found.has(r))), extra: natural([...found].filter(r => !wanted.has(r))) });
    hit += inter.length;
    total += wanted.size;
  }
  return { parts_in_best_block: hit, reference_parts: total, share: new Float(round(hit / Math.max(total, 1), 3)), blocks: rows };
}

const overlap = (a: Box, b: Box, gap: number): boolean => a[0] < b[2] + gap && b[0] < a[2] + gap && a[1] < b[3] + gap && b[1] < a[3] + gap;
export const shift = (r: Box, dx: number, dy: number): Box => [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy];
const centre = (r: Box): [number, number] => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];

/**
 * Each part, nearest first, moves toward the anchor centre along its own centre line (same side of the IC, same turn: the datasheet
 * topology stays), to the smallest t in (0, 1] (t = 1: no move) where its rect keeps `gap` to the anchor and to the parts placed
 * before it, and `inside(rect)` is true. Returns the shifts.
 */
export function tightenBlock(anchor: Box, parts: Map<string, Box>, inside: (r: Box) => boolean, gap = TIGHT_GAP, steps = 20): Map<string, [number, number]> {
  const [cx, cy] = centre(anchor);
  const distance = (r: Box): number => hypot(centre(r)[0] - cx, centre(r)[1] - cy);
  const order = [...parts.keys()].sort((a, b) => distance(parts.get(a)!) - distance(parts.get(b)!) || compareText(a, b));
  const placed = [anchor];
  const out = new Map<string, [number, number]>();
  for (const ref of order) {
    const rect = parts.get(ref)!;
    const [vx, vy] = [centre(rect)[0] - cx, centre(rect)[1] - cy];
    let best: [number, number] = [0, 0];
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const [dx, dy] = [(t - 1) * vx, (t - 1) * vy];
      const moved = shift(rect, dx, dy);
      if (inside(moved) && !placed.some(p => overlap(moved, p, gap))) {
        best = [dx, dy];
        break;
      }
    }
    out.set(ref, best);
    placed.push(shift(rect, ...best));
  }
  return out;
}
