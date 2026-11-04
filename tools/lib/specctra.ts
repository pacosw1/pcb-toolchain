// Specctra DSN and SES text as KiCad writes it. Not the .kicad_pcb dialect of sexpr.ts: a backslash is an ordinary
// character here, and "(string_quote ")" holds the one unpaired quote of the file.
//
// Units: the DSN is in um (KiCad export, "(unit um)"); the SES carries its "(resolution um N)" factor (N = 10: divide
// by 10000 for mm). The y axis is negated in both (DSN y = -mm).
import { readFileSync } from 'node:fs';
import { round } from './py-numbers.ts';
import { kids, one, type SList } from './sexpr.ts';

const TOKEN = /\(|\)|"[^"]*"|[^\s()"]+/g;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const MM_PER_UM = 1 / 1000;
const RADIANS_PER_DEGREE = Math.PI / 180;

export type Point = readonly [x: number, y: number];
export type Side = 'front' | 'back' | (string & {});
export interface Pad { x: number; y: number; w: number; h: number; side: Side }
export interface Dsn {
  outline: Point[];
  pads: Pad[];
  bbox: readonly [x0: number, y0: number, x1: number, y1: number];
}
export interface Wire { layer: string; width: number; points: Point[] }
export interface Ses { wires: Wire[]; vias: Point[] }

interface Box { w: number; h: number; cx: number; cy: number }
interface Pin { padstack: string; x: number; y: number; rotation: number }

const NO_BOX: Box = { w: 0, h: 0, cx: 0, cy: 0 };

/** The first top-level form, with quotes removed. */
export function parse(text: string): SList {
  const stack: SList[] = [[]];
  for (const [token] of text.replace('(string_quote ")', '(string_quote)').matchAll(TOKEN)) {
    if (token === '(') {
      stack.push([]);
    } else if (token === ')') {
      const node = stack.pop();
      const parent = stack.at(-1);
      if (!node || !parent) throw new Error('specctra: unbalanced )');
      parent.push(node);
    } else {
      stack.at(-1)!.push(token.startsWith('"') ? token.slice(1, -1) : token);
    }
  }
  const root = stack[0]?.[0];
  if (!Array.isArray(root)) throw new Error('specctra: no top-level list');
  return root;
}

/** Every form named `name` under `node`, not looking inside a match. */
function walk(node: SList, name: string): SList[] {
  return node.flatMap(child => {
    if (!Array.isArray(child)) return [];
    return child[0] === name ? [child] : walk(child, name);
  });
}

/** The atoms of `nodes` that are numbers. */
const numbers = (nodes: SList): number[] =>
  nodes.flatMap(node => (typeof node === 'string' && NUMBER.test(node) ? [Number(node)] : []));

const pairs = (values: number[]): Point[] =>
  Array.from({ length: Math.floor(values.length / 2) }, (_, index) => [values[2 * index]!, values[2 * index + 1]!] as const);

const required = (node: SList, name: string): SList => {
  const found = one(node, name);
  if (!found) throw new Error(`specctra: no ${name}`);
  return found;
};

function shapeBox(shape: SList): Box {
  const inner = shape[1];
  const form = Array.isArray(inner) ? inner : shape;
  const values = numbers(form.slice(2));
  switch (form[0]) {
    case 'circle': {
      const [diameter = 0, cx = 0, cy = 0] = values;
      return { w: diameter, h: diameter, cx: values.length >= 3 ? cx : 0, cy: values.length >= 3 ? cy : 0 };
    }
    case 'rect': {
      const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = values;
      return { w: Math.abs(x1 - x0), h: Math.abs(y1 - y0), cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
    }
    case 'polygon':
    case 'path': {
      const [aperture = 0, ...coordinates] = values;
      const xs = coordinates.filter((_, index) => index % 2 === 0);
      const ys = coordinates.filter((_, index) => index % 2 === 1);
      if (xs.length === 0) return { w: aperture, h: aperture, cx: 0, cy: 0 };
      const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      return { w: maxX - minX + aperture, h: maxY - minY + aperture, cx: (maxX + minX) / 2, cy: (maxY + minY) / 2 };
    }
    default:
      return NO_BOX;
  }
}

function boardOutline(structure: SList): Point[] {
  for (const boundary of walk(structure, 'boundary')) {
    const path = one(boundary, 'path');
    if (!path) continue;
    const outline = pairs(numbers(path.slice(2)).slice(1))   // after the aperture width
      .map(([x, y]): Point => [x * MM_PER_UM, -y * MM_PER_UM]);
    if (outline.length > 0) return outline;
  }
  return [];
}

function imagePin(pin: SList): Pin | null {
  const [, padstack, second] = pin;
  if (typeof padstack !== 'string') return null;
  const rotated = Array.isArray(second) && second[0] === 'rotate';
  const [x, y] = numbers(pin.slice(rotated ? 4 : 3));
  if (x === undefined || y === undefined) return null;
  return { padstack, x, y, rotation: rotated ? Number(second[1]) : 0 };
}

function placedPads(place: SList, pins: Pin[], stacks: Map<string, Box>): Pad[] {
  const [px, py] = numbers(place.slice(2, 4));   // (place REF x y side rot ...)
  if (px === undefined || py === undefined) return [];
  const side = typeof place[4] === 'string' ? place[4] : 'front';
  const rotation = typeof place[5] === 'string' ? Number(place[5]) : 0;
  const cos = Math.cos(rotation * RADIANS_PER_DEGREE);
  const sin = Math.sin(rotation * RADIANS_PER_DEGREE);
  return pins.map(pin => {
    const { w, h, cx, cy } = stacks.get(pin.padstack) ?? NO_BOX;
    const dx = (side === 'back' ? -pin.x : pin.x) + cx;
    const dy = pin.y + cy;
    const quarterTurn = Math.abs(round((rotation + pin.rotation) / 90)) % 2 === 1;
    return {
      x: (px + dx * cos - dy * sin) * MM_PER_UM,
      y: -(py + dx * sin + dy * cos) * MM_PER_UM,
      w: (quarterTurn ? h : w) * MM_PER_UM,
      h: (quarterTurn ? w : h) * MM_PER_UM,
      side,
    };
  });
}

export function loadDsn(path: string): Dsn {
  const pcb = parse(readFileSync(path, 'utf8'));
  const outline = boardOutline(required(pcb, 'structure'));
  const library = required(pcb, 'library');
  const stacks = new Map(kids(library, 'padstack').map(stack => {
    const shape = one(stack, 'shape');
    return [String(stack[1]), shape ? shapeBox(shape) : NO_BOX] as const;
  }));
  const images = new Map(kids(library, 'image').map(image =>
    [String(image[1]), kids(image, 'pin').flatMap(pin => imagePin(pin) ?? [])] as const));
  const pads = kids(required(pcb, 'placement'), 'component').flatMap(component =>
    kids(component, 'place').flatMap(place => placedPads(place, images.get(String(component[1])) ?? [], stacks)));
  const corners: readonly Point[] = outline.length > 0 ? outline : pads.map(pad => [pad.x, pad.y] as const);
  const xs = corners.length > 0 ? corners.map(([x]) => x) : [0];
  const ys = corners.length > 0 ? corners.map(([, y]) => y) : [0];
  return { outline, pads, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
}

export function loadSes(path: string): Ses {
  const session = parse(readFileSync(path, 'utf8'));
  const resolution = walk(session, 'resolution').find(form => form.length >= 3 && form[1] === 'um');
  const mmPerUnit = 1 / (1000 * (resolution ? Number(resolution[2]) : 1));
  const toMm = ([x, y]: Point): Point => [x * mmPerUnit, -y * mmPerUnit];
  const routes = one(session, 'routes');
  if (!routes) return { wires: [], vias: [] };
  const nets = walk(routes, 'net');
  const wires = nets.flatMap(net => kids(net, 'wire').flatMap(wire => kids(wire, 'path').map(path => {
    const [width = 0, ...coordinates] = numbers(path.slice(2));
    return { layer: String(path[1]), width: width * mmPerUnit, points: pairs(coordinates).map(toMm) };
  })));
  const vias = nets.flatMap(net => kids(net, 'via').flatMap(via => pairs(numbers(via.slice(2))).slice(0, 1).map(toMm)));
  return { wires, vias };
}
