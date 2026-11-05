// Cut a design block out of a flat board, on the native text. Everything that is kept stays byte for byte, except the
// edits named here. The output is a proposal: DRC with schematic parity decides.
import { randomUUID } from 'node:crypto';
import { boxOfPoints, grow, offset, readSilk, shapeBox, toBoard, unionBox, type Box, type Xy } from './board-silk.ts';
import { forms, kids, one, pose, type SList } from './sexpr.ts';
import { textBox } from './stroke-text.ts';

const SCH_KEEP = new Set(['version', 'generator', 'generator_version', 'uuid', 'paper', 'sheet_instances', 'embedded_fonts']);
const SCH_DROP = new Set(['title_block']);
const SCH_FOOTER = new Set(['sheet_instances', 'embedded_fonts']);
const TRACKS = new Set(['segment', 'arc', 'via']);
const SHAPES = new Set(['gr_line', 'gr_rect', 'gr_circle', 'gr_arc', 'gr_poly', 'gr_curve']);
/** Board drawings this tool has no box for. Refused, so that nothing is kept or dropped by guess. */
const UNREAD_DRAWINGS = new Set(['gr_text_box', 'gr_vector', 'dimension', 'image', 'table', 'barcode']);
const EDGE_WIDTH_MM = 0.05;
const MIN_FOOTPRINT_HALF_MM = 0.25; // FOOTPRINT::GetBoundingBox: "Give a min size to the bbox"
const NM = 1e6;

type Span = [number, number];
export type Rect = readonly [number, number, number, number];

/** Spans of the direct children of the list that opens at text[start]. */
export function childSpans(text: string, start: number, end: number): Span[] {
  const spans: Span[] = [];
  let depth = 0, quoted = false, opened = 0;
  for (let i = start; i < end; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '\\') i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true;
    } else if (c === '(') {
      if (++depth === 2) opened = i;
    } else if (c === ')') {
      if (depth === 2) spans.push([opened, i + 1]);
      if (--depth === 0) break;
    }
  }
  return spans;
}

export const children = (text: string): string[] => childSpans(text, text.indexOf('('), text.length).map(([a, b]) => text.slice(a, b));
export const head = (item: string): string => (/\(\s*([^\s()]+)/.exec(item) as RegExpExecArray)[1] as string;

function schematicPoints(item: string): Xy[] {
  if (['wire', 'bus', 'polyline'].includes(head(item))) {
    return [...item.matchAll(/\(xy ([-\d.]+) ([-\d.]+)\)/g)].map(match => [Number(match[1]), Number(match[2])]);
  }
  const at = /\(at ([-\d.]+) ([-\d.]+)/.exec(item);
  return at ? [[Number(at[1]), Number(at[2])]] : [];
}

const inside = ([x, y]: Xy, box: Rect): boolean => box[0] <= x && x <= box[2] && box[1] <= y && y <= box[3];

/** Keep every schematic item that lies fully inside `box`, the library symbols they use, and the root uuid. */
export function cropSchematic(text: string, box: Rect, blockId: string): string {
  const kids_ = children(text);
  const kept = kids_.filter(item => {
    const name = head(item), points = schematicPoints(item);
    return !SCH_KEEP.has(name) && !SCH_DROP.has(name) && name !== 'lib_symbols' && points.length && points.every(point => inside(point, box));
  });
  const used = new Set(kept.flatMap(item => [...item.matchAll(/\(lib_id "([^"]+)"\)/g)].map(match => match[1])));
  const out = ['(kicad_sch'];
  for (const item of kids_) {
    const name = head(item);
    if (SCH_KEEP.has(name) && !SCH_FOOTER.has(name)) out.push(`  ${item}`);
    else if (name === 'lib_symbols') {
      const symbols = children(item).filter(symbol => used.has((/\(symbol "([^"]+)"/.exec(symbol) as RegExpExecArray)[1]));
      out.push(`  (lib_symbols\n${symbols.map(symbol => `\t${symbol}\n`).join('')}  )`);
    }
  }
  out.push(...kept.map(item => `\t${item.replace(/\(project "[^"]*"/g, () => `(project "${blockId}"`)}`));
  out.push(...kids_.filter(item => SCH_FOOTER.has(head(item))).map(item => `  ${item}`));
  return `${out.join('\n')}\n)\n`;
}

/** Set the Footprint field of the symbol with this reference. */
export function setSchematicFootprint(text: string, reference: string, footprint: string): string {
  const wanted = `(property "Reference" "${reference}"`;
  for (const [a, b] of childSpans(text, text.indexOf('('), text.length)) {
    const item = text.slice(a, b);
    if (head(item) !== 'symbol' || !item.includes(wanted)) continue;
    const changed = item.replace(/\(property "Footprint" "[^"]*"/, () => `(property "Footprint" "${footprint}"`);
    if (changed !== item || /\(property "Footprint" "[^"]*"/.test(item)) return text.slice(0, a) + changed + text.slice(b);
  }
  throw new Error(`no schematic symbol ${reference}`);
}

const numbers = (form: SList | undefined): number[] => (form ?? []).slice(1).filter(atomic => typeof atomic === 'string').map(Number);
const nameOf = (form: SList, field: string): string | undefined => { const row = one(form, field); return row ? String(row.at(-1)) : undefined; };
const uuidOf = (form: SList): string => nameOf(form, 'uuid') ?? '';

interface Placement { at: Xy; angle: number }

const placementOf = (form: SList): Placement => { const { x, y, angle } = pose(form); return { at: [x, y], angle }; };

/** A copy of a shape in the frame of `frame`: every coordinate is moved, widths stay. */
function placed(form: SList, frame: Placement): SList {
  return form.map(item => {
    if (!Array.isArray(item)) return item;
    if (['start', 'end', 'mid', 'center', 'xy'].includes(item[0] as string)) {
      const [x, y] = toBoard([Number(item[1]), Number(item[2])], frame);
      return [item[0] as string, String(x), String(y)];
    }
    return placed(item, frame);
  });
}

/** A rectangle may turn off the axes, so its corners go through the frame as a polygon. */
function placedShapeBox(form: SList, frame: Placement): Box {
  if (form[0] !== 'fp_rect' && form[0] !== 'gr_rect') return shapeBox(placed(form, frame));
  const [x0, y0] = numbers(one(form, 'start')) as [number, number], [x1, y1] = numbers(one(form, 'end')) as [number, number];
  const width = numbers(one(one(form, 'stroke') ?? form, 'width'))[0] ?? 0;
  return grow(boxOfPoints(([[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as Xy[]).map(point => toBoard(point, frame))), width / 2);
}

function padShapeBox(kind: string, size: [number, number], frame: Placement): Box {
  const [halfX, halfY] = [size[0] / 2, size[1] / 2];
  if (kind === 'circle') return grow(boxOfPoints([frame.at]), halfX);
  if (kind === 'oval') {
    const radius = Math.min(halfX, halfY);
    const [spineX, spineY] = [halfX - radius, halfY - radius];
    return grow(boxOfPoints(([[-spineX, -spineY], [spineX, spineY]] as Xy[]).map(point => toBoard(point, frame))), radius);
  }
  return boxOfPoints(([[-halfX, -halfY], [halfX, -halfY], [halfX, halfY], [-halfX, halfY]] as Xy[]).map(point => toBoard(point, frame)));
}

function padHoleBox(pad: SList, frame: Placement): Box | null {
  const drill = one(pad, 'drill');
  if (!drill) return null;
  const sizes = drill.slice(1).filter((item): item is string => typeof item === 'string' && item !== 'oval').map(Number);
  const [x, y = x] = sizes as [number, number?];
  if (!x) return null;
  const [dx = 0, dy = 0] = numbers(one(drill, 'offset'));
  const centre = toBoard([dx, dy], frame);
  return padShapeBox(drill.includes('oval') ? 'oval' : 'circle', [x, y as number], { at: centre, angle: frame.angle });
}

function padBox(pad: SList, parent: Placement): Box {
  const local = pose(pad);
  const frame: Placement = { at: toBoard([local.x, local.y], parent), angle: local.angle };
  const [sizeX, sizeY] = numbers(one(pad, 'size')) as [number, number];
  const shape = String(pad[3]);
  const anchor = shape === 'custom' ? String((one(one(pad, 'options') ?? [], 'anchor') ?? ['anchor', 'rect'])[1]) : shape;
  let box = padShapeBox(anchor, [sizeX, sizeY], frame);
  for (const primitive of (one(pad, 'primitives') ?? []).slice(1) as SList[]) box = unionBox(box, placedShapeBox(primitive, frame));
  const hole = padHoleBox(pad, frame);
  return hole ? unionBox(box, hole) : box;
}

function zoneBox(zone: SList): Box | null {
  const points = kids(zone, 'polygon').flatMap(polygon => kids(one(polygon, 'pts') ?? [], 'xy')).map(xy => numbers(xy) as unknown as Xy);
  return points.length ? boxOfPoints(points) : null;
}

/** FOOTPRINT::GetBoundingBox with its text: the shapes, pads and zones, and every visible text with fields expanded. */
export function footprintBox(text: string, form: SList): Box {
  const frame = placementOf(form);
  let box = grow(boxOfPoints([frame.at]), MIN_FOOTPRINT_HALF_MM);
  for (const item of form.slice(1)) {
    if (!Array.isArray(item)) continue;
    const kind = item[0] as string;
    if (['fp_line', 'fp_rect', 'fp_circle', 'fp_arc', 'fp_poly', 'fp_curve'].includes(kind)) box = unionBox(box, placedShapeBox(item, frame));
    else if (kind === 'pad') box = unionBox(box, padBox(item, frame));
    else if (kind === 'zone') box = unionBox(box, zoneBox(item) ?? box);
  }
  const fields = new Map(kids(form, 'property').map(row => [String(row[1]).toUpperCase(), String(row[2])]));
  for (const row of readSilk(`(kicad_pcb ${text})`).footprintTexts) {
    if (!row.visible) continue;
    const shown = row.text.replace(/\$\{([^}]+)\}/g, (whole, name: string) => fields.get(name.toUpperCase()) ?? whole).replaceAll('\\n', '\n');
    box = unionBox(box, offset(textBox(shown, row.style), row.at));
  }
  return box;
}

/** The box of a track: PCB_TRACK::GetBoundingBox gives its round ends their half width. */
function trackBox(form: SList): Box {
  if (form[0] !== 'via') return shapeBox(form);
  const { x, y } = pose(form);
  return grow([x, y, x, y], (numbers(one(form, 'size'))[0] as number) / 2);
}

const nanometres = (box: Box): Box => box.map(value => Math.round(value * NM)) as unknown as Box;

/** BOX2I::Contains: the edge counts, in KiCad's whole nanometres. */
function contains(outer: Box, inner: Box): boolean {
  const [a, b] = [nanometres(outer), nanometres(inner)];
  return a[0] <= b[0] && a[1] <= b[1] && b[2] <= a[2] && b[3] <= a[3];
}

/** One edge of the clip rectangle, and the side of it that stays. */
interface HalfPlane { axis: 0 | 1; limit: number; keepBelow: boolean }

const keeps = (plane: HalfPlane, point: Xy): boolean => plane.keepBelow ? point[plane.axis] <= plane.limit : point[plane.axis] >= plane.limit;

function crossing(a: Xy, b: Xy, plane: HalfPlane): Xy {
  const t = (plane.limit - a[plane.axis]) / ((b[plane.axis] as number) - (a[plane.axis] as number));
  const other = plane.axis === 0 ? 1 : 0;
  const point: [number, number] = [0, 0];
  point[plane.axis] = plane.limit;
  point[other] = (a[other] as number) + t * ((b[other] as number) - (a[other] as number));
  return point;
}

/**
 * A simple polygon cut by one edge of the rectangle. Runs of kept vertices start and end on the edge; the polygon's inside
 * lies between consecutive crossings along it, so pairing them in order closes each separate piece.
 */
function clipHalfPlane(polygon: Xy[], plane: HalfPlane): Xy[][] {
  if (polygon.every(point => keeps(plane, point))) return [polygon];
  if (!polygon.some(point => keeps(plane, point))) return [];
  const first = polygon.findIndex((point, index) => keeps(plane, point) && !keeps(plane, polygon.at(index - 1) as Xy));
  const ordered = [...polygon.slice(first), ...polygon.slice(0, first)];
  const runs: Xy[][] = [];
  let run: Xy[] = [crossing(polygon.at(first - 1) as Xy, ordered[0] as Xy, plane)];
  ordered.forEach((point, index) => {
    const next = ordered[(index + 1) % ordered.length] as Xy;
    if (keeps(plane, point)) run.push(point);
    if (keeps(plane, point) && !keeps(plane, next)) {
      run.push(crossing(point, next, plane));
      runs.push(run);
      run = [];
    } else if (!keeps(plane, point) && keeps(plane, next)) {
      run = [crossing(point, next, plane)];
    }
  });
  const along = plane.axis === 0 ? 1 : 0;
  const ends = runs.flatMap((row, index) => [{ run: index, start: true, at: (row[0] as Xy)[along] as number }, { run: index, start: false, at: (row.at(-1) as Xy)[along] as number }])
    .sort((a, b) => a.at - b.at);
  const nextRun = new Map<number, number>();
  for (let i = 0; i + 1 < ends.length; i += 2) {
    const [a, b] = [ends[i] as typeof ends[number], ends[i + 1] as typeof ends[number]];
    const [tail, start] = a.start ? [b, a] : [a, b];
    nextRun.set(tail.run, start.run);
  }
  const pieces: Xy[][] = [];
  const seen = new Set<number>();
  runs.forEach((_, index) => {
    const piece: Xy[] = [];
    for (let at: number | undefined = index; at !== undefined && !seen.has(at); at = nextRun.get(at)) {
      seen.add(at);
      piece.push(...(runs[at] as Xy[]));
    }
    if (piece.length >= 3) pieces.push(piece);
  });
  return pieces;
}

/** A polygon inside a rectangle, as separate simple polygons. */
export function clipPolygon(polygon: Xy[], box: Rect): Xy[][] {
  const planes: HalfPlane[] = [
    { axis: 0, limit: box[0], keepBelow: false }, { axis: 0, limit: box[2], keepBelow: true },
    { axis: 1, limit: box[1], keepBelow: false }, { axis: 1, limit: box[3], keepBelow: true },
  ];
  return planes.reduce((pieces, plane) => pieces.flatMap(piece => clipHalfPlane(piece, plane)), [polygon]);
}

const mm = (value: number): string => String(Number(value.toFixed(6)));

/** The polygons of a zone clipped to the box, as text; empty when no copper area is left. */
function clippedPolygons(zone: SList, box: Rect): string {
  return kids(zone, 'polygon').flatMap(polygon => {
    const pts = one(polygon, 'pts') ?? [];
    if (pts.slice(1).some(point => Array.isArray(point) && point[0] !== 'xy')) throw new Error(`zone ${uuidOf(zone)}: an arc in the outline cannot be clipped`);
    return clipPolygon(kids(pts, 'xy').map(xy => numbers(xy) as unknown as Xy), box);
  }).map(piece => `(polygon (pts ${piece.map(([x, y]) => `(xy ${mm(x)} ${mm(y)})`).join(' ')}))`).join('\n\t\t');
}

export interface Cut { text: string; parts: number; box: Box; tracks: number; zones: number }

export interface TopForm { span: Span; form: SList }

export function topForms(text: string): TopForm[] {
  return childSpans(text, text.indexOf('('), text.length).map(span => ({ span, form: forms(text.slice(span[0], span[1]))[0] as SList }));
}

export const referenceOf = (form: SList): string | undefined => kids(form, 'property').find(row => row[1] === 'Reference')?.[2] as string | undefined;

function padNets(form: SList): string[] {
  return kids(form, 'pad').map(pad => nameOf(pad, 'net') ?? '').filter(Boolean);
}

/** A board text without the spans in `edits`, each replaced by its text. */
function applied(text: string, edits: { span: Span; text: string }[]): string {
  return [...edits].sort((a, b) => b.span[0] - a.span[0]).reduce((result, { span, text: replacement }) => result.slice(0, span[0]) + replacement + result.slice(span[1]), text);
}

const edgeRect = (box: Box): string =>
  `\t(gr_rect\n\t\t(start ${mm(box[0])} ${mm(box[1])})\n\t\t(end ${mm(box[2])} ${mm(box[3])})\n\t\t(stroke\n\t\t\t(width ${EDGE_WIDTH_MM})\n\t\t\t(type default)\n\t\t)\n\t\t(fill no)\n\t\t(layer "Edge.Cuts")\n\t\t(uuid "${randomUUID()}")\n\t)\n`;

function drawingOf(text: string, row: TopForm): Box {
  if (row.form[0] !== 'gr_text') return shapeBox(row.form);
  const read = readSilk(`(kicad_pcb ${text.slice(row.span[0], row.span[1])})`).texts[0];
  return (read as NonNullable<typeof read>).box;
}

/** Keep `refs`, their nets' copper inside the part box with `margin`, those nets' zones clipped to it, and drawings inside it. */
export function cutBoard(text: string, refs: string[], margin: number, swapped: Map<string, string> = new Map()): Cut {
  const rows = topForms(text);
  const wanted = new Set(refs);
  const footprints = rows.filter(row => row.form[0] === 'footprint');
  const kept = footprints.filter(row => wanted.has(referenceOf(row.form) as string));
  const found = new Set(kept.map(row => referenceOf(row.form)));
  const missing = refs.filter(ref => !found.has(ref)).sort();
  if (missing.length) throw new Error(`block_extract: refs not on the board: ${JSON.stringify(missing)}`);
  const parts = kept.map(row => footprintBox(text.slice(row.span[0], row.span[1]), row.form)).reduce(unionBox);
  const box = grow(parts, margin);
  const nets = new Set(kept.flatMap(row => padNets(row.form)));
  const edits: { span: Span; text: string }[] = [];
  const dropped = new Set<string>();
  const drop = (row: TopForm) => { edits.push({ span: row.span, text: '' }); dropped.add(uuidOf(row.form)); };
  let tracks = 0, zones = 0;
  for (const row of rows) {
    const kind = row.form[0] as string;
    if (UNREAD_DRAWINGS.has(kind)) throw new Error(`block_extract: no box for a board ${kind}; remove it or cut this block by hand`);
    if (kind === 'footprint') {
      const replacement = swapped.get(referenceOf(row.form) as string);
      if (!wanted.has(referenceOf(row.form) as string)) drop(row);
      else if (replacement !== undefined) edits.push({ span: row.span, text: replacement });
    } else if (TRACKS.has(kind)) {
      if (!nets.has(nameOf(row.form, 'net') ?? '') || !contains(box, trackBox(row.form))) drop(row);
      else tracks++;
    } else if (kind === 'zone') {
      const outline = one(row.form, 'keepout') || !nets.has(nameOf(row.form, 'net') ?? '') ? '' : clippedPolygons(row.form, box);
      if (!outline) { drop(row); continue; }
      zones++;
      const source = text.slice(row.span[0], row.span[1]);
      const spans = childSpans(source, 0, source.length).filter(([a, b]) => head(source.slice(a, b)) === 'polygon');
      const rewritten = applied(source, spans.map((span, index) => ({ span, text: index === 0 ? outline : '' })));
      edits.push({ span: row.span, text: rewritten });
    } else if (SHAPES.has(kind) || kind === 'gr_text') {
      if (nameOf(row.form, 'layer') === 'Edge.Cuts' || !contains(box, drawingOf(text, row))) drop(row);
    }
  }
  for (const row of rows.filter(item => item.form[0] === 'group')) {
    const members = (one(row.form, 'members') ?? []).slice(1).map(String);
    const left = members.filter(member => !dropped.has(member));
    if (!left.length) { edits.push({ span: row.span, text: '' }); continue; }
    if (left.length === members.length) continue;
    const source = text.slice(row.span[0], row.span[1]);
    const span = childSpans(source, 0, source.length).find(([a, b]) => head(source.slice(a, b)) === 'members') as Span;
    edits.push({ span: row.span, text: applied(source, [{ span, text: `(members ${left.map(member => `"${member}"`).join(' ')})` }]) });
  }
  const cut = applied(text, edits);
  const end = cut.lastIndexOf(')');
  return { text: `${cut.slice(0, end)}${edgeRect(box)}${cut.slice(end)}`, parts: kept.length, box, tracks, zones };
}

function addAngle(at: SList, rotation: number): string {
  const [x, y, angle = 0] = numbers(at);
  const turned = ((angle + rotation) % 360 + 360) % 360;
  return `(at ${x} ${y}${turned ? ` ${mm(turned)}` : ''})`;
}

const LIBRARY_ONLY = new Set(['version', 'generator', 'generator_version', 'layer', 'embedded_fonts']);
const NOT_COPIED_FIELDS = new Set(['Reference', 'Value', 'Footprint']);

/** One child of a library footprint as board text: world angles, this part's nets and field values. */
function swappedChild(item: string, form: SList, rotation: number, nets: Map<string, string>, fields: Map<string, string>): string {
  const spans = childSpans(item, 0, item.length);
  const at = spans.find(([a, b]) => head(item.slice(a, b)) === 'at');
  const turned = at && (form[0] === 'pad' || form[0] === 'property' || form[0] === 'fp_text');
  let text = turned ? applied(item, [{ span: at, text: addAngle(forms(item.slice(at[0], at[1]))[0] as SList, rotation) }]) : item;
  if (form[0] === 'pad') {
    const net = nets.get(String(form[1]));
    if (net) text = `${text.slice(0, text.lastIndexOf(')'))} (net "${net}"))`;
  }
  if (form[0] === 'property' && fields.has(String(form[1]))) {
    text = text.replace(/^(\(\s*property\s+"(?:[^"\\]|\\.)*"\s+)"(?:[^"\\]|\\.)*"/, (_, start: string) => `${start}"${fields.get(String(form[1]))}"`);
  }
  return text;
}

/** A library footprint in the place of `old`: its pose, sheet path, reference, value, fields and pad nets. */
export function swapFootprint(oldText: string, old: SList, library: string, name: string, moduleText: string): string {
  const module = forms(moduleText)[0] as SList;
  const layer = nameOf(old, 'layer');
  if (nameOf(module, 'layer') !== layer) throw new Error(`block_extract: ${name} is on ${nameOf(module, 'layer')} and the part on ${layer}; a side change needs KiCad`);
  const { x, y, angle } = pose(old);
  const nets = new Map(kids(old, 'pad').flatMap(pad => { const net = nameOf(pad, 'net'); return net ? [[String(pad[1]), net] as const] : []; }));
  const fields = new Map(kids(old, 'property').filter(row => !['Footprint'].includes(String(row[1]))).map(row => [String(row[1]), String(row[2])]));
  const body = childSpans(moduleText, moduleText.indexOf('('), moduleText.length).map(([a, b]) => moduleText.slice(a, b))
    .filter(item => !LIBRARY_ONLY.has(head(item)))
    .map(item => swappedChild(item, forms(item)[0] as SList, angle, nets, fields));
  const present = new Set(kids(module, 'property').map(row => String(row[1])));
  const added = [...fields].filter(([field]) => !present.has(field) && !NOT_COPIED_FIELDS.has(field)).map(([field, value]) =>
    `(property "${field}" "${value}" (at 0 0 ${mm(angle)}) (layer "F.Fab") (hide yes) (uuid "${randomUUID()}") (effects (font (size 1.27 1.27))))`);
  const path = one(old, 'path');
  const pathText = path ? `(path "${String(path[1])}")` : '';
  return [`(footprint "${library}:${name}"`, `(layer "${layer}")`, `(uuid "${randomUUID()}")`, `(at ${x} ${y}${angle ? ` ${angle}` : ''})`, pathText, ...body, ...added, ')'].filter(Boolean).join('\n\t\t');
}
