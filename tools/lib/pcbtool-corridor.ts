// pcbtool corridor: the unconnected pad pairs of one net and a small free/blocked ASCII map per outer layer around them.
import { copperEdgeClearance, copperObstacles, mmPoint, netRules, ownCopper, type ProjectFile } from './board-obstacles.ts';
import type { Board, Pad } from './board-types.ts';
import { polyShape, shapeBox, type Box, type Shape } from './copper-gap.ts';
import { netPadPairs, type NetPad } from './net-islands.ts';
import { CommandFailure, type Print } from './pcbtool-cli.ts';
import { fixed } from './py-compat.mjs';
import { formatG } from './py-numbers.ts';
import { corridorMap, fitGrid } from './route-grid.ts';
import type { Xy } from './route-spec.ts';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** Pairs listed and mapped when no --pair is given. */
const MAX_PAIRS = 12;
/** Items farther than this from the map do not reach it: keep is under 5 mm. */
const FAR_MM = 5;

/** The names of the .kicad_dru rules whose text quotes one of `names`, a net or a class. */
export function druMentions(text: string, names: string[]): string[] {
  return text.split('(rule "').slice(1).filter(block => names.some(name => block.includes(`'${name}'`))).map(block => block.split('"', 1)[0]!);
}

const sideOf = (pad: Pad): 'THT' | 'F' | 'B' => (pad.kind === 'ThroughHole' ? 'THT' : pad.layers.includes('F.Cu') ? 'F' : 'B');
const padOnLayer = (pad: Pad, layer: string): boolean => sideOf(pad) === 'THT' || (sideOf(pad) === 'F') === (layer === 'F.Cu');
const padLine = (letter: string, { name, at, pad }: NetPad): string => `${letter} ${name} (${fixed(at[0], 3)}, ${fixed(at[1], 3)}) ${sideOf(pad)}`;

const ordered = (box: number[]): Box => [Math.min(box[0]!, box[2]!), Math.min(box[1]!, box[3]!), Math.max(box[0]!, box[2]!), Math.max(box[1]!, box[3]!)];

export interface CorridorOptions { net: string; margin: number; cell: number; pair: number | null; box: number[] | null }

/** `dru`: the text of the .kicad_dru next to the board, if there is one. */
export function corridor(board: Board, project: ProjectFile, dru: string | null, { net, margin, cell: asked, pair, box }: CorridorOptions, print: Print): number {
  if (!(net in board.nets)) throw new CommandFailure(`no net ${net} on the board`);
  const { className, trackWidth: width, clearance } = netRules(project, net);
  const mentions = dru === null ? '' : `; dru rules on it: ${druMentions(dru, [net, className]).join(', ') || 'none'} (map uses class clearances only, check .kicad_dru)`;
  print(`net ${net}: class ${className}, width ${formatG(width)}, clearance ${formatG(clearance)}${mentions}`);
  const pairs = netPadPairs(board, net);
  if (!pairs.length) {
    print('unconnected: none');
    return 0;
  }
  const letters = new Map<string, string>();
  for (const { key } of pairs.flat()) if (!letters.has(key)) letters.set(key, LETTERS[letters.size] ?? '?');
  print(`unconnected: ${pairs.length} pairs`);
  for (const [a, b] of pairs.slice(0, MAX_PAIRS)) print(`  ${padLine(letters.get(a.key)!, a)}  -  ${padLine(letters.get(b.key)!, b)}`);
  if (pairs.length > MAX_PAIRS) print(`  ... ${pairs.length - MAX_PAIRS} more pairs (not in the map)`);
  if (pair && !(pair >= 1 && pair <= pairs.length)) throw new CommandFailure(`--pair ${pair}: the net has ${pairs.length} pairs`);
  const shown = (pair ? [pairs[pair - 1]!] : pairs.slice(0, MAX_PAIRS)).flat();
  const [xs, ys] = [shown.map(pad => pad.at[0]), shown.map(pad => pad.at[1])];
  const window: Box = box ? ordered(box) : [Math.min(...xs) - margin, Math.min(...ys) - margin, Math.max(...xs) + margin, Math.max(...ys) + margin];
  const grid = fitGrid(window, asked);
  const { x0, y0, cell, cols, rows } = grid;
  if (box && cell > asked) print(`box larger than 80x40 cells: cell grown from ${formatG(asked)} to ${formatG(cell)}`);
  const outline: Xy[][] = board.outlines.map(polygon => polygon.outline.map(mmPoint));
  const edgeGap = copperEdgeClearance(project) + width / 2;
  const holes = board.outlines.flatMap(polygon => polygon.holes).map(hole => ({ shape: polyShape(hole.map(mmPoint)), keep: edgeGap }));
  print(`grid x0=${fixed(x0, 3)} y0=${fixed(y0, 3)} cell=${formatG(cell)} cols=${cols} rows=${rows}: cell (c, r) centre = (x0 + (c + 0.5) * cell, y0 + (r + 0.5) * cell). `
    + `Legend: . free for a ${formatG(width)} mm track centre, # blocked (other copper + clearance, edge, keepout), + own copper, letters = pads above. `
    + 'Pours of other nets are not shown.');
  const ruler = `   ${Array.from({ length: cols }, (_, c) => (c % 10 === 0 ? String(Math.floor(c / 10) % 10) : ' ')).join('')}`;
  const seen: Box = [x0 - FAR_MM, y0 - FAR_MM, x0 + cols * cell + FAR_MM, y0 + rows * cell + FAR_MM];
  const near = (shape: Shape): boolean => {
    const [left, top, right, bottom] = shapeBox(shape);
    return left < seen[2] && right > seen[0] && top < seen[3] && bottom > seen[1];
  };
  const cache = new Map<string, number>();
  const shownKeys = new Set(shown.map(pad => pad.key));
  const byKey = new Map(pairs.flat().map(pad => [pad.key, pad]));
  for (const layer of ['F.Cu', 'B.Cu']) {
    const others = [...holes, ...copperObstacles(board, project, net, clearance, layer, cache).map(item => ({ shape: item.shape, keep: item.clearance + width / 2 }))];
    const marks = [...letters].flatMap(([key, letter]): [string, Xy][] => {
      const pad = byKey.get(key)!;
      return shownKeys.has(key) && padOnLayer(pad.pad, layer) ? [[letter, pad.at]] : [];
    });
    const lines = corridorMap(grid, { outline, edgeGap, own: ownCopper(board, net, layer).filter(near), others: others.filter(item => near(item.shape)), marks });
    print(`map ${layer}`);
    print(ruler);
    lines.forEach((line, r) => print(`${String(r).padStart(2)} ${line}`));
  }
  return 0;
}
