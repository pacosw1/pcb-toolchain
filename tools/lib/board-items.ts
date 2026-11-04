// New board items in KiCad's own text, for BoardEdit.add. Fields a tool does not set hold what pcbnew gave a new item, so the
// saved board matches one saved through pcbnew. Coordinates are millimetres; mmText cuts them as pcbnew.FromMM does.
import { mmText, quoted } from './board-edit.ts';

export type Xy = readonly [number, number];

const xy = ([x, y]: Xy): string => `${mmText(x)} ${mmText(y)}`;
const stroke = (width: number): string => `\t\t(stroke\n\t\t\t(width ${mmText(width)})\n\t\t\t(type default)\n\t\t)\n`;
const tail = (layer: string, uuid: string): string => `\t\t(layer ${quoted(layer)})\n\t\t(uuid ${quoted(uuid)})\n\t)\n`;
const fill = (filled: boolean): string => `\t\t(fill ${filled ? 'yes' : 'no'})\n`;

export interface Item { layer: string; uuid: string }
export interface Stroked extends Item { width: number }

export function trackText(item: Stroked & { start: Xy; end: Xy; net: string }): string {
  return `\t(segment\n\t\t(start ${xy(item.start)})\n\t\t(end ${xy(item.end)})\n\t\t(width ${mmText(item.width)})\n`
    + `\t\t(layer ${quoted(item.layer)})\n\t\t(net ${quoted(item.net)})\n\t\t(uuid ${quoted(item.uuid)})\n\t)\n`;
}

/** A through via. */
export function viaText(item: { at: Xy; size: number; drill: number; net: string; uuid: string }): string {
  return `\t(via\n\t\t(at ${xy(item.at)})\n\t\t(size ${mmText(item.size)})\n\t\t(drill ${mmText(item.drill)})\n`
    + `\t\t(layers "F.Cu" "B.Cu")\n\t\t(net ${quoted(item.net)})\n\t\t(uuid ${quoted(item.uuid)})\n\t)\n`;
}

export const lineText = (item: Stroked & { start: Xy; end: Xy }): string =>
  `\t(gr_line\n\t\t(start ${xy(item.start)})\n\t\t(end ${xy(item.end)})\n${stroke(item.width)}${tail(item.layer, item.uuid)}`;

export const arcText = (item: Stroked & { start: Xy; mid: Xy; end: Xy }): string =>
  `\t(gr_arc\n\t\t(start ${xy(item.start)})\n\t\t(mid ${xy(item.mid)})\n\t\t(end ${xy(item.end)})\n${stroke(item.width)}${tail(item.layer, item.uuid)}`;

export const circleText = (item: Stroked & { center: Xy; end: Xy; filled: boolean }): string =>
  `\t(gr_circle\n\t\t(center ${xy(item.center)})\n\t\t(end ${xy(item.end)})\n${stroke(item.width)}${fill(item.filled)}${tail(item.layer, item.uuid)}`;

export const rectText = (item: Stroked & { start: Xy; end: Xy; filled: boolean }): string =>
  `\t(gr_rect\n\t\t(start ${xy(item.start)})\n\t\t(end ${xy(item.end)})\n${stroke(item.width)}${fill(item.filled)}${tail(item.layer, item.uuid)}`;

export interface TextItem extends Item {
  text: string; at: Xy; size: number; thickness: number;
  angle?: number; bold?: boolean; mirrored?: boolean; face?: string;
}

/** A board text: centred, as a new PCB_TEXT is. */
export function textText(item: TextItem): string {
  const font = [item.face === undefined ? '' : `\t\t\t\t(face ${quoted(item.face)})\n`,
    `\t\t\t\t(size ${mmText(item.size)} ${mmText(item.size)})\n\t\t\t\t(thickness ${mmText(item.thickness)})\n`,
    item.bold ? '\t\t\t\t(bold yes)\n' : ''].join('');
  return `\t(gr_text ${quoted(item.text)}\n\t\t(at ${xy(item.at)} ${item.angle ?? 0})\n\t\t(layer ${quoted(item.layer)})\n\t\t(uuid ${quoted(item.uuid)})\n`
    + `\t\t(effects\n\t\t\t(font\n${font}\t\t\t)\n${item.mirrored ? '\t\t\t(justify mirror)\n' : ''}\t\t)\n\t)\n`;
}

/** What a rule area forbids. Names as a spec's not_allowed list gives them. */
export type RuleName = 'tracks' | 'vias' | 'pads' | 'pour' | 'footprints';

export function ruleAreaText(area: { name: string; layers: string[]; notAllowed: ReadonlySet<string>; points: Xy[]; uuid: string }): string {
  const rule = (name: RuleName): string => (area.notAllowed.has(name) ? 'not_allowed' : 'allowed');
  const points = area.points.map(point => `(xy ${xy(point)})`).join(' ');
  return `\t(zone\n\t\t(layers ${area.layers.map(quoted).join(' ')})\n\t\t(uuid ${quoted(area.uuid)})\n\t\t(name ${quoted(area.name)})\n`
    + '\t\t(hatch edge 0.5)\n\t\t(connect_pads\n\t\t\t(clearance 0)\n\t\t)\n\t\t(min_thickness 0.25)\n'
    + `\t\t(keepout\n\t\t\t(tracks ${rule('tracks')})\n\t\t\t(vias ${rule('vias')})\n\t\t\t(pads ${rule('pads')})\n`
    + `\t\t\t(copperpour ${rule('pour')})\n\t\t\t(footprints ${rule('footprints')})\n\t\t)\n`
    + '\t\t(placement\n\t\t\t(enabled no)\n\t\t\t(sheetname "")\n\t\t)\n'
    + '\t\t(fill\n\t\t\t(thermal_gap 0.5)\n\t\t\t(thermal_bridge_width 0.5)\n\t\t\t(island_removal_mode 0)\n\t\t)\n'
    + `\t\t(polygon\n\t\t\t(pts\n\t\t\t\t${points}\n\t\t\t)\n\t\t)\n\t)\n`;
}
