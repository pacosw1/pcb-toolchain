// A small RGB canvas and PNG writer, so a tool can draw a view without an image library.
//
// Coordinates truncate to whole pixels and lines follow Pillow's ImageDraw, the library these frames were drawn with.
// Text is the 5x7 bitmap font below at three times its size: printable ASCII, anything else shows as "?".
import { crc32, deflateSync } from 'node:zlib';

export type Rgb = readonly [red: number, green: number, blue: number];
export type Xy = readonly [x: number, y: number];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BIT_DEPTH = 8;
const PNG_COLOUR_RGB = 2;
const FAST_DEFLATE = 1;
const FONT_SCALE = 3;
const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
const GLYPH_ADVANCE = 6;
const FIRST_GLYPH = 0x20;

// One glyph per ten hex digits: five columns, bit 0 at the top. Codes 0x20 to 0x7e.
const FONT = [
  '0000000000', '00005f0000', '0007000700', '147f147f14', '242a7f2a12', '2313086462', '3649562050', '0005030000',
  '001c224100', '0041221c00', '14083e0814', '08083e0808', '0050300000', '0808080808', '0060600000', '2010080402',
  '3e5149453e', '00427f4000', '4261514946', '2141454b31', '1814127f10', '2745454539', '3c4a494930', '0171090503',
  '3649494936', '064949291e', '0036360000', '0056360000', '0814224100', '1414141414', '0041221408', '0201510906',
  '324979413e', '7e1111117e', '7f49494936', '3e41414122', '7f4141221c', '7f49494941', '7f09090901', '3e4149497a',
  '7f0808087f', '00417f4100', '2040413f01', '7f08142241', '7f40404040', '7f020c027f', '7f0408107f', '3e4141413e',
  '7f09090906', '3e4151215e', '7f09192946', '4649494931', '01017f0101', '3f4040403f', '1f2040201f', '3f4038403f',
  '6314081463', '0708700807', '6151494543', '007f414100', '0204081020', '0041417f00', '0402010204', '4040404040',
  '0001020400', '2054545478', '7f48444438', '3844444420', '384444487f', '3854545418', '087e090102', '0c5252523e',
  '7f08040478', '00447d4000', '2040443d00', '7f10284400', '00417f4000', '7c04180478', '7c08040478', '3844444438',
  '7c14141408', '081414187c', '7c08040408', '4854545420', '043f444020', '3c4040207c', '1c2040201c', '3c4030403c',
  '4428102844', '0c5050503c', '4464544c44', '0008364100', '00007f0000', '0041360800', '1008081008',
];

/** Pillow's rounding of the wide-line offsets: half away from zero, and half towards zero. */
const roundUp = (value: number): number => Math.sign(value) * Math.floor(Math.abs(value) + 0.5);
const roundDown = (value: number): number => Math.sign(value) * Math.ceil(Math.abs(value) - 0.5);
const whole = ([x, y]: Xy): Xy => [Math.trunc(x), Math.trunc(y)];

export class Canvas {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 3);
  }

  colourAt(x: number, y: number): Rgb {
    const at = (y * this.width + x) * 3;
    return [this.pixels[at]!, this.pixels[at + 1]!, this.pixels[at + 2]!];
  }

  private point(x: number, y: number, colour: Rgb): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.pixels.set(colour, (y * this.width + x) * 3);
  }

  private span(x0: number, x1: number, y: number, colour: Rgb): void {
    for (let x = Math.max(x0, 0); x <= Math.min(x1, this.width - 1); x += 1) this.point(x, y, colour);
  }

  /** Bresenham without the last point, as Pillow draws one segment. */
  private segment([x0, y0]: Xy, [x1, y1]: Xy, colour: Rgb): void {
    const [dx, dy] = [Math.abs(x1 - x0), Math.abs(y1 - y0)];
    const [stepX, stepY] = [Math.sign(x1 - x0), Math.sign(y1 - y0)];
    const [major, minor] = dx > dy ? [dx, dy] : [dy, dx];
    let [x, y, error] = [x0, y0, 2 * minor - major];
    for (let index = 0; index < major; index += 1) {
      this.point(x, y, colour);
      if (error >= 0) {
        if (dx > dy) y += stepY;
        else x += stepX;
        error -= 2 * major;
      }
      error += 2 * minor;
      if (dx > dy) x += stepX;
      else y += stepY;
    }
  }

  /** A convex polygon, filled row by row from its leftmost to its rightmost crossing. */
  private fillConvex(corners: readonly Xy[], colour: Rgb): void {
    const rows = corners.map(([, y]) => y);
    for (let y = Math.min(...rows); y <= Math.max(...rows); y += 1) {
      const crossings = corners.flatMap(([ax, ay], index) => {
        const [bx, by] = corners[(index + 1) % corners.length]!;
        if (y < Math.min(ay, by) || y > Math.max(ay, by)) return [];
        return ay === by ? [ax, bx] : [ax + ((y - ay) * (bx - ax)) / (by - ay)];
      });
      this.span(roundUp(Math.min(...crossings)), roundDown(Math.max(...crossings)), y, colour);
    }
  }

  /** The four corners Pillow gives a line of `width` pixels. */
  private wideSegment([x0, y0]: Xy, [x1, y1]: Xy, width: number, colour: Rgb): void {
    const [dx, dy] = [x1 - x0, y1 - y0];
    if (dx === 0 && dy === 0) {
      this.point(x0, y0, colour);
      return;
    }
    const length = Math.hypot(dx, dy);
    const half = (width - 1) / 2;
    const [high, low] = [roundUp(half) / length, roundDown(half) / length];
    const [dxLow, dxHigh] = [roundDown(low * dy), roundDown(high * dy)];
    const [dyLow, dyHigh] = [roundUp(low * dx), roundUp(high * dx)];
    this.fillConvex([
      [x0 - dxLow, y0 + dyHigh], [x1 - dxLow, y1 + dyHigh], [x1 + dxHigh, y1 - dyLow], [x0 + dxHigh, y0 - dyLow],
    ], colour);
  }

  line(points: readonly Xy[], colour: Rgb, width = 1): void {
    const pixels = points.map(whole);
    pixels.slice(1).forEach((end, index) => {
      const start = pixels[index]!;
      if (width > 1) this.wideSegment(start, end, width, colour);
      else this.segment(start, end, colour);
    });
    const last = pixels.at(-1);
    if (width <= 1 && last) this.point(last[0], last[1], colour);
  }

  polygonOutline(points: readonly Xy[], colour: Rgb): void {
    const pixels = points.map(whole);
    pixels.forEach((start, index) => this.segment(start, pixels[(index + 1) % pixels.length]!, colour));
  }

  /** Filled, both corners included. */
  rectangle(corner: Xy, opposite: Xy, colour: Rgb): void {
    const [[x0, y0], [x1, y1]] = [whole(corner), whole(opposite)];
    for (let y = Math.max(y0, 0); y <= Math.min(y1, this.height - 1); y += 1) this.span(x0, x1, y, colour);
  }

  /** Filled, inside the box of the two corners. */
  ellipse(corner: Xy, opposite: Xy, colour: Rgb): void {
    const [[x0, y0], [x1, y1]] = [whole(corner), whole(opposite)];
    const [centreX, centreY] = [(x0 + x1) / 2, (y0 + y1) / 2];
    const [radiusX, radiusY] = [(x1 - x0 + 1) / 2, (y1 - y0 + 1) / 2];
    for (let y = y0; y <= y1; y += 1) {
      const reach = radiusX * Math.sqrt(Math.max(0, 1 - ((y - centreY) / radiusY) ** 2));
      this.span(Math.ceil(centreX - reach), Math.floor(centreX + reach), y, colour);
    }
  }

  text(left: number, top: number, value: string, colour: Rgb): void {
    [...value].forEach((character, index) => {
      const glyph = FONT[character.charCodeAt(0) - FIRST_GLYPH] ?? FONT['?'.charCodeAt(0) - FIRST_GLYPH]!;
      this.glyph(left + index * GLYPH_ADVANCE * FONT_SCALE, top, glyph, colour);
    });
  }

  private glyph(left: number, top: number, glyph: string, colour: Rgb): void {
    for (let column = 0; column < GLYPH_WIDTH; column += 1) {
      const bits = Number.parseInt(glyph.slice(2 * column, 2 * column + 2), 16);
      for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
        if ((bits >> row) & 1) this.block(left + column * FONT_SCALE, top + row * FONT_SCALE, colour);
      }
    }
  }

  private block(left: number, top: number, colour: Rgb): void {
    this.rectangle([left, top], [left + FONT_SCALE - 1, top + FONT_SCALE - 1], colour);
  }
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const frame = Buffer.alloc(body.length + 8);
  frame.writeUInt32BE(data.length, 0);
  body.copy(frame, 4);
  frame.writeUInt32BE(crc32(body), body.length + 4);
  return frame;
}

export function encodePng(canvas: Canvas): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(canvas.width, 0);
  header.writeUInt32BE(canvas.height, 4);
  header.set([PNG_BIT_DEPTH, PNG_COLOUR_RGB], 8);
  const stride = canvas.width * 3;
  const rows = Buffer.alloc((stride + 1) * canvas.height);   // each row starts with filter type 0
  for (let y = 0; y < canvas.height; y += 1) rows.set(canvas.pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return Buffer.concat([
    PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: FAST_DEFLATE })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
