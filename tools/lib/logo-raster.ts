// A PNG logo as rectangles of silk: read the image, keep its dark part, resample it to the silk pixel grid and join the runs.
// The resampling is Pillow's Image.resize with LANCZOS on an 8-bit image, fixed-point sums included, so a logo keeps the pixels
// it had when Pillow made it.
import { inflateSync } from 'node:zlib';
import { round } from './py-numbers.ts';

export interface Gray { width: number; height: number; pixels: Uint8Array }
/** x0, y0, x1, y1 in millimetres, from the top left of the logo. */
export type LogoRect = readonly [number, number, number, number];
export interface Logo { rects: LogoRect[]; width: number; height: number }

const SIGNATURE = '89504e470d0a1a0a';
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DARK = 128;
const LANCZOS_SUPPORT = 3;
const PRECISION_BITS = 22; // Pillow: 32 - 8 - 2
const ONE = 2 ** PRECISION_BITS;

function chunks(file: Buffer): Map<string, Buffer[]> {
  const found = new Map<string, Buffer[]>();
  for (let at = 8; at < file.length;) {
    const length = file.readUInt32BE(at);
    const kind = file.toString('latin1', at + 4, at + 8);
    found.set(kind, [...(found.get(kind) ?? []), file.subarray(at + 8, at + 8 + length)]);
    at += length + 12;
  }
  return found;
}

function paeth(a: number, b: number, c: number): number {
  const [pa, pb, pc] = [Math.abs(b - c), Math.abs(a - c), Math.abs(a + b - 2 * c)];
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function unfilter(data: Buffer, height: number, stride: number, bytes: number): Uint8Array {
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = data[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const raw = data[y * (stride + 1) + 1 + x]!;
      const left = x >= bytes ? out[y * stride + x - bytes]! : 0;
      const up = y ? out[(y - 1) * stride + x]! : 0;
      const corner = x >= bytes && y ? out[(y - 1) * stride + x - bytes]! : 0;
      const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, corner)][filter];
      if (predicted === undefined) throw new Error(`PNG: filter ${filter}`);
      out[y * stride + x] = raw + predicted;
    }
  }
  return out;
}

/** Red, green, blue and alpha of the pixel at `index`. */
function pixelReader(rows: Uint8Array, colour: number, palette: Buffer | undefined, alpha: Buffer | undefined): (index: number) => [number, number, number, number] {
  const channels = CHANNELS[colour]!;
  return index => {
    const at = index * channels;
    if (colour === 3) {
      const entry = rows[at]!;
      return [palette![entry * 3]!, palette![entry * 3 + 1]!, palette![entry * 3 + 2]!, alpha?.[entry] ?? 255];
    }
    if (colour === 0 || colour === 4) return [rows[at]!, rows[at]!, rows[at]!, colour === 4 ? rows[at + 1]! : 255];
    return [rows[at]!, rows[at + 1]!, rows[at + 2]!, colour === 6 ? rows[at + 3]! : 255];
  };
}

/** An 8-bit, non-interlaced PNG laid over white, as ITU-R 601 grey (Pillow's convert('L')). */
export function grayOverWhite(file: Buffer): Gray {
  if (file.toString('hex', 0, 8) !== SIGNATURE) throw new Error('not a PNG');
  const parts = chunks(file);
  const header = parts.get('IHDR')?.[0];
  if (!header) throw new Error('PNG: no header');
  const [width, height, depth, colour, interlace] = [header.readUInt32BE(0), header.readUInt32BE(4), header[8]!, header[9]!, header[12]!];
  const channels = CHANNELS[colour];
  if (depth !== 8 || interlace !== 0 || channels === undefined) throw new Error(`PNG: depth ${depth}, colour ${colour}, interlace ${interlace} not read`);
  const rows = unfilter(inflateSync(Buffer.concat(parts.get('IDAT') ?? [])), height, width * channels, channels);
  const read = pixelReader(rows, colour, parts.get('PLTE')?.[0], parts.get('tRNS')?.[0]);
  const pixels = new Uint8Array(width * height);
  for (let index = 0; index < pixels.length; index++) {
    const [red, green, blue, alpha] = read(index);
    const over = (value: number): number => Math.round((value * alpha + 255 * (255 - alpha)) / 255);
    pixels[index] = (over(red) * 19595 + over(green) * 38470 + over(blue) * 7471 + 0x8000) >> 16;
  }
  return { width, height, pixels };
}

/** The image cut to the box of its dark pixels. */
export function cropDark({ width, height, pixels }: Gray): Gray {
  let [left, top, right, bottom] = [width, height, 0, 0];
  pixels.forEach((value, index) => {
    if (value >= DARK) return;
    const [x, y] = [index % width, Math.floor(index / width)];
    [left, top, right, bottom] = [Math.min(left, x), Math.min(top, y), Math.max(right, x + 1), Math.max(bottom, y + 1)];
  });
  if (right <= left) throw new Error('the logo has no dark pixel');
  const cut = new Uint8Array((right - left) * (bottom - top));
  for (let y = top; y < bottom; y++) cut.set(pixels.subarray(y * width + left, y * width + right), (y - top) * (right - left));
  return { width: right - left, height: bottom - top, pixels: cut };
}

const sinc = (x: number): number => (x === 0 ? 1 : Math.sin(x * Math.PI) / (x * Math.PI));
const lanczos = (x: number): number => (x >= -LANCZOS_SUPPORT && x < LANCZOS_SUPPORT ? sinc(x) * sinc(x / LANCZOS_SUPPORT) : 0);

interface Taps { first: number; weights: number[] }

/** Pillow's precompute_coeffs and normalize_coeffs_8bpc. */
function taps(size: number, target: number): Taps[] {
  const scale = size / target;
  const filterScale = Math.max(scale, 1);
  const support = LANCZOS_SUPPORT * filterScale;
  return Array.from({ length: target }, (_, index) => {
    const centre = (index + 0.5) * scale;
    const first = Math.max(0, Math.trunc(centre - support + 0.5));
    const last = Math.min(size, Math.trunc(centre + support + 0.5));
    const raw = Array.from({ length: last - first }, (_unused, k) => lanczos((k + first - centre + 0.5) / filterScale));
    const sum = raw.reduce((total, weight) => total + weight, 0);
    return { first, weights: raw.map(weight => Math.trunc(weight / sum * ONE + (weight < 0 ? -0.5 : 0.5))) };
  });
}

function filtered(read: (index: number) => number, { first, weights }: Taps): number {
  const sum = weights.reduce((total, weight, k) => total + read(first + k) * weight, ONE / 2);
  return Math.min(255, Math.max(0, Math.floor(sum / ONE)));
}

/** Image.resize((width, height), LANCZOS): across, then down, each pass back to 8 bits. */
export function resize({ width, height, pixels }: Gray, targetWidth: number, targetHeight: number): Gray {
  const across = taps(width, targetWidth);
  const wide = new Uint8Array(targetWidth * height);
  for (let y = 0; y < height; y++) across.forEach((tap, x) => { wide[y * targetWidth + x] = filtered(k => pixels[y * width + k]!, tap); });
  const down = taps(height, targetHeight);
  const out = new Uint8Array(targetWidth * targetHeight);
  down.forEach((tap, y) => { for (let x = 0; x < targetWidth; x++) out[y * targetWidth + x] = filtered(k => wide[k * targetWidth + x]!, tap); });
  return { width: targetWidth, height: targetHeight, pixels: out };
}

function darkRuns({ width, pixels }: Gray, y: number): string[] {
  const found: string[] = [];
  for (let x = 0; x < width;) {
    if (pixels[y * width + x]! >= DARK) { x += 1; continue; }
    const start = x;
    while (x < width && pixels[y * width + x]! < DARK) x += 1;
    found.push(`${start},${x}`);
  }
  return found;
}

/** One rectangle per run of a row; equal runs of adjacent rows join into a taller one. */
export function joinedRects(image: Gray, pixel: number): LogoRect[] {
  const rects: LogoRect[] = [];
  const open = new Map<string, number>();
  for (let y = 0; y <= image.height; y++) {
    const row = y < image.height ? darkRuns(image, y) : [];
    for (const [run, start] of open) {
      if (row.includes(run)) continue;
      const [x0, x1] = run.split(',').map(Number) as [number, number];
      rects.push([x0 * pixel, start * pixel, x1 * pixel, y * pixel]);
      open.delete(run);
    }
    for (const run of row) if (!open.has(run)) open.set(run, y);
  }
  return rects;
}

/** The dark pixels of the PNG at this width, on a grid of `pixel` mm. */
export function logoRects(file: Buffer, widthMm: number, pixel: number): Logo {
  const image = cropDark(grayOverWhite(file));
  const columns = Math.max(1, round(widthMm / pixel));
  const rows = Math.max(1, round(columns * image.height / image.width));
  return { rects: joinedRects(resize(image, columns, rows), pixel), width: columns * pixel, height: rows * pixel };
}
