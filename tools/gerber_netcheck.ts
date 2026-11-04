// Bare-board netlist test from the fab files: rebuild the copper connectivity from the Gerbers and drill files that go to
// JLC, and compare it with the schematic netlist (opens and shorts), without KiCad's copper or net labels.
//
//   tools/gerber_netcheck.ts <BOARD> [--pads PADS.json]
//
// 1. Copper: each copper Gerber of <board>/cad/fab/<BOARD>-gerber.zip (F, In1..In4, B; env GNC_ZIP tests another zip) is
//    drawn from its flashes, lines, arcs and regions. The X2 net/pad attributes (.N, .P) in the files are NOT used.
// 2. Holes: the plated drill file (holes and G85 slots) joins the copper of all layers it passes through; a copper piece
//    takes part in a hole when it touches the hole ring (the hole circle grown by 0.05 mm).
// 3. Expected nets: `kicad-cli sch export netlist` (schematic: ref.pin -> net). Pad positions and pad layers come from the
//    board file, as a point per pad; that is the only board data used. --pads gives them as a JSON list of
//    {ref, pin, x, y, layers}, y up in mm; without it the KiCad python reads them, the one Python left here until
//    the pads come through the KiCad IPC API.
// 4. Result: each net with two or more pads must have all its pads in one copper piece (else OPEN), and no copper piece
//    may hold pads of two nets (else SHORT). Pads with no copper under them are listed (MISSING).
// Exit 1 on any OPEN, SHORT or MISSING.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parseFlags, runMain, UsageError } from './lib/cli.ts';
import { CopperLayer, Outline, UnionFind, type Xy } from './lib/copper-graph.ts';
import { kiCadPaths } from './lib/env-paths.mjs';
import { capsule, circle, HOLE_QUADRANT_SEGMENTS, parseCopper, parseDrill, type Hole } from './lib/gerber.ts';
import { readJson } from './lib/json-file.ts';
import { projectRoot } from './lib/project-root.mjs';
import { openZip, readEntry } from './lib/zip-read.mjs';

const USAGE = 'usage: tools/gerber_netcheck.ts <BOARD> [--pads PADS.json]';
const LAYERS = ['F_Cu', 'In1_Cu', 'In2_Cu', 'In3_Cu', 'In4_Cu', 'B_Cu'];
const HOLE_RING_MM = 0.05;
const SHOWN = 20;

const PAD_DUMP = `
import json, sys, pcbnew
b = pcbnew.LoadBoard(sys.argv[1]); T = pcbnew.ToMM
out = []
for f in b.GetFootprints():
    for p in f.Pads():
        if not p.GetNumber():
            continue
        lays = [b.GetLayerName(l) for l in p.GetLayerSet().CuStack()]
        q = p.GetPosition()
        out.append({'ref': f.GetReference(), 'pin': p.GetNumber(), 'x': T(q.x), 'y': -T(q.y), 'layers': lays,
                    'tht': p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH})
json.dump(out, open(sys.argv[2], 'w'))
`;

export interface Pad { ref: string; pin: string; x: number; y: number; layers: string[] }
/** Net name by `pinKey`. */
export type PinNets = Map<string, string>;
export interface NamedLayer { name: string; copper: CopperLayer }

const pinKey = (ref: string, pin: string) => `${ref}\0${pin}`;
const kicadLayer = (name: string) => name.replace('_', '.');

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const xmlText = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, entity: string) => {
  if (entity.startsWith('#x') || entity.startsWith('#X')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
  if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)));
  return XML_ENTITIES[entity] ?? whole;
});
const xmlAttribute = (tag: string, name: string) => {
  const value = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
  return value === undefined ? undefined : xmlText(value);
};

/** ref.pin -> net of a kicadxml netlist. */
export function parseNetlist(xml: string): PinNets {
  const nets: PinNets = new Map();
  for (const [, head, body] of xml.matchAll(/<net(\s[^>]*)>(.*?)<\/net>/gs)) {
    const name = xmlAttribute(head!, 'name');
    for (const [node] of body!.matchAll(/<node\s[^>]*>/g)) {
      const ref = xmlAttribute(node, 'ref');
      const pin = xmlAttribute(node, 'pin');
      if (name !== undefined && ref !== undefined && pin !== undefined) nets.set(pinKey(ref, pin), name);
    }
  }
  return nets;
}

/** All copper pieces of the board, numbered across layers, joined by the plated holes and the pads. */
class Connectivity {
  readonly groups = new UnionFind();
  private readonly layers: { name: string; copper: CopperLayer; first: number }[] = [];

  constructor(layers: NamedLayer[]) {
    let first = 0;
    for (const layer of layers) {
      this.layers.push({ ...layer, first });
      first += layer.copper.pieces;
    }
  }

  private joinAll(pieces: number[]): void {
    for (const piece of pieces.slice(1)) this.groups.union(pieces[0]!, piece);
  }

  addHole({ x1, y1, x2, y2, diameter }: Hole): void {
    const ring = new Outline(capsule([x1, y1], [x2, y2], diameter / 2 + HOLE_RING_MM, HOLE_QUADRANT_SEGMENTS));
    this.joinAll(this.layers.flatMap(({ copper, first }) => copper.piecesHit(ring).map(piece => first + piece)));
  }

  /** The first piece under the pad, or null. */
  addPad(pad: Pad): number | null {
    const point: Xy = [pad.x, pad.y];
    const pieces = this.layers.filter(({ name }) => pad.layers.includes(kicadLayer(name)))
      .flatMap(({ copper, first }) => copper.piecesAt(point).map(piece => first + piece));
    this.joinAll(pieces);
    return pieces[0] ?? null;
  }
}

/** The report lines and whether the board fails. */
export function check(board: string, layers: NamedLayer[], holes: Hole[], pads: Pad[], pinNets: PinNets): { lines: string[]; failed: boolean } {
  const connectivity = new Connectivity(layers);
  holes.forEach(hole => connectivity.addHole(hole));
  const missing: string[] = [];
  const padPieces = new Map<string, { label: string; net: string | undefined; piece: number }>();
  for (const pad of pads) {
    const key = pinKey(pad.ref, pad.pin);
    const net = pinNets.get(key);
    const piece = connectivity.addPad(pad);
    if (piece === null) missing.push(`${pad.ref}.${pad.pin} (${net ?? 'None'})`);
    else padPieces.set(key, { label: `${pad.ref}.${pad.pin}`, net, piece });
  }
  const netsOfPiece = new Map<number, Map<string, string[]>>();
  for (const { label, net, piece } of padPieces.values()) {
    if (net === undefined || net.startsWith('unconnected-')) continue;
    const root = connectivity.groups.find(piece);
    const nets = netsOfPiece.get(root) ?? new Map<string, string[]>();
    netsOfPiece.set(root, nets);
    nets.set(net, [...nets.get(net) ?? [], label]);
  }
  const shorts = [...netsOfPiece.values()].filter(nets => nets.size > 1);
  const piecesOfNet = new Map<string, string[][]>();
  for (const nets of netsOfPiece.values()) {
    for (const [net, pins] of nets) piecesOfNet.set(net, [...piecesOfNet.get(net) ?? [], pins]);
  }
  const opens = [...piecesOfNet].filter(([, pieces]) => pieces.length > 1);
  const checked = [...piecesOfNet.values()].filter(pieces => pieces.flat().length > 1).length;
  const lines = [
    `gerber_netcheck ${board}: ${pads.length} pads, ${holes.length} plated holes, ${piecesOfNet.size} nets `
      + `(${checked} with 2+ pads); OPEN ${opens.length}, SHORT ${shorts.length}, MISSING ${missing.length}`,
    ...opens.slice(0, SHOWN).map(([net, pieces]) => `  OPEN ${net}: ${pieces.map(pins => pins.slice(0, 6).join(', ')).join(' | ')}`),
    ...shorts.slice(0, SHOWN).map(nets => `  SHORT ${[...nets].map(([net, pins]) => `${net} (${pins.slice(0, 3).join(', ')})`).join(' + ')}`),
    ...missing.slice(0, SHOWN).map(pad => `  MISSING copper under pad ${pad}`),
  ];
  return { lines, failed: Boolean(opens.length || shorts.length || missing.length) };
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed (exit ${result.status})`);
}

function readPads(option: string | undefined, pcb: string, folder: string): Pad[] {
  if (option) return readJson<Pad[]>(option);
  const python = process.env.KICAD_PYTHON ?? process.env.KICAD_PY ?? kiCadPaths(process.platform, homedir(), process.env).kicadPython;
  const output = join(folder, 'pads.json');
  run(python, ['-c', PAD_DUMP, pcb, output]);
  return readJson<Pad[]>(output);
}

function readSchematicNets(schematic: string, folder: string): PinNets {
  const { kicadCli } = kiCadPaths(process.platform, homedir(), process.env);
  const output = join(folder, 'net.xml');
  run(kicadCli, ['sch', 'export', 'netlist', '--format', 'kicadxml', '-o', output, schematic]);
  return parseNetlist(readFileSync(output, 'utf8'));
}

function zipFiles(path: string): Map<string, Buffer> {
  const zip = openZip(readFileSync(path));
  return new Map(zip.entries.map(entry => [entry.filename, readEntry(zip, entry)]));
}

function main(argv: string[]): number {
  const { values, positionals } = parseFlags(argv, { pads: { type: 'string' } }, USAGE);
  const [board] = positionals;
  if (positionals.length !== 1 || board === undefined) throw new UsageError(USAGE, 1);
  const folder = join(projectRoot(), 'hardware-design', 'boards', board);
  const stem = join(folder, readJson<{ project: string }>(join(folder, 'gate.json')).project);
  const name = basename(stem);
  const files = zipFiles(process.env.GNC_ZIP || join(folder, 'cad', 'fab', `${name}-gerber.zip`));
  const scratch = mkdtempSync(join(tmpdir(), 'gnc-'));
  try {
    const pinNets = readSchematicNets(`${stem}.kicad_sch`, scratch);
    const pads = readPads(values.pads, `${stem}.kicad_pcb`, scratch);
    const layers: NamedLayer[] = [];
    for (const layer of LAYERS) {
      const file = files.get(`${name}-${layer}.gbr`);
      if (!file) continue;
      const copper = new CopperLayer(parseCopper(file.toString('utf8')));
      layers.push({ name: layer, copper });
      console.log(`${layer}: ${copper.pieces} copper pieces`);
    }
    const drill = files.get(`${name}-PTH.drl`);
    if (!drill) throw new Error(`${name}-PTH.drl is not in the zip`);
    const { lines, failed } = check(board, layers, parseDrill(drill.toString('utf8')), pads, pinNets);
    for (const line of lines) console.log(line);
    return failed ? 1 : 0;
  } catch (error) {
    throw new UsageError(`FAIL gerber_netcheck ${board}: ${(error as Error).message}`, 1);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

runMain(import.meta.url, main);
