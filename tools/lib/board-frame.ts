// Fast 2D board frame from the DSN/SES text (W12): no pcbnew, no kicad-cli, no image library.
//
// A frame shows the board outline and pads from the DSN, tracks by layer colour and vias from the SES, the open
// connections as red lines, and the stamp text top left. Layer colours: F.Cu red, B.Cu blue, In1.Cu olive, In2.Cu teal
// (the KiCad defaults, roughly); pads grey, vias light grey, open connections red (#ff3030), outline white.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fixed } from './py-compat.mjs';
import { readJson } from './json-file.ts';
import { Canvas, encodePng, type Rgb, type Xy } from './raster.ts';
import { loadDsn, loadSes, type Dsn, type Ses } from './specctra.ts';

export const COLOURS: Readonly<Record<string, Rgb>> = {
  'F.Cu': [200, 52, 52], 'B.Cu': [77, 127, 196], 'In1.Cu': [194, 194, 0], 'In2.Cu': [0, 170, 170],
};
export const OPEN: Rgb = [255, 48, 48];
const PAD_FRONT: Rgb = [150, 150, 150];
const PAD_BACK: Rgb = [100, 100, 130];
const VIA: Rgb = [220, 220, 220];
const OUTLINE: Rgb = [255, 255, 255];
const STAMP: Rgb = [255, 255, 255];
const OTHER_LAYER: Rgb = [160, 160, 160];
const LAYER_ORDER = ['In2.Cu', 'In1.Cu', 'B.Cu', 'F.Cu'];
const MARGIN_MM = 3;
const HEADER_PX = 44;
const FOOTER_PX = 4;
const VIA_RADIUS_MM = 0.35;
const MIN_VIA_RADIUS_PX = 1.5;
const OPEN_LINE_PX = 3;
const STAMP_AT: Xy = [10, 8];
const MIN_FPS = 1;
const MAX_FFMPEG_ERROR = 300;

export const DEFAULT_WIDTH = 1200;

export type OpenLine = readonly [x0: number, y0: number, x1: number, y1: number];
export interface FrameOptions { ses?: string; dsn?: string; out?: string; stamp?: string; width?: number }

interface Report { unrouted?: { from_xy?: number[]; to_xy?: number[] }[] | null }
interface Triage { connections?: { a_pos?: { x: number; y: number }; b_pos?: { x: number; y: number } }[] | null }

/** Python's os.path.join for a relative name: the result is printed, so the spelling of `dir` stays. */
const under = (dir: string, name: string): string => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`);
const lastPart = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const isFile = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;

function reportLines(outdir: string): OpenLine[] {
  const { unrouted } = readJson<Report>(under(outdir, 'report.json'));
  return (unrouted ?? []).flatMap(({ from_xy: from, to_xy: to }) =>
    (from?.length && to?.length ? [[...from, ...to] as unknown as OpenLine] : []));
}

function triageLines(outdir: string): OpenLine[] {
  const { connections } = readJson<Triage>(under(outdir, 'open-triage.json'));
  return (connections ?? []).flatMap(({ a_pos: a, b_pos: b }) => (a && b ? [[a.x, a.y, b.x, b.y] as const] : []));
}

const orNull = (read: () => OpenLine[]): OpenLine[] | null => {
  try {
    return read();
  } catch {
    return null;
  }
};

/** The open connections in mm: report.json unrouted[] when the router has written it, else open-triage.json. */
export const openLines = (outdir: string): OpenLine[] =>
  orNull(() => reportLines(outdir)) ?? orNull(() => triageLines(outdir)) ?? [];

export function render(dsn: Dsn, ses: Ses, opens: readonly OpenLine[], stamp: string, width: number): Canvas {
  const [x0, y0, x1, y1] = dsn.bbox;
  const boardWidth = x1 - x0 + 2 * MARGIN_MM;
  const boardHeight = y1 - y0 + 2 * MARGIN_MM;
  const scale = (width - 2) / boardWidth;
  const canvas = new Canvas(width, Math.trunc(boardHeight * scale) + HEADER_PX + FOOTER_PX);
  const place = (x: number, y: number): Xy => [(x - x0 + MARGIN_MM) * scale + 1, (y - y0 + MARGIN_MM) * scale + HEADER_PX];

  if (dsn.outline.length > 0) canvas.polygonOutline(dsn.outline.map(([x, y]) => place(x, y)), OUTLINE);
  for (const { x, y, w, h, side } of dsn.pads) {
    const [ax, ay] = place(x - w / 2, y - h / 2);
    const [bx, by] = place(x + w / 2, y + h / 2);
    canvas.rectangle([ax, ay], [Math.max(bx, ax + 1), Math.max(by, ay + 1)], side === 'front' ? PAD_FRONT : PAD_BACK);
  }
  const others = [...new Set(ses.wires.map(wire => wire.layer))].filter(layer => !LAYER_ORDER.includes(layer)).sort();
  for (const layer of [...LAYER_ORDER, ...others]) {
    for (const wire of ses.wires) {
      if (wire.layer !== layer || wire.points.length < 2) continue;
      const pixels = Math.max(1, Math.trunc(wire.width * scale));
      canvas.line(wire.points.map(([x, y]) => place(x, y)), COLOURS[layer] ?? OTHER_LAYER, pixels);
    }
  }
  const radius = Math.max(MIN_VIA_RADIUS_PX, VIA_RADIUS_MM * scale);
  for (const [x, y] of ses.vias) {
    const [cx, cy] = place(x, y);
    canvas.ellipse([cx - radius, cy - radius], [cx + radius, cy + radius], VIA);
  }
  for (const [ax, ay, bx, by] of opens) canvas.line([place(ax, ay), place(bx, by)], OPEN, OPEN_LINE_PX);
  canvas.text(STAMP_AT[0], STAMP_AT[1], stamp, STAMP);
  return canvas;
}

/** Renders one frame and returns the PNG path. */
export function frame(outdir: string, options: FrameOptions = {}): string {
  const dsn = loadDsn(options.dsn || under(outdir, 'board.dsn'));
  const sesPath = options.ses || under(outdir, 'board.ses');
  const ses = isFile(sesPath) ? loadSes(sesPath) : { wires: [], vias: [] };
  const opens = openLines(outdir);
  const stamp = options.stamp
    ?? `${lastPart(outdir)}  open ${opens.length}  tracks ${ses.wires.length}  vias ${ses.vias.length}`;
  const out = options.out || under(outdir, 'frame.png');
  mkdirSync(dirname(resolve(out)), { recursive: true });
  const temporary = `${out}.tmp.png`;
  writeFileSync(temporary, encodePng(render(dsn, ses, opens, stamp, options.width ?? DEFAULT_WIDTH)));
  renameSync(temporary, out);
  return out;
}

function snapshotFrames(snapshots: string): string[] {
  if (!existsSync(snapshots)) return [];
  return readdirSync(snapshots).filter(name => /^[0-9].*\.png$/.test(name)).sort().map(name => under(snapshots, name));
}

function frameList(frames: string[], fps: number): string {
  const lines = frames.map(path => `file '${resolve(path)}'\nduration ${fixed(1 / fps, 4)}\n`);
  return `${lines.join('')}file '${resolve(frames.at(-1)!)}'\n`;
}

/**
 * OUTDIR/snapshots/NNNN.png into OUTDIR/timelapse.mp4, the whole run in `seconds` (at least 1 fps). The PNG frames are
 * deleted after a good MP4 unless `keep`. Returns the MP4 path, or null: without ffmpeg the frames stay.
 */
export function mp4(outdir: string, seconds = 60, keep = false): string | null {
  if (seconds === 0) throw new RangeError('seconds must not be 0');
  const snapshots = under(outdir, 'snapshots');
  const frames = snapshotFrames(snapshots);
  if (frames.length === 0) {
    console.log('board_frame: no frames under snapshots/');
    return null;
  }
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).error) {
    console.log(`board_frame: ffmpeg not found; ${frames.length} frames kept under ${outdir}/snapshots`);
    return null;
  }
  const fps = Math.max(MIN_FPS, frames.length / seconds);
  const out = under(outdir, 'timelapse.mp4');
  const list = under(snapshots, 'frames.txt');
  writeFileSync(list, frameList(frames, fps));
  const run = spawnSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
    '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out,
  ], { encoding: 'utf8' });
  if (run.status !== 0 || !isFile(out)) {
    console.log(`board_frame: ffmpeg failed (rc ${run.status}): ${run.stderr.trim().slice(-MAX_FFMPEG_ERROR)}`);
    return null;
  }
  console.log(`board_frame: ${out} (${frames.length} frames, ${fixed(fps, 2)} fps, ${seconds} s)`);
  if (!keep) for (const path of [...frames, list]) rmSync(path);
  return out;
}
