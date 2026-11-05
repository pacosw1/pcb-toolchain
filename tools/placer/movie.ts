// Timelapse of a compaction run (run.json from compact_cli.py): PNG frames (lib/raster.ts), then GIF + MP4 (ffmpeg).
//   node --experimental-strip-types --no-warnings tools/placer/movie.ts RUN.json OUTDIR [--seconds 15] [--routed RUNDIR]
// The frames are the viewer frames (viewer.ts playback): one per anneal epoch and one per step result. Left: layout (block colours,
// halos dashed, ratsnest by length, region box, outline). Right: RUDY heat (same scale on all frames, over-capacity cells red). Below:
// cost parts over the frames with a marker, and s + unrouted per step. --routed RUNDIR: also one PNG per step of the best routed board
// (kicad-cli pcb render, top view). Output goes to OUTDIR only (scratch); do not commit it. Parts are opaque tints: a raster has no alpha.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFlags, runMain, UsageError } from '../lib/cli.ts';
import { kicadCli } from '../lib/env.mjs';
import { fixed } from '../lib/py-compat.mjs';
import { round } from '../lib/py-numbers.ts';
import { Canvas, encodePng, type Rgb, type Xy } from '../lib/raster.ts';
import { playback, rotatedRect, type Playback } from './viewer.ts';

// The RUDY view: cost.py DEFAULTS with viewer.py VIEW_PARAMS (pin_demand 0.5).
const RUDY = { cell: 1, layers: 2, pitch: 0.4, limit: 0.1, gap: 0.2, pinDemand: 0.5, eps: 1e-9, routeLayers: ['F.Cu', 'B.Cu'] };
const CAPACITY = RUDY.limit * RUDY.cell ** 2 * RUDY.layers / RUDY.pitch;

const WIDTH = 1800, HEIGHT = 1080;            // 12 x 7.2 in as the plots were, at the size the 18 px font needs
const CHAR_W = 18, LINE_H = 24, MARGIN = 10;  // lib/raster.ts text: 6 px advance and 7 px height at 3 times
const PANEL_TOP = 40, PANEL_HEIGHT = 640, CHART_TOP = 700;
const DASH = 6;
const WHITE: Rgb = [255, 255, 255], BLACK: Rgb = [0, 0, 0], GREY: Rgb = [136, 136, 136], HALO: Rgb = [153, 153, 153], REGION: Rgb = [204, 0, 204];
const SERIES: [string, Rgb][] = [['hpwl', [51, 102, 204]], ['cong', [204, 102, 51]], ['overlap', [51, 153, 51]], ['oob', [153, 51, 153]]];
// Three stops each of the matplotlib maps the plots used.
const BLUES: Rgb[] = [[247, 251, 255], [107, 174, 214], [8, 48, 107]];
const REDS: Rgb[] = [[255, 245, 240], [251, 106, 74], [103, 0, 13]];
const GREEN_RED: Rgb[] = [[26, 152, 80], [255, 255, 191], [215, 48, 39]];

type Pose = number[][];
interface Problem {
  units: { pads?: number[][] }[];
  nets: { pins: number[][]; cohesion?: boolean }[];
  board: { outline: number[][]; copper?: [string, number, number, number, number, number][] };
}
interface Run { problem: Problem; steps: { pose: Pose | null; history: { pose: Pose }[] }[] }
export interface Grid { x0: number; y0: number; nx: number; ny: number }
type Frame = Playback['frames'][number];
type Mapper = (p: Xy) => Xy;

export function gridOf(board: Problem['board']): Grid {
  const xs = board.outline.map(p => p[0]!), ys = board.outline.map(p => p[1]!);
  const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
  const cells = (span: number): number => Math.max(1, Math.ceil(span / RUDY.cell - RUDY.eps));
  return { x0, y0, nx: cells(Math.max(...xs) - x0), ny: cells(Math.max(...ys) - y0) };
}

/** The clipped cells [i0, i1) that a span touches; at least one before the clip. */
function cellRange(a0: number, a1: number, g0: number, n: number): [number, number] {
  const i0 = Math.floor((a0 - g0) / RUDY.cell + RUDY.eps);
  const i1 = Math.max(Math.ceil((a1 - g0) / RUDY.cell - RUDY.eps), i0 + 1);
  return [Math.max(i0, 0), Math.min(i1, n)];
}

function addAt(g: Float64Array, grid: Grid, x: number, y: number, value: number): void {
  const [i, j] = [Math.floor((x - grid.x0) / RUDY.cell), Math.floor((y - grid.y0) / RUDY.cell)];
  if (i >= 0 && i < grid.nx && j >= 0 && j < grid.ny) g[j * grid.nx + i]! += value;
}

/** RUDY demand of the kept copper, mm of wire per cell: a track uses length * (width + gap) / pitch, a via (diameter + gap)^2 / pitch per layer. */
export function copperDemand(board: Problem['board'], grid: Grid): Float64Array {
  const g = new Float64Array(grid.nx * grid.ny);
  for (const [layer, a0, b0, a1, b1, w] of board.copper ?? []) {
    if (layer === 'via') addAt(g, grid, a0, b0, (w + RUDY.gap) ** 2 / RUDY.pitch * RUDY.layers);
    else if (RUDY.routeLayers.includes(layer)) {
      const length = Math.hypot(a1 - a0, b1 - b0), n = Math.max(1, Math.ceil(length / (RUDY.cell / 4)));
      for (let k = 0; k < n; k++) {
        const f = (k + 0.5) / n;
        addAt(g, grid, a0 + f * (a1 - a0), b0 + f * (b1 - b0), length / n * (w + RUDY.gap) / RUDY.pitch);
      }
    }
  }
  return g;
}

/** The RUDY demand of a pose: each net spread over the cells of its box, plus the demand of each pad and the kept copper. */
export function rudy(pr: Problem, pose: Pose, grid: Grid, kept: Float64Array): Float64Array {
  const g = Float64Array.from(kept);
  for (const net of pr.nets) {
    const boxes = net.pins.map(pin => {
      const [x, y, turn] = pose[pin[0]!] as [number, number, number], [a, b, c, d] = rotatedRect(pin.slice(1, 5), turn);
      return [a + x, b + y, c + x, d + y] as [number, number, number, number];
    });
    const [left, top, right, bottom] = [Math.min(...boxes.map(r => r[0])), Math.min(...boxes.map(r => r[1])), Math.max(...boxes.map(r => r[2])), Math.max(...boxes.map(r => r[3]))];
    const [i0, i1] = cellRange(left, right, grid.x0, grid.nx), [j0, j1] = cellRange(top, bottom, grid.y0, grid.ny);
    const length = right - left + (bottom - top);
    if (i1 <= i0 || j1 <= j0 || length <= 0 || net.cohesion) continue;
    const share = length / ((j1 - j0) * (i1 - i0));
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) g[j * grid.nx + i]! += share;
  }
  pr.units.forEach((unit, u) => {
    const [x, y, turn] = pose[u] as [number, number, number];
    for (const pad of unit.pads ?? []) {
      const [a, b] = rotatedRect([pad[0]!, pad[1]!, pad[0]!, pad[1]!], turn);
      addAt(g, grid, a + x, b + y, RUDY.pinDemand);
    }
  });
  return g;
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map(k => Math.round(a[k]! + (b[k]! - a[k]!) * t)) as unknown as Rgb;
const ramp = (stops: Rgb[], t: number): Rgb => (t < 0.5 ? mix(stops[0]!, stops[1]!, t * 2) : mix(stops[1]!, stops[2]!, t * 2 - 1));

/** A block's colour: its hue from its name, lightness 0.5, saturation 0.6. */
export function blockColour(name: string): Rgb {
  let hue = 0;
  for (const c of name) hue = (hue * 31 + c.codePointAt(0)!) % 360;
  const part = (n: number): number => { const k = (n + hue / 30) % 12; return Math.round((0.5 - 0.3 * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255); };
  return [part(0), part(8), part(4)];
}

function dashed(c: Canvas, ring: Xy[], colour: Rgb): void {
  ring.forEach((a, k) => {
    const b = ring[(k + 1) % ring.length]!, length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let s = 0; s < length; s += 2 * DASH) {
      const at = (d: number): Xy => [a[0] + (b[0] - a[0]) * d / length, a[1] + (b[1] - a[1]) * d / length];
      c.line([at(s), at(Math.min(s + DASH, length))], colour);
    }
  });
}

const corners = (x0: number, y0: number, x1: number, y1: number): Xy[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/** World to pixels in a panel: equal scale, centred, y down. */
function panelMap(left: number, limits: [number, number, number, number]): Mapper {
  const [x0, x1, y0, y1] = limits, width = (WIDTH - 3 * MARGIN) / 2;
  const scale = Math.min(width / (x1 - x0), PANEL_HEIGHT / (y1 - y0));
  const [dx, dy] = [left + (width - (x1 - x0) * scale) / 2, PANEL_TOP + (PANEL_HEIGHT - (y1 - y0) * scale) / 2];
  return ([x, y]) => [dx + (x - x0) * scale, dy + (y - y0) * scale];
}

function outlineAndRegion(c: Canvas, map: Mapper, f: Frame, region: Playback['region']): void {
  c.polygonOutline(f.outline.map(p => map(p)), GREY);
  if (region) dashed(c, corners(...region).map(map), REGION);
}

function drawLayout(c: Canvas, map: Mapper, f: Frame, d: Playback): void {
  f.rects.forEach((rects, u) => {
    const unit = d.units[u]!, colour = unit.block ? blockColour(unit.block) : unit.fixed ? GREY : [85, 170, 136] as Rgb;
    for (const r of rects) c.rectangle(map([r[0], r[1]]), map([r[2], r[3]]), mix(WHITE, colour, 0.55));
    if (!unit.fixed && unit.halo > 0 && rects.length) {
      const q = unit.halo / 2;
      dashed(c, corners(Math.min(...rects.map(r => r[0])) - q, Math.min(...rects.map(r => r[1])) - q, Math.max(...rects.map(r => r[2])) + q, Math.max(...rects.map(r => r[3])) + q).map(map), HALO);
    }
  });
  const length = (s: number[]): number => Math.hypot(s[2]! - s[0]!, s[3]! - s[1]!);
  const longest = Math.max(1e-9, ...f.segments.map(length));
  for (const s of f.segments) c.line([map([s[0], s[1]]), map([s[2], s[3]])], mix(WHITE, ramp(GREEN_RED, length(s) / longest), 0.6));
  outlineAndRegion(c, map, f, d.region);
}

function drawHeat(c: Canvas, map: Mapper, f: Frame, d: Playback, grid: Grid, cells: Float64Array, top: number): void {
  for (let j = 0; j < grid.ny; j++) {
    for (let i = 0; i < grid.nx; i++) {
      const v = cells[j * grid.nx + i]!, level = Math.trunc(Math.min(Math.max(v / top * 254, 0), 254)) / 254;
      const [x, y] = [grid.x0 + i * RUDY.cell, grid.y0 + j * RUDY.cell];
      c.rectangle(map([x, y]), map([x + RUDY.cell, y + RUDY.cell]), ramp(v > CAPACITY ? REDS : BLUES, level));
    }
  }
  outlineAndRegion(c, map, f, d.region);
}

function drawChart(c: Canvas, frames: Frame[], at: number, bottom: number): void {
  const x = (k: number): number => MARGIN + k * (WIDTH - 2 * MARGIN) / Math.max(frames.length - 1, 1);
  SERIES.forEach(([key, colour], n) => {
    const values = frames.map(f => f.components[key] ?? 0), top = Math.max(...values, 1e-9);
    const y = (v: number): number => bottom - (bottom - CHART_TOP) * v / top;
    c.line(values.map((v, k) => [x(k), y(v)] as Xy), colour);
    c.text(WIDTH - MARGIN - 8 * CHAR_W, CHART_TOP + n * LINE_H, key, colour);
  });
  c.line([[x(at), CHART_TOP], [x(at), bottom]], BLACK);
}

/** Lines of at most `chars`, broken at the spaces. */
function wrapped(text: string, chars: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > chars) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  return line ? [...lines, line] : lines;
}

const title = (f: Frame): string => `${f.label}   s=${fixed(f.s, 2)}   cost=${fixed(f.cost, 0)}${f.unrouted === null ? '' : `   unrouted=${f.unrouted}`}`;

/** One PNG per viewer frame, in order. */
export function renderFrames(run: Run, d: Playback, outdir: string): string[] {
  const poses = run.steps.flatMap(s => [...s.history.map(h => h.pose), ...(s.pose === null ? [] : [s.pose])]);
  if (poses.length !== d.frames.length) throw new Error(`${poses.length} poses for ${d.frames.length} frames`);
  const grid = gridOf(run.problem.board), kept = copperDemand(run.problem.board, grid);
  const heat = poses.map(pose => rudy(run.problem, pose, grid, kept));
  const top = Math.max(1e-9, ...heat.map(g => g.reduce((a, b) => Math.max(a, b), 0)));
  const all = d.frames.flatMap(f => f.outline);
  const limits: [number, number, number, number] = [Math.min(...all.map(p => p[0])) - 1, Math.max(...all.map(p => p[0])) + 1, Math.min(...all.map(p => p[1])) - 1, Math.max(...all.map(p => p[1])) + 1];
  const steps = d.steps.map((t, k) => `step ${k}: s=${fixed(t.s, 2)} unrouted=${t.unrouted ?? 'None'} ${t.passed ? 'PASS' : 'FAIL'}`).join('   ');
  const chars = Math.trunc((WIDTH - 2 * MARGIN) / CHAR_W), footer = [...wrapped(steps, chars), ...wrapped(d.verdict, chars)];
  const [left, right] = [panelMap(MARGIN, limits), panelMap((WIDTH + MARGIN) / 2, limits)];
  mkdirSync(outdir, { recursive: true });
  return d.frames.map((f, i) => {
    const c = new Canvas(WIDTH, HEIGHT);
    c.pixels.fill(255);
    drawLayout(c, left, f, d);
    drawHeat(c, right, f, d, grid, heat[i]!, top);
    c.text(MARGIN, MARGIN, title(f), BLACK);
    c.text((WIDTH + MARGIN) / 2, MARGIN, 'RUDY congestion (red: over capacity)', BLACK);
    drawChart(c, d.frames, i, HEIGHT - MARGIN - LINE_H * footer.length);
    footer.forEach((line, k) => c.text(MARGIN, HEIGHT - LINE_H * (footer.length - k), line, BLACK));
    const path = join(outdir, `f${String(i).padStart(4, '0')}.png`);
    writeFileSync(path, encodePng(c));
    return path;
  });
}

export const fps = (n: number, seconds: number): number => Math.trunc(Math.min(30, Math.max(1, round(n / seconds))));

const FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).error ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';

function run(program: string, args: string[]): void {
  const done = spawnSync(program, args, { encoding: 'utf8' });
  if (done.error || done.status !== 0) throw new Error(`${program} failed (exit ${done.status}): ${done.error?.message ?? done.stderr.trim()}`);
}

function encode(outdir: string, n: number, seconds: number): void {
  const input = ['-y', '-loglevel', 'error', '-framerate', String(fps(n, seconds)), '-i', join(outdir, 'f%04d.png'), '-vf'];
  run(FFMPEG, [...input, 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-pix_fmt', 'yuv420p', join(outdir, 'run.mp4')]);
  run(FFMPEG, [...input, 'scale=720:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse', join(outdir, 'run.gif')]);
}

/** The board of the router run with the fewest unrouted in a step folder (route-K/*-r.kicad_pcb, its count in route-K.log). */
export function bestRouted(step: string): { unrouted: number; pcb: string } | null {
  let best: { unrouted: number; pcb: string } | null = null;
  for (const name of readdirSync(step).sort()) {
    const log = join(step, `${name}.log`);
    if (!/^route-\d+$/.test(name) || !existsSync(log)) continue;
    const counts = [...readFileSync(log, 'utf8').matchAll(/^UNROUTED (\d+)/gm)], pcb = readdirSync(join(step, name)).sort().find(file => file.endsWith('-r.kicad_pcb'));
    const unrouted = Number(counts.at(-1)?.[1]);
    if (counts.length && pcb && (!best || unrouted < best.unrouted)) best = { unrouted, pcb: join(step, name, pcb) };
  }
  return best;
}

function routed(rundir: string, outdir: string): string[] {
  const out: string[] = [];
  for (const folder of readdirSync(rundir).sort()) {
    const step = /^step-(\d+)$/.exec(folder), best = step ? bestRouted(join(rundir, folder)) : null;
    if (!step || !best) continue;
    const path = join(outdir, `routed-step${step[1]}-u${best.unrouted}.png`);
    run(kicadCli, ['pcb', 'render', '--side', 'top', '--quality', 'basic', '-w', '1600', '-h', '1000', '-o', path, best.pcb]);
    out.push(path);
  }
  return out;
}

const USAGE = 'usage: movie.ts RUN.json OUTDIR [--seconds 15] [--routed RUNDIR]';

export function main(argv: string[]): number {
  const { values, positionals } = parseFlags(argv, { seconds: { type: 'string' }, routed: { type: 'string' } }, USAGE);
  const [input, outdir] = positionals;
  const seconds = Number(values.seconds ?? 15);
  if (!input || !outdir || positionals.length !== 2 || !(seconds > 0)) throw new UsageError(USAGE);
  const source = readFileSync(input), parsed: unknown = JSON.parse(source.toString('utf8'));
  const paths = renderFrames(parsed as Run, playback(parsed, createHash('sha256').update(source).digest('hex')), outdir);
  encode(outdir, paths.length, seconds);
  console.log(`frames ${paths.length}, ${join(outdir, 'run.gif')}, ${join(outdir, 'run.mp4')}`);
  for (const path of values.routed ? routed(values.routed, outdir) : []) console.log('routed', path);
  return 0;
}

runMain(import.meta.url, main);
