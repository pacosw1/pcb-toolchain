// Gate: every connector has port labels on F.SilkS (user rule 2026-09-27).
//
// Label layers: F.SilkS by default. A board's port-labels.json may set "silk_layers" (for example
// ["F.SilkS", "B.SilkS"]) with a "silk_layers_reason" naming the user decision (BASE-PWR-B: D-132, user
// 2026-10-11, port labels may be on the bottom side). A label on any listed layer counts.
//
// A connector is a top-side footprint with reference J*, P* or CN*. Each pad with a net must have its own silk
// text (gr_text, or fp_text user of any footprint) within --dist mm. A text names only its nearest checked pad.
// Each connector also needs a title: a text within --title-dist mm of its pads that is not the only label of a
// pad. References do not count: a text that is the exact reference of a footprint and stands within 5 mm of that
// footprint (anchor or pad). The same text far from that part ("C1" as an RTD lead name) is a label.
//
// Skipped pads: no net, "unconnected-*", NC, CHASSIS or SHIELD nets, NPTH, mounting and shield pads (number empty,
// MP, SH, EP, MH, S<n>, SH<n>). A footprint with no checked pad (a mounting hole with a P reference) is not a port.
//
// Exemptions: <board>/port-labels.json {"exempt": [{"ref", "pads": [..] | "all", "reason"},
// {"ref", "title": true, "reason"}, {"ref", "skip": [..], "reason"}]}. "skip" removes a pad (for example a mounting
// pad with a pin number) before labels are assigned. Each entry needs a reason. An entry that matches no failure
// fails the gate (STALE).
//
//   tools/port_labels.ts BOARD.kicad_pcb [--json] [--dist 4] [--title-dist 8] [--exempt FILE]
// Exit 1 on any failure.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fixed, jsonDumps } from './lib/py-compat.mjs';
import { runMain, UsageError } from './lib/cli.ts';
import { round } from './lib/py-numbers.ts';
import { atom, kids, layerOf, one, parse, pose, type Pose, type SList } from './lib/sexpr.ts';

const CONNECTOR = /^(J|P|CN)\d/;
const SKIP_NUMBER = /^(|MP\d*|SH\d*|EP|MH\d*|S\d*)$/i;
const SKIP_NET = /^(unconnected-.*|\/?NC|\/?N\/C|\/?CHASSIS|\/?SHIELD|\/?SHLD)$/i;
const REFERENCE_NEAR_MM = 5;
const USAGE = 'usage: tools/port_labels.ts BOARD.kicad_pcb [--json] [--dist 4] [--title-dist 8] [--exempt FILE]';

interface Point { x: number; y: number }
/** `net` is null for a pad that needs no label. */
interface Pad extends Point { number: string; net: string | null }
interface Text extends Point { value: string }

export interface Exemption {
  ref: string;
  reason?: unknown;
  pads?: 'all' | (string | number)[];
  title?: boolean;
  skip?: (string | number)[];
}
export interface Limits { dist: number; titleDist: number; silk: ReadonlySet<string> }
export interface LabelReport { connectors: number; pads: number; failures: string[] }

const padKey = (ref: string, number: string) => `${ref}\0${number}`;
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
/** A reason that is present counts, whatever its JSON type; an empty one does not. */
const hasReason = (reason: unknown) => reason !== undefined && String(reason).trim() !== '';

/** Board position of a footprint-local point (KiCad: y down, angle counter-clockwise). */
function toBoard(footprint: Pose, local: Point): Point {
  const a = footprint.angle * (Math.PI / 180);
  return {
    x: round(footprint.x + local.x * Math.cos(a) + local.y * Math.sin(a), 6),
    y: round(footprint.y - local.x * Math.sin(a) + local.y * Math.cos(a), 6),
  };
}

function reference(footprint: SList): string {
  const property = kids(footprint, 'property').find(p => p[1] === 'Reference');
  if (property) return atom(property, 2);
  const text = kids(footprint, 'fp_text').find(t => t[1] === 'reference');
  return text ? atom(text, 2) : '';
}

function connectorPads(footprint: SList, at: Pose): Pad[] {
  return kids(footprint, 'pad').map(pad => {
    const number = atom(pad, 1);
    const net = one(pad, 'net');
    const name = net ? atom(net, -1) : '';
    const skip = pad[2] === 'np_thru_hole' || !name || SKIP_NUMBER.test(number) || SKIP_NET.test(name);
    return { number, net: skip ? null : name, ...toBoard(at, pose(pad)) };
  });
}

function boardItems(source: string, silk: ReadonlySet<string>) {
  const root = parse(source);
  const connectors = new Map<string, Pad[]>();
  const references = new Map<string, Point[]>();
  const texts: Text[] = [];
  for (const footprint of kids(root, 'footprint')) {
    const at = pose(footprint);
    const ref = reference(footprint);
    const points = references.get(ref) ?? [];
    points.push({ x: at.x, y: at.y }, ...kids(footprint, 'pad').map(pad => toBoard(at, pose(pad))));
    references.set(ref, points);
    for (const text of kids(footprint, 'fp_text')) {
      const shown = text[1] === 'user' && silk.has(layerOf(text) ?? '') && !one(text, 'hide');
      if (shown) texts.push({ value: atom(text, 2), ...toBoard(at, pose(text)) });
    }
    if (!CONNECTOR.test(ref) || layerOf(footprint) !== 'F.Cu') continue;
    const pads = connectorPads(footprint, at);
    if (pads.some(pad => pad.net)) connectors.set(ref, pads);
  }
  for (const text of kids(root, 'gr_text')) {
    if (silk.has(layerOf(text) ?? '')) {
      const { x, y } = pose(text);
      texts.push({ value: atom(text, 1), x, y });
    }
  }
  const isReference = (text: Text) =>
    references.get(text.value)?.some(point => distance(point, text) <= REFERENCE_NEAR_MM) ?? false;
  const labels = texts.filter(t => t.value !== '${REFERENCE}' && t.value.trim() && !isReference(t));
  return { connectors, texts: labels };
}

function boxDistance(point: Point, pads: Pad[]): number {
  const xs = pads.map(pad => pad.x);
  const ys = pads.map(pad => pad.y);
  const dx = Math.max(Math.min(...xs) - point.x, point.x - Math.max(...xs), 0);
  const dy = Math.max(Math.min(...ys) - point.y, point.y - Math.max(...ys), 0);
  return Math.hypot(dx, dy);
}

function applySkips(exemptions: Exemption[], connectors: Map<string, Pad[]>): string[] {
  const stale: string[] = [];
  for (const { ref, skip = [] } of exemptions) {
    for (const number of skip) {
      const hits = (connectors.get(ref) ?? []).filter(pad => pad.number === String(number) && pad.net);
      if (!hits.length) stale.push(`STALE exempt ${ref} skip ${number}: no such pad with a net`);
      for (const pad of hits) pad.net = null;
    }
  }
  return stale;
}

/** For each pad key, the indexes of the texts whose nearest checked pad it is. */
function assignLabels(texts: Text[], checked: { ref: string; pad: Pad }[], dist: number): Map<string, number[]> {
  const labels = new Map<string, number[]>();
  texts.forEach((text, index) => {
    let best: { ref: string; pad: Pad } | undefined;
    for (const candidate of checked) {
      if (!best || distance(candidate.pad, text) < distance(best.pad, text)) best = candidate;
    }
    if (!best || distance(best.pad, text) > dist) return;
    const key = padKey(best.ref, best.pad.number);
    labels.set(key, [...labels.get(key) ?? [], index]);
  });
  return labels;
}

interface Missing { ref: string; number: string; net: string | null }

function applyExemptions(exemptions: Exemption[], connectors: Map<string, Pad[]>,
                         missing: Map<string, Missing>, noTitle: Set<string>) {
  const stale: string[] = [];
  const pads = new Set<string>();
  const titles = new Set<string>();
  for (const entry of exemptions) {
    const { ref } = entry;
    const connector = connectors.get(ref);
    if ('skip' in entry) continue;
    if (!connector) {
      stale.push(`STALE exempt ${ref}: no such connector`);
    } else if (entry.title) {
      titles.add(ref);
      if (!noTitle.has(ref)) stale.push(`STALE exempt ${ref} title: the connector has a title`);
    } else if (entry.pads === 'all') {
      const keys = connector.filter(pad => pad.net).map(pad => padKey(ref, pad.number));
      keys.forEach(key => pads.add(key));
      if (!keys.some(key => missing.has(key))) stale.push(`STALE exempt ${ref} all pads: every pad has a label`);
    } else {
      for (const number of entry.pads ?? []) {
        pads.add(padKey(ref, String(number)));
        if (!missing.has(padKey(ref, String(number)))) stale.push(`STALE exempt ${ref} pad ${number}: the pad has a label`);
      }
    }
  }
  return { stale, pads, titles };
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Reference, then pad number with its digit runs compared as numbers. */
function naturalOrder(a: Missing, b: Missing): number {
  const parts = (text: string) => text.split(/(\d+)/);
  const left = parts(a.number);
  const right = parts(b.number);
  const order = compareText(a.ref, b.ref);
  if (order) return order;
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const byValue = i % 2 ? Number(left[i]) - Number(right[i]) : compareText(left[i]!, right[i]!);
    if (byValue) return byValue;
  }
  return left.length - right.length;
}

export function check(source: string, limits: Limits, exemptions: Exemption[] = []): LabelReport {
  const { dist, titleDist, silk } = limits;
  for (const entry of exemptions) {
    if (!hasReason(entry.reason)) throw new Error(`exemption without a reason: ${JSON.stringify(entry)}`);
  }
  const { connectors, texts } = boardItems(source, silk);
  const skipStale = applySkips(exemptions, connectors);
  const checked = [...connectors].flatMap(([ref, pads]) => pads.filter(pad => pad.net).map(pad => ({ ref, pad })));
  const labels = assignLabels(texts, checked, dist);
  const sole = new Set([...labels.values()].filter(list => list.length === 1).map(list => list[0]!));
  const missing = new Map<string, Missing>();
  for (const { ref, pad } of checked) {
    if (!labels.has(padKey(ref, pad.number))) missing.set(padKey(ref, pad.number), { ref, number: pad.number, net: pad.net });
  }
  const noTitle = new Set([...connectors].filter(([, pads]) =>
    !texts.some((text, index) => !sole.has(index) && boxDistance(text, pads) <= titleDist)).map(([ref]) => ref));
  const exempt = applyExemptions(exemptions, connectors, missing, noTitle);
  const layers = [...silk].sort().join('/');
  const padFailures = [...missing].filter(([key]) => !exempt.pads.has(key)).map(([, pad]) => pad).sort(naturalOrder)
    .map(pad => `FAIL ${pad.ref} pad ${pad.number} (${pad.net}): no ${layers} label within ${fixed(dist, 1)} mm`);
  const titleFailures = [...noTitle].filter(ref => !exempt.titles.has(ref)).sort(compareText)
    .map(ref => `FAIL ${ref}: no title text within ${fixed(titleDist, 1)} mm`);
  return {
    connectors: connectors.size,
    pads: checked.length,
    failures: [...padFailures, ...titleFailures, ...skipStale, ...exempt.stale],
  };
}

/** The nearest port-labels.json from the board folder up to the board's own folder under boards/. */
function defaultExemptFile(pcb: string): string | null {
  for (let dir = dirname(resolve(pcb)); ; dir = dirname(dir)) {
    const file = join(dir, 'port-labels.json');
    if (existsSync(file)) return file;
    if (basename(dirname(dir)) === 'boards' || dirname(dir) === dir) return null;
  }
}

interface LabelFile { exempt: Exemption[]; silk_layers?: unknown; silk_layers_reason?: unknown }

function silkLayers(config: LabelFile): Set<string> {
  if (!('silk_layers' in config)) return new Set(['F.SilkS']);
  const layers = config.silk_layers;
  const valid = Array.isArray(layers) && layers.length && layers.every(layer => layer === 'F.SilkS' || layer === 'B.SilkS');
  if (!valid || !hasReason(config.silk_layers_reason)) {
    throw new UsageError('port_labels: silk_layers needs F.SilkS/B.SilkS entries and a silk_layers_reason', 1);
  }
  return new Set(layers as string[]);
}

interface Options { pcb: string; json: boolean; dist: number; titleDist: number; exemptFile: string | null }

function parseArguments(argv: string[]): Options {
  const rest = [...argv];
  const take = (flag: string): string | undefined => {
    const index = rest.indexOf(flag);
    if (index < 0) return undefined;
    const [, value] = rest.splice(index, 2);
    if (value === undefined) throw new UsageError(USAGE, 1);
    return value;
  };
  const number = (flag: string, fallback: number) => {
    const value = take(flag);
    if (value === undefined) return fallback;
    if (!value.trim() || Number.isNaN(Number(value))) throw new UsageError(USAGE, 1);
    return Number(value);
  };
  const dist = number('--dist', 4);
  const titleDist = number('--title-dist', 8);
  const exemptFile = take('--exempt') ?? null;
  const positional = rest.filter(arg => arg !== '--json');
  const [pcb] = positional;
  if (positional.length !== 1 || pcb === undefined) throw new UsageError(USAGE, 1);
  return { pcb, json: rest.includes('--json'), dist, titleDist, exemptFile };
}

function main(argv: string[]): number {
  const options = parseArguments(argv);
  const exemptFile = options.exemptFile ?? defaultExemptFile(options.pcb);
  const config: LabelFile = exemptFile ? JSON.parse(readFileSync(exemptFile, 'utf8')) : { exempt: [] };
  if (!Array.isArray(config.exempt)) throw new Error(`${exemptFile}: no exempt list`);
  const limits = { dist: options.dist, titleDist: options.titleDist, silk: silkLayers(config) };
  const report = check(readFileSync(options.pcb, 'utf8'), limits, config.exempt);
  if (options.json) {
    console.log(jsonDumps({ ...report, exempt_file: exemptFile }, 2));
  } else {
    for (const failure of report.failures) console.log(failure);
    const source = exemptFile ? ` (exempt: ${exemptFile})` : '';
    console.log(`port_labels: ${report.connectors} connectors, ${report.pads} pads, ${report.failures.length} failures${source}`);
  }
  return report.failures.length ? 1 : 0;
}

runMain(import.meta.url, main);
