// Pixel-art silkscreen icons for the boards.
//
// Bitmaps: tools/pixel-art/<name>.txt of the project. '#' is a pixel, '.' is empty. A line that starts with ';' is a comment.
// All pixel rows have the same length.
//
//   tools/pixel-art.ts preview [<name> ...]
//       Write hardware-design/boards/_art/<name>.png (all bitmaps when no name is given).
//   tools/pixel-art.ts apply <board.kicad_pcb> <name> --at <x_mm> <y_mm> [--layer B.SilkS|F.SilkS] [--pixel 0.5]
//       Put the icon on the board, centred at (x, y) in board coordinates. The shapes go in one group "pixel-art <name>". A rerun
//       removes the old group and its shapes first. Also writes the PNG preview.
//
// Each horizontal run of pixels is one filled rectangle. The rectangle has a SILK_W stroke (JLC silkscreen minimum line
// 0.153 mm) and is inset by SILK_W / 2, so its outer edge is the pixel edge and the runs of adjacent rows touch. On B.SilkS the
// art is mirrored in x, so it reads correctly from the bottom side. Check the result with tools/check_pixel_art.ts.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { BoardEdit, itemIds, saveBoardInPlace } from './lib/board-edit.ts';
import { rectText } from './lib/board-items.ts';
import { parseFlags, runMain, UsageError } from './lib/cli.ts';
import { fixed, floatRepr, pyRepr } from './lib/py-compat.mjs';
import { pyFloat } from './lib/py-numbers.ts';
import { projectRoot } from './lib/project-root.mjs';

const PIXEL_MIN_MM = 0.4;
const SILK_W = 0.16;
const PREFIX = 'pixel-art ';
const LAYERS = ['B.SilkS', 'F.SilkS'];
/** Preview: solder mask green, silkscreen white, SCALE px per art pixel, a 2-pixel border. */
const BACKGROUND = [0x1e, 0x4d, 0x2b] as const;
const INK = [0xf4, 0xf4, 0xf0] as const;
const SCALE = 16;
const BORDER = 2;
const USAGE = 'usage: tools/pixel-art.ts {preview [NAME ...] | apply BOARD NAME --at X Y [--layer L] [--pixel MM]}';

const stop = (message: string): UsageError => new UsageError(message, 1);
const artDir = (root: string): string => join(root, 'tools', 'pixel-art');

export function parseArt(text: string, path: string): string[] {
  const rows = text.split('\n').filter(line => line.trim() && !line.startsWith(';'));
  if (!rows.length) throw stop(`${path}: no pixel rows`);
  if (new Set(rows.map(row => row.length)).size !== 1) throw stop(`${path}: rows have different lengths`);
  const bad = [...new Set(rows.join(''))].filter(c => c !== '#' && c !== '.').sort();
  if (bad.length) throw stop(`${path}: characters other than # and .: ${pyRepr(bad)}`);
  return rows;
}

function load(root: string, name: string): string[] {
  const path = join(artDir(root), `${name}.txt`);
  return parseArt(readFileSync(path, 'utf8'), path);
}

export interface Run { row: number; first: number; last: number }

/** Each horizontal run of '#'. */
export function runs(rows: string[]): Run[] {
  return rows.flatMap((text, row) => [...text.matchAll(/#+/g)].map(match => ({ row, first: match.index, last: match.index + match[0].length - 1 })));
}

function pngChunk(kind: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(kind, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** The bitmap as an 8-bit RGB PNG. */
export function png(rows: string[]): Buffer {
  const width = (rows[0]!.length + 2 * BORDER) * SCALE;
  const height = (rows.length + 2 * BORDER) * SCALE;
  const raw = Buffer.alloc(height * (1 + width * 3));
  let at = 0;
  for (let y = 0; y < height; y++) {
    at += 1;
    const row = rows[Math.floor(y / SCALE) - BORDER];
    for (let x = 0; x < width; x++) {
      const on = row?.[Math.floor(x / SCALE) - BORDER] === '#';
      raw.set(on ? INK : BACKGROUND, at);
      at += 3;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
}

function preview(root: string, names: string[]): void {
  const all = names.length ? names : readdirSync(artDir(root)).filter(name => name.endsWith('.txt')).map(name => name.slice(0, -4)).sort();
  for (const name of all) {
    const rows = load(root, name);
    const path = join(root, 'hardware-design', 'boards', '_art', `${name}.png`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, png(rows));
    console.log(`${name}: ${rows[0]!.length} x ${rows.length} pixels, ${runs(rows).length} runs -> ${relative(root, path)}`);
  }
}

export interface ArtPlace { x: number; y: number; layer: string; pixel: number }

/** The filled rectangles of a bitmap, centred on the place. */
export function artRectangles(rows: string[], { x, y, layer, pixel }: ArtPlace, next: () => string): { uuid: string; text: string }[] {
  const columns = rows[0]!.length;
  const left = x - columns * pixel / 2;
  const top = y - rows.length * pixel / 2;
  const inset = SILK_W / 2;
  return runs(rows).map(({ row, first, last }) => {
    const [a, b] = layer === 'B.SilkS' ? [columns - 1 - last, columns - first] : [first, last + 1];
    const uuid = next();
    return { uuid, text: rectText({ start: [left + a * pixel + inset, top + row * pixel + inset], end: [left + b * pixel - inset, top + (row + 1) * pixel - inset],
      layer, width: SILK_W, filled: true, uuid }) };
  });
}

function apply(root: string, pcb: string, name: string, place: ArtPlace): void {
  if (place.pixel < PIXEL_MIN_MM) throw stop(`pixel size ${floatRepr(place.pixel)} mm is less than the minimum ${PIXEL_MIN_MM} mm`);
  const rows = load(root, name);
  const board = readFileSync(pcb, 'utf8');
  const edit = new BoardEdit(board);
  for (const group of edit.groups().filter(item => item.name === PREFIX + name)) edit.removeGroup(group);
  const next = itemIds(board, 'pixel-art');
  const rectangles = artRectangles(rows, place, next);
  for (const rectangle of rectangles) edit.add(rectangle.text);
  edit.addGroup(PREFIX + name, rectangles.map(rectangle => rectangle.uuid), next());
  saveBoardInPlace(pcb, edit.text());
  preview(root, [name]);
  const size = `${fixed(rows[0]!.length * place.pixel, 2)} x ${fixed(rows.length * place.pixel, 2)}`;
  console.log(`${name}: ${rectangles.length} rectangles on ${place.layer}, pixel ${floatRepr(place.pixel)} mm, ${size} mm centred at (${floatRepr(place.x)}, ${floatRepr(place.y)})`);
}

function number(text: string): number {
  try {
    return pyFloat(text);
  } catch {
    throw new UsageError(USAGE);
  }
}

function applyCommand(root: string, argv: string[]): void {
  const at = argv.indexOf('--at');
  if (at < 0 || at + 2 >= argv.length) throw new UsageError(USAGE);
  const [x, y] = [number(argv[at + 1]!), number(argv[at + 2]!)];
  const { values, positionals } = parseFlags(argv.toSpliced(at, 3), { layer: { type: 'string' }, pixel: { type: 'string' } }, USAGE);
  const [pcb, name] = positionals;
  const layer = values.layer ?? 'B.SilkS';
  if (positionals.length !== 2 || !LAYERS.includes(layer) || pcb === undefined || name === undefined) throw new UsageError(USAGE);
  if (!existsSync(pcb)) throw new Error(`no board ${pcb}`);
  apply(root, pcb, name, { x, y, layer, pixel: values.pixel === undefined ? 0.5 : number(values.pixel) });
}

function main([command, ...argv]: string[]): number {
  const root = projectRoot();
  if (command === 'preview') preview(root, argv);
  else if (command === 'apply') applyCommand(root, argv);
  else throw new UsageError(USAGE);
  return 0;
}

runMain(import.meta.url, main);
