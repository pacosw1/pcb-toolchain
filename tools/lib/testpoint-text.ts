// The KiCad text of a test point: its footprint for the board, its symbol for the schematic. Used by tools/add_testpoints.ts.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { formEnd, quoted } from './board-edit.ts';
import { toMm, type Pt } from './board-types.ts';
import { fixed } from './py-compat.mjs';
import { round, roundWhole } from './py-numbers.ts';
import { atom, kids, layerOf, one, parse } from './sexpr.ts';
import type { Kind, PadShape } from './testpoint-place.ts';

export const LIBRARY = 'TestPoint';
export const FOOTPRINTS: Record<Kind, string> = { smd: 'TestPoint_Pad_D1.5mm', tht: 'TestPoint_THTPad_D2.5mm_Drill1.2mm' };
export const DESCRIPTION = 'Bring-up test point, bare copper pad, not assembled';

const SHEET_GRID = 2.54; // endpoint_off_grid in ERC otherwise
const COLUMNS = 8;
const COLUMN_PITCH = 20.32;
const ROW_PITCH = 15.24;
const ZONE_CONNECTION_FULL = 2; // a test pad is not soldered: solid to the planes
const LIB_SYMBOL = 'AUTO:TP';

/** The size of a library footprint: FOOTPRINT::GetCourtyard().BBox() grows a circle by its stroke, as courtyardOf says. */
export function padShape(library: string): PadShape {
  const root = parse(library);
  const size = one(one(root, 'pad') ?? [], 'size');
  const courtyard = kids(root, 'fp_circle').find(circle => layerOf(circle) === 'F.CrtYd');
  const [center, end, stroke] = [one(courtyard ?? [], 'center'), one(courtyard ?? [], 'end'), one(one(courtyard ?? [], 'stroke') ?? [], 'width')];
  if (!size || !center || !end || !stroke) throw new Error('add_testpoints: the footprint has no pad or no circular courtyard');
  const half = Math.hypot(Number(atom(end, 1)) - Number(atom(center, 1)), Number(atom(end, 2)) - Number(atom(center, 2))) + Number(atom(stroke, 1));
  return { radius: Number(atom(size, 1)) / 2, halfWidth: half, halfHeight: half };
}

export interface FootprintPlace { name: string; ref: string; value: string; net: string; kind: Kind; at: Pt; symbol: string; next: () => string }

const nmText = (nm: number): string => String(round(toMm(nm), 6));

/** A library footprint as a board item: placed, tied to its symbol and its net, with fresh ids, its reference hidden on F.Fab (D-040). */
export function footprintText(library: string, { name, ref, value, net, kind, at, symbol, next }: FootprintPlace): string {
  const padExtra = `\t\t(net ${quoted(net)})\n${kind === 'tht' ? `\t\t(zone_connect ${ZONE_CONNECTION_FULL})\n` : ''}`;
  const text = library
    .replace(/\t\(version .*\n\t\(generator .*\n\t\(generator_version .*\n/, '')
    .replace(`(footprint ${quoted(name)}`, `(footprint ${quoted(`${LIBRARY}:${name}`)}`)
    .replace('\t(layer "F.Cu")\n', `\t(layer "F.Cu")\n\t(uuid "@")\n\t(at ${nmText(at.x)} ${nmText(at.y)})\n`)
    .replace(/(\(property "Reference" )"[^"]*"(\s+\(at [^)]*\)\s+)\(layer "[^"]*"\)/, `$1${quoted(ref)}$2(layer "F.Fab")\n\t\t(hide yes)`)
    .replace(/(\(property "Value" )"[^"]*"/, `$1${quoted(value)}`)
    .replace('(property "Description" ""', `(property "Description" ${quoted(DESCRIPTION)}`)
    .replace('\t(attr ', `\t(path ${quoted(`/${symbol}`)})\n\t(attr `)
    .replace(/(\t\(pad [^]*?)(\t\t\(uuid )/, `$1${padExtra}$2`)
    .replace(/\(uuid "[^"]*"\)/g, () => `(uuid ${quoted(next())})`);
  return text.trimEnd().split('\n').map(line => `\t${line}`).join('\n') + '\n';
}

const xy = (x: number, y: number): string => `${fixed(x, 2)} ${fixed(y, 2)}`;

function propertyText(name: string, value: string, x: number, y: number, { justify, shown = false }: { justify?: string; shown?: boolean } = {}): string {
  const effects = ['\t\t\t\t(font (size 1.27 1.27))', ...(justify ? [`\t\t\t\t(justify ${justify})`] : []), ...(shown ? [] : ['\t\t\t\t(hide yes)'])];
  return `\t\t(property "${name}" "${value}"\n\t\t\t(at ${xy(x, y)} 0)\n\t\t\t(effects\n${effects.join('\n')}\n\t\t\t)\n\t\t)`;
}

export interface SymbolPlace { ref: string; value: string; footprint: string; net: string; power?: string | null; x: number; y: number; next: () => string }

/** The test point's symbol, then a power symbol or a short wire with a local label. `uuid`: what the footprint's path names. */
export function symbolText({ ref, value, footprint, net, power, x, y, next }: SymbolPlace): { text: string; uuid: string } {
  const uuid = next();
  const out = [`\t(symbol\n\t\t(lib_id "${LIB_SYMBOL}")\n\t\t(at ${xy(x, y)} 0)\n\t\t(unit 1)\n\t\t(exclude_from_sim no)\n`
    + `\t\t(in_bom no)\n\t\t(on_board yes)\n\t\t(dnp no)\n\t\t(fields_autoplaced yes)\n\t\t(uuid "${uuid}")`,
  propertyText('Reference', ref, x, y - 5.934, { justify: 'bottom', shown: true }), propertyText('Value', value, x, y + 1.27, { justify: 'top' }),
  propertyText('Footprint', `${LIBRARY}:${footprint}`, x, y), propertyText('Datasheet', '', x, y), propertyText('Description', DESCRIPTION, x, y),
  `\t\t(pin "1" (uuid "${next()}"))\n\t)`];
  if (power) {
    out.push(`\t(symbol\n\t\t(lib_id "${power}")\n\t\t(at ${xy(x, y)} 180)\n\t\t(unit 1)\n\t\t(exclude_from_sim no)\n`
      + `\t\t(in_bom yes)\n\t\t(on_board yes)\n\t\t(dnp no)\n\t\t(uuid "${next()}")\n${propertyText('Reference', `#PWR_${ref}`, x, y)}\n`
      + `${propertyText('Value', net, x, y + 3.81)}\n${propertyText('Footprint', '', x, y)}\n${propertyText('Datasheet', '', x, y)}\n${propertyText('Description', '', x, y)}\n`
      + `\t\t(pin "1" (uuid "${next()}"))\n\t)`);
  } else {
    const end = y + SHEET_GRID;
    out.push(`\t(wire\n\t\t(pts\n\t\t\t(xy ${xy(x, y)}) (xy ${xy(x, end)})\n\t\t)\n\t\t(stroke\n\t\t\t(width 0)\n\t\t\t(type default)\n\t\t)\n\t\t(uuid "${next()}")\n\t)`);
    out.push(`\t(label "${net.replace(/^\/+/, '')}"\n\t\t(at ${xy(x, end)} 0)\n\t\t(effects\n\t\t\t(font (size 1.27 1.27))\n`
      + `\t\t\t(justify left bottom)\n\t\t)\n\t\t(uuid "${next()}")\n\t)`);
  }
  return { text: out.join('\n'), uuid };
}

/** Where the k-th symbol goes in the column grid of `area`, or null when it falls below the area. */
export function sheetSpot(area: [number, number, number, number], k: number): { x: number; y: number } | null {
  const [x0, y0, , y1] = area;
  const onGrid = (value: number): number => roundWhole(value / SHEET_GRID) * SHEET_GRID;
  const [x, y] = [onGrid(x0 + (k % COLUMNS) * COLUMN_PITCH), onGrid(y0 + Math.floor(k / COLUMNS) * ROW_PITCH)];
  return y > y1 ? null : { x, y };
}

/** The (symbol "<id>" ...) definition inside the lib_symbols of a schematic text, or null. */
export function libSymbol(text: string, id: string): string | null {
  const table = text.indexOf('(lib_symbols');
  const start = table < 0 ? -1 : text.indexOf(`(symbol ${quoted(id)}`, table);
  return start < 0 ? null : text.slice(start, formEnd(text, start));
}

/** The schematics to copy a symbol definition from: the board's sheets, then BASE-PWR, the source of AUTO:TP. */
export function symbolSources(sheet: string, root: string): string[] {
  const inFolder = (folder: string): string[] => (existsSync(folder) ? readdirSync(folder).filter(name => name.endsWith('.kicad_sch')).sort().map(name => join(folder, name)) : []);
  const folder = dirname(sheet);
  return [...inFolder(folder), ...inFolder(join(folder, 'blocks')), join(root, 'hardware-design/boards/BASE-PWR/cad/BASE-PWR/BASE-PWR.kicad_sch')];
}

/**
 * Each symbol needs its definition in the lib_symbols of its own sheet, else KiCad drops it from the netlist (IO-6X6 2026-10-04:
 * AUTO:TP was only in BASE-PWR). Copies each missing one from the first source that has it; `embedded` lists them.
 */
export function embedLibSymbols(schematic: string, ids: string[], sources: string[]): { text: string; embedded: string[] } {
  let text = schematic;
  const embedded: string[] = [];
  for (const id of [...new Set(ids)].sort()) {
    if (libSymbol(text, id)) continue;
    const definition = sources.filter(file => existsSync(file)).map(file => libSymbol(readFileSync(file, 'utf8'), id)).find(found => found !== null);
    if (!definition) throw new Error(`no definition of ${id}`);
    const at = text.indexOf('(lib_symbols') + '(lib_symbols'.length;
    text = `${text.slice(0, at)}\n\t\t${definition}${text.slice(at)}`;
    embedded.push(id);
  }
  return { text, embedded };
}

export const usedLibIds = (blocks: string[]): string[] => [...blocks.join('\n').matchAll(/\(lib_id "([^"]+)"\)/g)].map(match => match[1]!);
