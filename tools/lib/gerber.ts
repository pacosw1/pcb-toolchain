// RS-274X copper layers and Excellon holes as polygons, for the fab connectivity check (tools/gerber_netcheck.ts).
//
// The polygons are the ones gerbonara and shapely built before: circles of 24 segments per quadrant, lines as capsules,
// arcs as capsule chains, regions from their vertices. Three of its results are kept on purpose, so a verdict stays
// what it was: every primitive is copper, so an aperture hole or an exposure-off macro primitive is filled; a line drawn
// with a rectangle takes the diagonal as its width; and a macro outline turns clockwise by its rotation, a macro rectangle
// anticlockwise.
//
// Anything else is refused, not skipped: this decides a release. Clear polarity is refused because the check has no
// subtraction, and no board uses it: the 64 copper layers of the 17 iot-lab fab sets on 2026-11-04 have none, no arcs, and
// only C, R, O apertures with the FreePoly (outline) and RotRect macros of KiCad.
import { Outline, type Xy } from './copper-graph.ts';

export const QUADRANT_SEGMENTS = 24;
export const HOLE_QUADRANT_SEGMENTS = 16;

const COMMANDS = /G04.*?\*\s*|%.*?%\s*|[^*%]*\*\s*/gs;
const COORDINATE = /^(G0?[123])?(?:X\+?(-?\d+))?(?:Y\+?(-?\d+))?(?:I\+?(-?\d+))?(?:J\+?(-?\d+))?(?:D0?([123]))?$/;
const IGNORED = /^(G0?4|TF|TA|TO|TD|G75$|M0?2$)/;

type Parameters = readonly number[];
type Aperture =
  | { kind: 'circle'; diameter: number }
  | { kind: 'rectangle'; width: number; height: number }
  | { kind: 'obround'; width: number; height: number }
  | { kind: 'macro'; primitives: MacroPrimitive[]; parameters: Parameters };
type MacroValue = number | { variable: number };
type MacroPrimitive =
  | { kind: 'outline'; coordinates: MacroValue[]; rotation: MacroValue }
  | { kind: 'centre-line'; width: MacroValue; height: MacroValue; x: MacroValue; y: MacroValue; rotation: MacroValue };

export interface Hole { x1: number; y1: number; x2: number; y2: number; diameter: number }

const radians = (degrees: number) => (degrees / 180) * Math.PI;

/** gerbonara's rotate_point about the origin: clockwise for a positive angle. */
function turnClockwise(x: number, y: number, angle: number): Xy {
  return [x * Math.cos(-angle) - y * Math.sin(-angle), x * Math.sin(-angle) + y * Math.cos(-angle)];
}

/** Point(x, y).buffer(radius, segments). */
export function circle(x: number, y: number, radius: number, segments = QUADRANT_SEGMENTS): Xy[] {
  const count = 4 * segments;
  return Array.from({ length: count }, (_, i) => {
    const angle = (i * 2 * Math.PI) / count;
    return [x + radius * Math.cos(angle), y + radius * Math.sin(angle)] as const;
  });
}

/** LineString([from, to]).buffer(radius, segments): round caps, or a circle for a line of no length. */
export function capsule(from: Xy, to: Xy, radius: number, segments = QUADRANT_SEGMENTS): Xy[] {
  if (from[0] === to[0] && from[1] === to[1]) return circle(from[0], from[1], radius, segments);
  const direction = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const cap = (centre: Xy, start: number) => Array.from({ length: 2 * segments + 1 }, (_, i) => {
    const angle = start - (i * Math.PI) / (2 * segments);
    return [centre[0] + radius * Math.cos(angle), centre[1] + radius * Math.sin(angle)] as const;
  });
  return [...cap(to, direction + Math.PI / 2), ...cap(from, direction - Math.PI / 2)];
}

/** The rectangle of a flash or macro: anticlockwise by `rotation` about its centre, as shapely's affinity.rotate. */
function rectangle(x: number, y: number, width: number, height: number, rotation = 0): Xy[] {
  const corners: Xy[] = [[width / 2, -height / 2], [width / 2, height / 2], [-width / 2, height / 2], [-width / 2, -height / 2]];
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return corners.map(([dx, dy]) => [x + dx * cos - dy * sin, y + dx * sin + dy * cos] as const);
}

function arcPoints(from: Xy, to: Xy, centreOffset: Xy, clockwise: boolean, legacyArc = false): Xy[] {
  const cx = centreOffset[0] + from[0] * (legacyArc ? 2 : 1);
  const cy = centreOffset[1] + from[1] * (legacyArc ? 2 : 1);
  const radius = Math.hypot(from[0] - cx, from[1] - cy);
  const start = Math.atan2(from[1] - cy, from[0] - cx);
  let end = Math.atan2(to[1] - cy, to[0] - cx);
  if (clockwise) while (end >= start) end -= 2 * Math.PI;
  else while (end <= start) end += 2 * Math.PI;
  const steps = Math.max(8, Math.trunc(Math.abs(end - start) * radius * 8));
  const points = Array.from({ length: steps + 1 }, (_, i) => {
    const angle = start + ((end - start) * i) / steps;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)] as const;
  });
  return points;
}

function valueOf(value: MacroValue, parameters: Parameters): number {
  if (typeof value === 'number') return value;
  const bound = parameters[value.variable - 1];
  if (bound === undefined) throw new Error(`Gerber macro: no value for $${value.variable}`);
  return bound;
}

function macroPolygon(primitive: MacroPrimitive, x: number, y: number, parameters: Parameters): Xy[] {
  const read = (value: MacroValue) => valueOf(value, parameters);
  const rotation = radians(read(primitive.rotation));
  if (primitive.kind === 'centre-line') {
    const [cx, cy] = turnClockwise(read(primitive.x), read(primitive.y), rotation);
    return rectangle(cx + x, cy + y, read(primitive.width), read(primitive.height), rotation);
  }
  const points: Xy[] = [];
  for (let i = 0; i < primitive.coordinates.length; i += 2) {
    const [px, py] = turnClockwise(read(primitive.coordinates[i]!), read(primitive.coordinates[i + 1]!), rotation);
    points.push([px + x, py + y]);
  }
  return points;
}

function obroundLine(x: number, y: number, width: number, height: number): Xy[] {
  const along = (width > height ? width - height : 0) / 2;
  const across = (width > height ? 0 : height - width) / 2;
  return capsule([x - along, y - across], [x + along, y + across], Math.min(width, height) / 2);
}

function flash(aperture: Aperture, x: number, y: number): Xy[][] {
  switch (aperture.kind) {
    case 'circle': return [circle(x, y, aperture.diameter / 2)];
    case 'rectangle': return [rectangle(x, y, aperture.width, aperture.height)];
    case 'obround': return [obroundLine(x, y, aperture.width, aperture.height)];
    case 'macro': return aperture.primitives.map(primitive => macroPolygon(primitive, x, y, aperture.parameters));
  }
}

function lineWidth(aperture: Aperture): number {
  if (aperture.kind === 'circle') return aperture.diameter;
  if (aperture.kind === 'rectangle') return Math.sqrt(aperture.width ** 2 + aperture.height ** 2);
  throw new Error('Gerber: line drawn with a non-circular aperture');
}

function macroValue(text: string): MacroValue {
  const variable = /^\$(\d+)$/.exec(text);
  if (variable) return { variable: Number(variable[1]) };
  if (text === '' || Number.isNaN(Number(text))) throw new Error(`Gerber macro: expression not handled: ${text}`);
  return Number(text);
}

function outlinePrimitive(fields: string[]): MacroPrimitive {
  const values = fields.slice(2).map(macroValue);
  const hasRotation = values.length % 2 === 1;
  const coordinates = hasRotation ? values.slice(0, -1) : values;
  if (Number(fields[1]) !== coordinates.length / 2 - 1) throw new Error('Gerber macro: outline size does not match its points');
  if (coordinates[0] !== coordinates.at(-2) || coordinates[1] !== coordinates.at(-1)) throw new Error('Gerber macro: outline is not closed');
  return { kind: 'outline', coordinates, rotation: hasRotation ? values.at(-1)! : 0 };
}

function parseMacro(body: string): MacroPrimitive[] {
  const primitives: MacroPrimitive[] = [];
  for (const block of body.split('*').map(text => text.trim()).filter(Boolean)) {
    if (block.startsWith('0 ')) continue;
    const [code, ...fields] = block.replace(/\s/g, '').split(',');
    if (code === '4') primitives.push(outlinePrimitive(fields));
    else if (code === '21' && fields.length === 6) {
      const [, width, height, x, y, rotation] = fields.map(macroValue);
      primitives.push({ kind: 'centre-line', width: width!, height: height!, x: x!, y: y!, rotation: rotation! });
    } else throw new Error(`Gerber macro: primitive not handled: ${block.slice(0, 40)}`);
  }
  return primitives;
}

class Layer {
  private readonly legacyArc: boolean;
  constructor(legacyArc = false) { this.legacyArc = legacyArc; }
  readonly shapes: Xy[][] = [];
  readonly strokes: {points: Xy[]; width: number}[] = [];
  private readonly apertures = new Map<number, Aperture>();
  private readonly macros = new Map<string, MacroPrimitive[]>();
  private integerDigits: number | undefined;
  private decimalDigits = 0;
  private metric = false;
  private aperture: Aperture | undefined;
  private point: Xy = [0, 0];
  private interpolation: 'linear' | 'clockwise' | 'anticlockwise' = 'linear';
  private region: Xy[] | null = null;
  private lastOperation: string | undefined;

  private value(text: string | undefined): number | undefined {
    if (!text) return undefined;
    if (this.integerDigits === undefined) throw new Error('Gerber: coordinate before the format statement');
    const negative = text.startsWith('-');
    const digits = text.replace('-', '').padStart(this.integerDigits + this.decimalDigits, '0');
    const split = digits.length - this.decimalDigits;
    const value = Number(`${digits.slice(0, split)}.${digits.slice(split)}`);
    return negative ? -value : value;
  }

  private defineAperture(number: number, shape: string, modifiers: Parameters): void {
    const [first = 0, second = 0] = modifiers;
    if (shape === 'C') this.apertures.set(number, { kind: 'circle', diameter: first });
    else if (shape === 'R') this.apertures.set(number, { kind: 'rectangle', width: first, height: second });
    else if (shape === 'O') this.apertures.set(number, { kind: 'obround', width: first, height: second });
    else {
      const primitives = this.macros.get(shape);
      if (!primitives) throw new Error(`Gerber: aperture not handled: ${shape}`);
      this.apertures.set(number, { kind: 'macro', primitives, parameters: modifiers });
    }
  }

  private closeRegion(): void {
    if (this.region && this.region.length >= 3) this.shapes.push(this.region);
  }

  private draw(to: Xy, i: number | undefined, j: number | undefined): void {
    const from = this.point;
    if (this.region) {
      if (!this.region.length) this.region.push(from);
      this.region.push(to);
      return;
    }
    if (!this.aperture) throw new Error('Gerber: draw without an aperture');
    const width = lineWidth(this.aperture);
    if (width <= 0) return;
    if (this.interpolation === 'linear' || (i === undefined && j === undefined)) this.shapes.push(capsule(from, to, width / 2));
    else {
      const points=arcPoints(from, to, [i ?? 0, j ?? 0], this.interpolation === 'clockwise', this.legacyArc);
      if (this.legacyArc) this.strokes.push({points,width});
      else this.shapes.push(...points.slice(1).map((point, index)=>capsule(points[index]!,point,width/2)));
    }
  }

  private coordinate(match: RegExpExecArray): void {
    const [, code, x, y, i, j, explicit] = match;
    if (code) this.interpolation = code.endsWith('1') ? 'linear' : code.endsWith('2') ? 'clockwise' : 'anticlockwise';
    const hasCoordinate = Boolean(x || y || i || j);
    if (!hasCoordinate && !explicit) return;
    if (!explicit && this.lastOperation !== '1') throw new Error('Gerber: coordinate without an operation');
    const operation = explicit ?? '1';
    this.lastOperation = operation;
    const to: Xy = [this.value(x) ?? this.point[0], this.value(y) ?? this.point[1]];
    if (operation === '1') this.draw(to, this.value(i), this.value(j));
    else if (operation === '2') this.startOutline();
    else if (this.region) throw new Error('Gerber: flash inside a region');
    else if (!this.aperture) throw new Error('Gerber: flash without an aperture');
    else this.shapes.push(...flash(this.aperture, to[0], to[1]));
    this.point = to;
  }

  /** Each D02 inside a region starts another outline. */
  private startOutline(): void {
    if (this.region?.length) {
      this.closeRegion();
      this.region = [];
    }
  }

  statement(command: string): void {
    const format = /^FSLAX(\d)(\d)Y(\d)(\d)$/.exec(command);
    const definition = /^ADD(\d+)([A-Za-z_$.][A-Za-z_$.0-9+-]*)(?:,([^,%]*))?$/.exec(command);
    const macro = /^AM([A-Za-z_$.][A-Za-z_$.0-9+-]+)\*(.*)$/s.exec(command);
    const select = /^(?:G54)?D(\d+)$/.exec(command);
    if (format) {
      if (format[1] !== format[3] || format[2] !== format[4]) throw new Error('Gerber: different X and Y formats');
      this.integerDigits = Number(format[1]);
      this.decimalDigits = Number(format[2]);
    } else if (command === 'MOMM') this.metric = true;
    else if (command === 'LPD') return;
    else if (command === 'LPC') throw new Error('Gerber: clear polarity is not handled');
    else if (macro) this.macros.set(macro[1]!, parseMacro(macro[2]!));
    else if (definition) {
      if (!this.metric) throw new Error('Gerber: aperture before the MOMM statement');
      const modifiers = definition[3] ? definition[3].split('X').map(Number) : [];
      this.defineAperture(Number(definition[1]), definition[2]!, modifiers);
    } else if (command === 'G36') this.region = [];
    else if (command === 'G37') {
      this.closeRegion();
      this.region = null;
    } else if (select && Number(select[1]) >= 10) {
      this.aperture = this.apertures.get(Number(select[1]));
      if (!this.aperture) throw new Error(`Gerber: undefined aperture ${select[1]}`);
    } else if (!IGNORED.test(command)) {
      const coordinate = COORDINATE.exec(command);
      if (!coordinate) throw new Error(`Gerber: statement not handled: ${command.slice(0, 60)}`);
      this.coordinate(coordinate);
    }
  }
}

/** A shape with no copper is what shapely called empty: a zero width, a region of no area. */
function hasCopper(points: readonly Xy[]): boolean {
  let area = 0;
  points.forEach((point, i) => {
    const next = points[(i + 1) % points.length]!;
    area += point[0] * next[1] - next[0] * point[1];
  });
  return area !== 0;
}

/** The copper shapes of a layer. */
function parseLayer(text: string, legacyArc: boolean): Layer {
  const layer = new Layer(legacyArc);
  for (const [raw] of text.matchAll(COMMANDS)) {
    const command = raw.trim().replace(/^%|%$/g, '').replace(/\*$/, '');
    if (command) layer.statement(command);
  }
  return layer;
}
export function parseCopper(text: string): Outline[] {
  return parseLayer(text,false).shapes.filter(hasCopper).map(points => new Outline(points));
}
export function parseLegacyGeometry(text: string): {outlines: Outline[]; strokes: {points:Xy[]; width:number}[]} {
  const layer=parseLayer(text,true);
  return {outlines:layer.shapes.filter(hasCopper).map(points=>new Outline(points)),strokes:layer.strokes};
}

/** Plated holes and G85 slots, in mm. Other lines of the file are skipped, as before. */
export function parseDrill(text: string): Hole[] {
  const tools = new Map<string, number>();
  const holes: Hole[] = [];
  let diameter: number | undefined;
  let metric = true;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('INCH')) metric = false;
    const tool = /^T(\d+)C([\d.]+)/.exec(line);
    const select = /^T(\d+)$/.exec(line);
    const slot = /^X([-\d.]+)Y([-\d.]+)G85X([-\d.]+)Y([-\d.]+)/.exec(line);
    const hole = /^X([-\d.]+)Y([-\d.]+)$/.exec(line);
    if (tool) tools.set(tool[1]!, Number(tool[2]));
    else if (select) diameter = tools.get(select[1]!);
    else if (slot) {
      if (diameter === undefined) throw new Error('drill file: slot before a tool');
      holes.push({ x1: Number(slot[1]), y1: Number(slot[2]), x2: Number(slot[3]), y2: Number(slot[4]), diameter });
    } else if (hole && diameter) {
      holes.push({ x1: Number(hole[1]), y1: Number(hole[2]), x2: Number(hole[1]), y2: Number(hole[2]), diameter });
    }
  }
  if (!metric) throw new Error('inch drill file not handled');
  return holes;
}
