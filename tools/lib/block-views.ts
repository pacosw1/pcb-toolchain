// Renders and DRC by kicad-cli, into a temp cache keyed by the source files, so a result is never stale.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { cacheKey, findItem, readLoose, type Layout } from './block-sources.ts';
import { compare, globNames } from './py-compat.mjs';

export const CACHE = join(tmpdir(), 'iot-lab-blocks');
const RENDER_TIMEOUT_MS = 600_000, DRC_TIMEOUT_MS = 900_000;
const SIZE = ['--quality', 'high', '-w', '1800', '-h', '1200'];
const SVG = ['pcb', 'export', 'svg', '--mode-single', '--page-size-mode', '2', '--exclude-drawing-sheet'];

type Command = (source: string, out: string) => string[];

/** Overlay layers: User.1 = block borders and labels, User.2 = component borders and labels. */
const OVERLAYS: Record<string, [string, string]> = { blocks: ['User.1', '#00B8D4'], components: ['User.2', '#D500F9'] };
const overlay = (layer: string): Command => (source, out) => [...SVG, '--drill-shape-opt', '0', '-l', layer, '-o', out, source];

export const VIEWS: Record<string, [string, Command]> = {
  sch: ['svg', (source, out) => ['sch', 'export', 'svg', '-e', '-o', dirname(out), source]],
  top: ['png', (source, out) => ['pcb', 'render', '--side', 'top', ...SIZE, '-o', out, source]],
  bottom: ['png', (source, out) => ['pcb', 'render', '--side', 'bottom', ...SIZE, '-o', out, source]],
  iso: ['png', (source, out) => ['pcb', 'render', '--rotate', '-45,0,45', '--perspective', ...SIZE, '-o', out, source]],
  front: ['svg', (source, out) => [...SVG, '-l', 'F.Cu,F.Mask,F.SilkS,Edge.Cuts', '-o', out, source]],
  back: ['svg', (source, out) => [...SVG, '-m', '-l', 'B.Cu,B.Mask,B.SilkS,Edge.Cuts', '-o', out, source]],
  blocks: ['svg', overlay('User.1')],
  components: ['svg', overlay('User.2')],
  glb: ['glb', (source, out) => ['pcb', 'export', 'glb', '-f', '--subst-models', '--include-tracks', '--include-pads', '--include-zones', '--include-silkscreen', '--include-soldermask', '-o', out, source]],
};

/** Paint every fill and stroke color of a one-layer SVG with one color; 'none' stays. */
export const recolorSvg = (text: string, color: string): string => text
  .replace(/((?:fill|stroke):\s*)#[0-9A-Fa-f]{6}/g, `$1${color}`)
  .replace(/((?:fill|stroke)=")#[0-9A-Fa-f]{6}(")/g, `$1${color}$2`);

/** Cache variant: the view name plus its export command, so a changed command gives a new render. */
export const viewVariant = (view: string): string => `${view} kicad-cli ${(VIEWS[view] as [string, Command])[1]('SRC', 'OUT').join(' ')}`;

const kicad = (args: string[], timeout: number): Promise<string> => new Promise(done => {
  execFile('kicad-cli', args, { timeout, maxBuffer: Infinity }, (_error, stdout, stderr) => done(stdout + stderr));
});

export type Rendered = { path: string } | { error: string };

const firstSvg = (folder: string): string | undefined => {
  const name = globNames(folder).filter(entry => entry.endsWith('.svg')).sort(compare)[0];
  return name ? join(folder, name) : undefined;
};

async function produce(view: string, source: string, folder: string, out: string): Promise<Rendered> {
  const done = view === 'sch' ? firstSvg(folder) : existsSync(out) ? out : undefined;
  if (done) return { path: done };
  mkdirSync(folder, { recursive: true });
  const log = await kicad((VIEWS[view] as [string, Command])[1](source, out), RENDER_TIMEOUT_MS);
  if (view === 'sch') {
    const made = firstSvg(folder);
    return made ? { path: made } : { error: log.slice(-800) };
  }
  if (!existsSync(out)) return { error: log.slice(-800) };
  const color = OVERLAYS[view]?.[1];
  if (color) writeFileSync(out, recolorSvg(readFileSync(out, 'utf8'), color));
  return { path: out };
}

// One render of a key at a time; later requests wait for the same result.
const running = new Map<string, Promise<Rendered>>();

export async function render(layout: Layout, kind: string, id: string, view: string): Promise<Rendered> {
  const item = findItem(layout, kind, id);
  const entry = VIEWS[view];
  if (!item || !entry) return { error: 'unknown item or view' };
  const source = view === 'sch' ? item.sch : item.pcb;
  if (!existsSync(source)) return { error: `no source ${basename(source)}` };
  const key = cacheKey([source], viewVariant(view));
  const folder = join(CACHE, key);
  const pending = running.get(key) ?? produce(view, source, folder, join(folder, `${id}-${view}.${entry[0]}`)).finally(() => running.delete(key));
  running.set(key, pending);
  return pending;
}

/** Live DRC with schematic parity on the source, cached by source hash. */
export async function drc(layout: Layout, kind: string, id: string) {
  const item = findItem(layout, kind, id);
  if (!item || !existsSync(item.pcb)) return { error: 'no pcb' };
  const base = item.pcb.replace(/\.kicad_pcb$/, '');
  const sources = [item.pcb, item.sch, `${base}.kicad_pro`, `${base}.kicad_dru`].filter(path => existsSync(path));
  const out = join(CACHE, cacheKey(sources, 'drc'), 'drc.json');
  if (!existsSync(out)) {
    mkdirSync(dirname(out), { recursive: true });
    await kicad(['pcb', 'drc', '--schematic-parity', '--refill-zones', '--format', 'json', '-o', out, item.pcb], DRC_TIMEOUT_MS);
  }
  const report = readLoose(out);
  const violations = (report.violations ?? []) as { severity?: string; type: string }[];
  const errors = violations.filter(row => row.severity === 'error');
  const byType: Record<string, number> = {};
  for (const { type } of errors) byType[type] = (byType[type] ?? 0) + 1;
  return {
    errors: errors.length, by_type: byType, unconnected: ((report.unconnected_items ?? []) as unknown[]).length,
    parity: ((report.schematic_parity ?? []) as unknown[]).length, warnings: violations.length - errors.length,
  };
}
