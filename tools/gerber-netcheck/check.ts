import { openZip, readEntry } from '../lib/zip-read.mjs';
import { iter, parseXml } from '../lib/xml-read.mjs';
import { toMm, type BoardDocument } from '../lib/board-types.ts';
import { excellonHoles, layerGeometry } from './parse.ts';
import type { CheckInput, Pad, Report } from './types.ts';

const LAYERS = ['F_Cu', 'In1_Cu', 'In2_Cu', 'In3_Cu', 'In4_Cu', 'B_Cu'];
const padKey = (ref: string, pin: string): string => JSON.stringify([ref, pin]);

export function expectedNets(xml: string): Map<string, string> {
  const nets = new Map<string, string>();
  for (const net of iter(parseXml(xml), 'net')) {
    const name = net.attributes.get('name');
    if (name === undefined) throw new Error('schematic net has no name');
    for (const node of iter(net, 'node')) {
      const ref = node.attributes.get('ref');
      const pin = node.attributes.get('pin');
      if (ref === undefined || pin === undefined) throw new Error('schematic node has no ref or pin');
      nets.set(padKey(ref, pin), name);
    }
  }
  return nets;
}

/** Only the positions and copper layer membership of numbered pads are read from the board. Nets come from the schematic. */
export function boardPads(document: BoardDocument, nets: Map<string, string>): Pad[] {
  const copper = new Set(document.board.copper_layers);
  return document.board.footprints.flatMap(fp => fp.pads.filter(p => p.number).map(p => ({
    ref: fp.reference, pin: p.number, x: toMm(p.position.x), y: -toMm(p.position.y),
    layers: p.layers.filter(layer => copper.has(layer)), net: nets.get(padKey(fp.reference, p.number)) ?? null,
  })));
}

/** Read archive entries directly. There is no extraction directory and no ZIP path can write outside one. */
export async function checkInput(archive: Buffer, name: string, document: BoardDocument, xml: string): Promise<CheckInput> {
  const zip = openZip(archive);
  const member = (name: string, required = true): string | undefined => {
    const entries = zip.entries.filter(e => e.filename === name);
    if (!entries.length && !required) return undefined;
    if (entries.length !== 1) throw new Error(`need one Gerber ZIP entry ${name}; got ${entries.length}`);
    return readEntry(zip, entries[0]).toString('utf8');
  };
  const layers: CheckInput['layers'] = [];
  for (const layer of LAYERS) {
    const source = member(`${name}-${layer}.gbr`, false);
    if (source === undefined) continue;
    layers.push({ name: layer.replace('_', '.'), operations: await layerGeometry(source) });
  }
  if (!layers.length) throw new Error('Gerber ZIP has no copper layers');
  return { layers, holes: excellonHoles(member(`${name}-PTH.drl`)!), pads: boardPads(document, expectedNets(xml)) };
}

export function reportLines(board: string, report: Report): string[] {
  const opens = Object.entries(report.opens);
  return [
    ...report.layers.map(layer => `${layer.name.replace('.', '_')}: ${layer.pieces} copper pieces`),
    `gerber_netcheck ${board}: ${report.pads} pads, ${report.holes} plated holes, ${report.nets} nets (${report.nets_checked} with 2+ pads); OPEN ${opens.length}, SHORT ${report.shorts.length}, MISSING ${report.missing.length}`,
    ...opens.slice(0, 20).map(([net, groups]) => `  OPEN ${net}: ${groups.map(pins => pins.slice(0, 6).join(', ')).join(' | ')}`),
    ...report.shorts.slice(0, 20).map(short => '  SHORT ' + Object.entries(short).map(([net, pins]) => `${net} (${pins.slice(0, 3).join(', ')})`).join(' + ')),
    ...report.missing.slice(0, 20).map(pin => `  MISSING copper under pad ${pin}`),
  ];
}
