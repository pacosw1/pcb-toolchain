// Reference blocks on B.SilkS ("info_back", user request 2026-10-11: useful reference on the bottom silkscreen): text blocks,
// framed panels and a grid of panels, placed with the bottom obstacles of the back labels. tools/board_labels.ts runs this last.
import { lineText, textText } from './board-items.ts';
import { rectBox, type Box, type SilkText, type Xy } from './board-silk.ts';
import type { Board, Footprint } from './board-types.ts';
import { fixed } from './py-compat.mjs';
import { labelExtent, strokeOf, type LabelBoard } from './label-board.ts';

const PIN_MIN = 1.0; // default text height
const LAYER = 'B.SilkS';
const STEP = 0.5;
const WINDOW_MARGIN = 0.5;
const CHAMFER = 0.8;
const ICON_GAP = 0.8;
const LEFT_TOP = { h: 'left', v: 'top', angle: 0 } as const;
const PART_LINE_PREFIX = /^TP(\d+)$/;

export interface InfoBlock {
  id?: string; kind?: 'text' | 'columns' | 'parts' | 'testpoints' | 'panel'; body_kind?: InfoBlock['kind'];
  lines?: string[]; columns?: string[][]; parts?: (string | null)[][]; rows?: number; bare?: boolean; split?: boolean;
  near?: Xy; h?: number; h_head?: number; pad?: number; line_pitch?: number; col_gap?: number; min_w?: number;
  icon?: string; header?: string; extra?: string[]; rect?: Box;
}
export interface InfoLayout { rows: string[][]; col_w?: number; gutter?: number; row_gap?: number; snap?: number; near?: Xy; span_single?: boolean; at?: Xy }

/** The drawing side of a pass: new items go through these, so they end up in its group. */
export interface InfoCanvas {
  board: Board; B: LabelBoard; tented: boolean; outline: Box; date: string; lines: string[]; skipped: string[];
  add: (make: (uuid: string) => string) => void;
}

const chunked = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

function partLine(footprints: Footprint[], entry: (string | null)[]): string {
  const [ref, role, short] = entry as [string, string | null, string | undefined];
  const footprint = footprints.find(item => item.reference === ref);
  if (!footprint) throw new Error(`board_labels: info_back parts: no footprint ${ref}`);
  if (entry.length <= 2) return `${ref} ${footprint.value}  ${role}`;
  if (!footprint.value.startsWith(short!)) throw new Error(`board_labels: info_back parts: ${ref} "${short}" is not the start of ${footprint.value}`);
  return `${ref} ${short}${role ? `  ${role}` : ''}`; // a short part name must be the start of the footprint value (the BOM part)
}

function testPointLines(board: Board, bare: boolean): string[] {
  return board.footprints.flatMap(footprint => {
    const number = PART_LINE_PREFIX.exec(footprint.reference)?.[1];
    if (number === undefined) return [];
    const nets = [...new Set(footprint.pads.map(pad => pad.net).filter(Boolean))].sort();
    const net = (nets[0] ?? '-').replace(/^\/+/, '').replaceAll('PWR-24V/', '');
    return [{ number: Number(number), line: `${bare ? '' : 'TP'}${number} ${net}` }];
  }).sort((a, b) => a.number - b.number).map(item => item.line);
}

/** The columns of lines of a block. Sources: the board itself (part values, test-point nets) and the config (curated wording). */
export function infoColumns(board: Board, block: InfoBlock, date: string): string[][] {
  const kind = block.kind ?? 'text';
  if (kind === 'text') return [(block.lines ?? []).map(line => line.replaceAll('{date}', date))];
  if (kind === 'columns') return (block.columns ?? []).map(column => [...column]);
  if (kind === 'parts') {
    const lines = (block.parts ?? []).map(entry => partLine(board.footprints, entry));
    return chunked(lines, Number(block.rows ?? lines.length));
  }
  if (kind === 'testpoints') return chunked(testPointLines(board, Boolean(block.bare)), Number(block.rows ?? 10));
  throw new Error(`board_labels: info_back: unknown kind ${kind}`);
}

const widthOf = (text: string, height: number): number => {
  const box = labelExtent(text, height, height, LEFT_TOP, true);
  return box[2] - box[0];
};

function addText(canvas: InfoCanvas, text: string, height: number, at: Xy): void {
  canvas.add(uuid => textText({ text, at, layer: LAYER, size: height, thickness: strokeOf(height), h: 'left', v: 'top', mirrored: true, uuid }));
}

function windowOf([x0, y0, x1, y1]: Box): Box {
  return [x0 - WINDOW_MARGIN, y0 - WINDOW_MARGIN, x1 + WINDOW_MARGIN, y1 + WINDOW_MARGIN];
}

/** The place of a cell: over tented vias when the bottom mask covers them. */
const cellFree = ({ B, tented }: InfoCanvas, box: Box): boolean =>
  B.free(box, tented ? B.localOverVias(windowOf(box)) : B.local(windowOf(box)), 'title');

interface PanelSize { width: number; height: number; columns: string[][]; widths: number[]; body: string[]; headHeight: number; iconHeight: number }

function panelSize(canvas: InfoCanvas, block: InfoBlock): PanelSize {
  const height = Number(block.h ?? PIN_MIN);
  const head = Number(block.h_head ?? 1.6);
  const pad = Number(block.pad ?? 1.0);
  const pitch = height * Number(block.line_pitch ?? 1.6);
  const columns = infoColumns(canvas.board, { ...block, kind: block.body_kind ?? 'text' }, canvas.date);
  columns[columns.length - 1] = [...columns.at(-1)!, ...(block.extra ?? [])];
  const gap = Number(block.col_gap ?? 2.5);
  const body = columns.reduce((longest, column) => (column.length > longest.length ? column : longest));
  const iconHeight = block.icon ? head * 1.5 : 0; // icon "warning": a drawn triangle (the stroke-font sign does not render)
  const headWidth = (block.icon ? iconHeight * 1.15 + ICON_GAP : 0) + (block.header ? widthOf(block.header, head) : 0);
  const widths = columns.map(column => Math.max(0, ...column.map(text => widthOf(text, height))));
  const bodyWidth = widths.reduce((sum, width) => sum + width, 0) + gap * (columns.length - 1);
  const headHeight = block.header || block.icon ? Math.max(head, iconHeight) : 0;
  return {
    width: 2 * pad + Math.max(headWidth, bodyWidth, Number(block.min_w ?? 0)),
    height: 2 * pad + headHeight + (headHeight ? pad * 1.3 : 0) + body.length * pitch - (body.length ? pitch - height : 0),
    columns, widths, body, headHeight, iconHeight,
  };
}

function nearestFree(canvas: InfoCanvas, width: number, height: number, near: Xy): Box | null {
  const [x0, y0, x1, y1] = canvas.outline;
  let best: { distance: number; box: Box } | null = null;
  for (let y = y0; y + height < y1; y += STEP) {
    for (let x = x0; x + width < x1; x += STEP) {
      const box: Box = [x, y, x + width, y + height];
      const distance = Math.hypot((box[0] + box[2]) / 2 - near[0], (box[1] + box[3]) / 2 - near[1]);
      if ((best === null || distance < best.distance) && cellFree(canvas, box)) best = { distance, box };
    }
  }
  return best?.box ?? null;
}

/**
 * A framed panel (user request 2026-10-11: board description, features, warnings, key parts). Laid out in bottom-view coordinates
 * (u to the right as seen from below, which is -x on the board, v down) and mirrored onto the board: a frame with 0.8 mm
 * chamfered corners, a header with an optional icon and a rule under it, then the body lines. Frame and rule: stroke of 1 mm text.
 */
export function drawPanel(canvas: InfoCanvas, block: InfoBlock, cell?: Box): Box | null {
  const size = panelSize(canvas, block);
  const [x0, y0, x1, y1] = canvas.outline;
  const box = cell ?? nearestFree(canvas, size.width, size.height, block.near ?? [(x0 + x1) / 2, (y0 + y1) / 2]);
  if (!box) {
    canvas.lines.push(`  info ${block.id}: no free place for ${fixed(size.width, 1)} x ${fixed(size.height, 1)} mm`);
    return null;
  }
  canvas.B.place(box, block.id ?? 'panel', 'title');
  const [width, height] = [box[2] - box[0], box[3] - box[1]]; // a grid cell stretches the frame
  const pad = Number(block.pad ?? 1.0);
  const textHeight = Number(block.h ?? PIN_MIN);
  const head = Number(block.h_head ?? 1.6);
  const pitch = textHeight * Number(block.line_pitch ?? 1.6);
  const gap = Number(block.col_gap ?? 2.5);
  const boardX = (u: number): number => box[2] - u; // bottom view: u from the panel's left edge as seen from below
  const line = (u0: number, v0: number, u1: number, v1: number): void => canvas.add(uuid =>
    lineText({ start: [boardX(u0), box[1] + v0], end: [boardX(u1), box[1] + v1], layer: LAYER, width: strokeOf(1.0), uuid }));
  const text = (value: string, textSize: number, left: number, top: number): void => {
    const extent = labelExtent(value, textSize, textSize, LEFT_TOP, true);
    // the glyph box spans left .. left + width in the bottom view
    addText(canvas, value, textSize, [boardX(left + extent[2] - extent[0]) - extent[0], box[1] + top - extent[1]]);
  };
  const c = CHAMFER;
  for (const edge of [[c, 0, width - c, 0], [width, c, width, height - c], [width - c, height, c, height], [0, height - c, 0, c],
    [0, c, c, 0], [width - c, 0, width, c], [width, height - c, width - c, height], [c, height, 0, height - c]] as const) line(...edge);
  let v = pad;
  if (size.headHeight) {
    let u = pad;
    if (block.icon) {
      const [iconWidth, iconTop] = [size.iconHeight * 1.15, v + (size.headHeight - size.iconHeight) / 2];
      line(u, iconTop + size.iconHeight, u + iconWidth, iconTop + size.iconHeight);
      line(u + iconWidth, iconTop + size.iconHeight, u + iconWidth / 2, iconTop);
      line(u + iconWidth / 2, iconTop, u, iconTop + size.iconHeight);
      const bang = size.iconHeight * 0.55;
      text('!', bang, u + iconWidth / 2 - widthOf('!', bang) / 2, iconTop + size.iconHeight * 0.36);
      u += iconWidth + ICON_GAP;
    }
    if (block.header) text(block.header, head, u, v + (size.headHeight - head) / 2);
    v += size.headHeight + pad * 0.65;
    line(pad * 0.5, v, width - pad * 0.5, v);
    v += pad * 0.65;
  }
  let u = pad;
  size.columns.forEach((column, index) => {
    column.forEach((value, row) => text(value, textHeight, u, v + row * pitch));
    u += size.widths[index]! + gap;
  });
  canvas.lines.push(`  info ${block.id}: panel ${fixed(width, 1)} x ${fixed(height, 1)} mm at (${fixed(box[0], 2)}, ${fixed(box[1], 2)}), ${size.body.length} lines`);
  return box;
}

/** A block of plain text, each column kept together, at the free spot nearest to its "near". */
export function drawTextBlock(canvas: InfoCanvas, block: InfoBlock): boolean {
  const height = Number(block.h ?? PIN_MIN);
  const pitch = height * Number(block.line_pitch ?? 1.45);
  const columns = infoColumns(canvas.board, block, canvas.date);
  const gap = Number(block.col_gap ?? 2.0);
  let x = 0;
  const boxes = columns.map(column => {
    const width = Math.max(...column.map(text => widthOf(text, height)));
    const box = { x, width, column };
    x += width + gap;
    return box;
  });
  const [width, total] = [x - gap, pitch * Math.max(...columns.map(column => column.length))];
  const [x0, y0, x1, y1] = canvas.outline;
  const near = block.near ?? [(x0 + x1) / 2, (y0 + y1) / 2];
  let best: { distance: number; box: Box } | null = null;
  for (let k = 0; k < Math.trunc((y1 - y0) / STEP); k++) {
    for (let j = 0; j < Math.trunc((x1 - x0) / STEP); j++) {
      const box: Box = [x0 + j * STEP, y0 + k * STEP, x0 + j * STEP + width, y0 + k * STEP + total];
      const distance = Math.hypot((box[0] + box[2]) / 2 - near[0], (box[1] + box[3]) / 2 - near[1]);
      if ((best === null || distance < best.distance) && canvas.B.free(box, canvas.B.local(windowOf(box)), 'title')) best = { distance, box };
    }
  }
  const name = block.id ?? block.kind;
  if (!best) {
    canvas.skipped.push(`${name}: no free place for ${fixed(width, 1)} x ${fixed(total, 1)} mm`);
    return false;
  }
  const { box } = best;
  canvas.B.place(box, block.id ?? 'info', 'title');
  for (const { x: left, width: columnWidth, column } of boxes) {
    column.forEach((text, row) => {
      const extent = labelExtent(text, height, height, LEFT_TOP, true);
      // mirrored text: the lines share their right edge in board coordinates, so they read left aligned from the bottom side
      addText(canvas, text, height, [box[0] + left + columnWidth - extent[2], box[1] + row * pitch - extent[1]]);
    });
  }
  canvas.lines.push(`  info ${name}: ${fixed(width, 1)} x ${fixed(total, 1)} mm at (${fixed(box[0], 2)}, ${fixed(box[1], 2)}), h ${height} mm, ${columns.flat().length} lines`);
  return true;
}

interface Cell { block: InfoBlock; box: Box }

/**
 * info_layout (user 2026-10-11: "aligned to some kind of grid ... it looks messy"): the listed panels as one grid as seen from
 * the bottom: rows of panels, every column the same width, every panel of a row the same height, gutter mm between columns,
 * row_gap between rows. The origin snaps to snap mm and goes to the free position nearest to "near"; "at" is a fixed origin
 * (checked, no search); "span_single": a one-panel row spans the grid. Returns the number of panels drawn.
 */
export function drawGrid(canvas: InfoCanvas, blocks: InfoBlock[], layout: InfoLayout): number {
  const byId = new Map(blocks.map(block => [block.id, block]));
  const rows = layout.rows.map(row => row.map(id => byId.get(id)!));
  const sizes = new Map(rows.flat().map(block => [block.id, panelSize(canvas, block)]));
  const columnCount = Math.max(...rows.map(row => row.length));
  const spanning = new Set(rows.filter(row => row.length === 1 && layout.span_single).map(row => row[0]!.id)); // not in col_w
  const columnWidth = Math.max(Number(layout.col_w ?? 0), ...[...sizes].filter(([id]) => !spanning.has(id)).map(([, size]) => size.width));
  const [gutter, rowGap, snap] = [Number(layout.gutter ?? 3.0), Number(layout.row_gap ?? 3.0), Number(layout.snap ?? 0.5)];
  const rowHeights = rows.map(row => Math.max(...row.map(block => sizes.get(block.id)!.height)));
  const gridWidth = columnCount * columnWidth + (columnCount - 1) * gutter;
  const gridHeight = rowHeights.reduce((sum, height) => sum + height, 0) + (rows.length - 1) * rowGap;
  const [x0, y0, x1, y1] = canvas.outline;
  const near = layout.near ?? [(x0 + x1) / 2, (y0 + y1) / 2];
  // right: board x of the grid's left edge seen from below, which is its right edge on the board
  const cells = (right: number, top: number): Cell[] => {
    const found: Cell[] = [];
    let v = top;
    rows.forEach((row, index) => {
      const height = rowHeights[index]!;
      if (row.length === 1 && layout.span_single) found.push({ block: row[0]!, box: [right - gridWidth, v, right, v + height] });
      else row.forEach((block, column) => {
        const u = column * (columnWidth + gutter);
        found.push({ block, box: [right - u - columnWidth, v, right - u, v + height] });
      });
      v += height + rowGap;
    });
    return found;
  };
  let best: { distance: number; right: number; top: number } | null = null;
  if (layout.at) {
    const [right, top] = layout.at;
    const taken = cells(right, top).filter(({ box }) => !cellFree(canvas, box));
    if (taken.length) {
      for (const { block, box } of taken) canvas.skipped.push(`info_layout: cell ${block.id} ${box.map(value => fixed(value, 1)).join(' ')} blocked by ${canvas.B.blockers(box).slice(0, 4).join(', ')}`);
      canvas.skipped.push(`info_layout: the grid at ${layout.at.join(' ')} is not free`);
      return 0;
    }
    best = { distance: 0, right, top };
  } else {
    for (let ky = Math.ceil(y0 / snap); ky <= Math.trunc((y1 - gridHeight) / snap); ky++) {
      for (let kx = Math.ceil((x0 + gridWidth) / snap); kx <= Math.trunc(x1 / snap); kx++) {
        const [right, top] = [kx * snap, ky * snap];
        const distance = Math.hypot(right - gridWidth / 2 - near[0], top + gridHeight / 2 - near[1]);
        if ((best === null || distance < best.distance) && cells(right, top).every(({ box }) => cellFree(canvas, box))) best = { distance, right, top };
      }
    }
  }
  if (!best) {
    canvas.skipped.push(`info_layout: no free place for the ${fixed(gridWidth, 1)} x ${fixed(gridHeight, 1)} mm grid`);
    return 0;
  }
  const drawn = cells(best.right, best.top).filter(({ block, box }) => drawPanel(canvas, block, box)).length;
  canvas.lines.push(`  info_layout: ${rows.length} rows x ${columnCount} columns, cell width ${fixed(columnWidth, 1)} mm, grid ${fixed(gridWidth, 1)} x ${fixed(gridHeight, 1)} mm at (${fixed(best.right - gridWidth, 2)}, ${fixed(best.top, 2)})`);
  return drawn;
}

/** Every back text already on the board is a placed block, so a new block keeps TITLE_GAP to it. */
export function holdBackTexts(B: LabelBoard, texts: SilkText[]): void {
  for (const text of texts) if (text.layer === LAYER) B.place(text.ink, text.text, 'title');
}

export const edgesBox = (board: Board): Box => rectBox(board.edges_bbox);
