// The grids of pcbtool corridor and suggest over a box of the board. Millimetres, y down. Corridor draws cells, suggest searches
// nodes: its nodes are at x0 + c * cell, the cells of the map are centred at x0 + (c + 0.5) * cell.
import { inPoly, shapeBox, shapeDist, type Box, type Shape } from './copper-gap.ts';
import { floorDiv } from './py-math.ts';
import { round } from './py-numbers.ts';
import type { Xy } from './route-spec.ts';

export interface Grid { x0: number; y0: number; cell: number; cols: number; rows: number }

const STEP_MM = 0.05;

/** A cell of at least `cell` that keeps the grid inside the cap: it grows in 0.05 mm steps. */
export function fitGrid(box: Box, cell: number, maxCols = 80, maxRows = 40): Grid {
  const [width, height] = [box[2] - box[0], box[3] - box[1]];
  const need = Math.max(cell, width / maxCols, height / maxRows);
  const size = need > cell ? round(Math.ceil(need / STEP_MM - 1e-9) * STEP_MM, 3) : cell;
  return { x0: box[0], y0: box[1], cell: size, cols: Math.max(1, Math.ceil(width / size - 1e-9)), rows: Math.max(1, Math.ceil(height / size - 1e-9)) };
}

/** The cells near a shape, with their centres: fast on a large board. */
function* cellsNear({ x0, y0, cell, cols, rows }: Grid, shape: Shape, keep: number): Generator<[row: number, col: number, centre: Xy]> {
  const [left, top, right, bottom] = shapeBox(shape);
  const lastRow = Math.min(rows, floorDiv(bottom + keep - y0, cell) + 1);
  const lastCol = Math.min(cols, floorDiv(right + keep - x0, cell) + 1);
  for (let r = Math.max(0, floorDiv(top - keep - y0, cell)); r < lastRow; r++) {
    for (let c = Math.max(0, floorDiv(left - keep - x0, cell)); c < lastCol; c++) yield [r, c, [x0 + (c + 0.5) * cell, y0 + (r + 0.5) * cell]];
  }
}

export interface CorridorInput {
  /** Board polygons, null for no edge. */
  outline: Xy[][] | null; edgeGap: number; own: Shape[]; others: { shape: Shape; keep: number }[]; marks: [letter: string, at: Xy][];
}

/** ASCII rows: '.' free for a track centre, '#' blocked by other copper or the board edge, '+' own copper, letters are marks. */
export function corridorMap(grid: Grid, { outline, edgeGap, own, others, marks }: CorridorInput): string[] {
  const { x0, y0, cell, cols, rows } = grid;
  const cells = Array.from({ length: rows }, () => Array.from({ length: cols }, () => '.'));
  if (outline) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const q: Xy = [x0 + (c + 0.5) * cell, y0 + (r + 0.5) * cell];
        if (!outline.some(points => inPoly(q, points) && -shapeDist({ kind: 'poly', points }, q) >= edgeGap)) cells[r]![c] = '#';
      }
    }
  }
  for (const { shape, keep } of others) {
    for (const [r, c, q] of cellsNear(grid, shape, keep)) if (shapeDist(shape, q) < keep) cells[r]![c] = '#';
  }
  for (const shape of own) {
    for (const [r, c, q] of cellsNear(grid, shape, 0)) if (shapeDist(shape, q) <= 0) cells[r]![c] = '+';
  }
  for (const [letter, [x, y]] of marks) {
    const [c, r] = [floorDiv(x - x0, cell), floorDiv(y - y0, cell)];
    if (r >= 0 && r < rows && c >= 0 && c < cols) cells[r]![c] = letter;
  }
  return cells.map(row => row.join(''));
}

/** Blocks the nodes closer than `keep` to a shape: free 0, label `label`. */
export function markNear({ x0, y0, cell, cols, rows }: Grid, shape: Shape, keep: number, free: Uint8Array, labels: Int32Array, label: number): void {
  const [left, top, right, bottom] = shapeBox(shape);
  const lastRow = Math.min(rows, Math.floor((bottom + keep - y0) / cell) + 1);
  const lastCol = Math.min(cols, Math.floor((right + keep - x0) / cell) + 1);
  for (let r = Math.max(0, Math.ceil((top - keep - y0) / cell)); r < lastRow; r++) {
    for (let c = Math.max(0, Math.ceil((left - keep - x0) / cell)); c < lastCol; c++) {
      const i = r * cols + c;
      if (free[i] && shapeDist(shape, [x0 + c * cell, y0 + r * cell]) < keep) { free[i] = 0; labels[i] = label; }
    }
  }
}

/** Nodes inside the rings by scanline, even-odd, so a hole ring cuts out. */
export function polyNodes({ x0, y0, cell, cols, rows }: Grid, rings: Xy[][]): number[] {
  const edges = rings.flatMap(ring => ring.map((a, i): [Xy, Xy] => [a, ring[(i + 1) % ring.length]!])).filter(([a, b]) => a[1] !== b[1]);
  const out: number[] = [];
  for (let r = 0; r < rows; r++) {
    const y = y0 + r * cell;
    const xs = edges.filter(([[, ay], [, by]]) => (ay > y) !== (by > y)).map(([[ax, ay], [bx, by]]) => ax + (y - ay) * (bx - ax) / (by - ay)).sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const last = Math.min(cols, Math.floor((xs[k + 1]! - x0) / cell) + 1);
      for (let c = Math.max(0, Math.ceil((xs[k]! - x0) / cell)); c < last; c++) out.push(r * cols + c);
    }
  }
  return out;
}
