// Set the courtyard of a footprint: IPC-7351 nominal, pads + component body + margin (D-051).
//
//   tools/fp_courtyard.ts [--margin 0.25] [--bodies hardware-design/registry/courtyard-bodies.json] [--dry-run] FILE.kicad_mod ...
//
// Courtyard = one F.CrtYd rectangle around the union of all pads and the body, plus --margin (0.25 mm). Silk does not count
// (bridge parts draw silk outside the body). Every old F.CrtYd item is replaced. Body source, first that applies:
//   1. step: the xy box of the STEP model, placed by the footprint (model offset, rotate z, scale). It must lie inside the
//      pads + silk + fab box + 0.5 mm; else the model is misaligned and is not used.
//   2. fab: the F.Fab outline (fp_line / fp_rect / fp_poly; circles and text are markers, not outline).
//   3. datasheet: the --bodies JSON entry {"<C-number>": {"body": [x0, y0, x1, y1], "source": "..."}}.
// No source: the file is not changed and the exit code is 1.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseFlags, runMain, UsageError } from './lib/cli.ts';
import { courtyardBox, layerBox, pointsBox, setCourtyard, type Box } from './lib/courtyard.ts';
import { readJson } from './lib/json-file.ts';
import { projectRoot } from './lib/project-root.mjs';
import { round } from './lib/py-numbers.ts';
import { stepBox } from './lib/step-box.ts';

const USAGE = 'usage: tools/fp_courtyard.ts [--margin MM] [--bodies FILE] [--dry-run] FILE.kicad_mod ...';
const DEFAULT_MARGIN_MM = 0.25; // D-051
const ALIGN_TOLERANCE_MM = 0.5; // how far a placed STEP body may pass the pads + silk box before it counts as misaligned
const GROWN_EPSILON_MM = 1e-6;
const PAD = /\(pad\s+\S+\s+\S+\s+\S+\s+\(at\s+([-\d.]+)\s+([-\d.]+)(?:\s+([-\d.]+))?\)\s+\(size\s+([-\d.]+)\s+([-\d.]+)\)/g;
const MODEL = /\(model\s+"([^"]+)"([\s\S]*?)\n\s*\)/;
const VARIABLE = /\$\{(\w+)\}/g;
const FAB_OUTLINE = ['fp_line', 'fp_rect', 'fp_poly'];

export interface Model { path: string; offset: readonly [number, number]; scale: number; rotation: number }
export interface BodyEntry { body: Box; source?: string }
export interface Body { box: Box; source: string }
export interface BodySources { stepBox: (path: string) => Box | null; bodies: Record<string, BodyEntry>; key?: string; env?: Record<string, string | undefined>; root?: string }

export function union(a: Box | null, b: Box | null): Box | null {
  if (!a || !b) return a ?? b;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

const radians = (degrees: number): number => degrees * Math.PI / 180;

/** The box of all pads, each turned by its own rotation. */
export function padsBox(text: string): Box | null {
  return pointsBox([...text.matchAll(PAD)].flatMap(match => {
    const [x, y, rotation, width, height] = [match[1], match[2], match[3] ?? '0', match[4], match[5]].map(Number) as [number, number, number, number, number];
    const cos = Math.abs(Math.cos(radians(rotation)));
    const sin = Math.abs(Math.sin(radians(rotation)));
    const halfWidth = (width * cos + height * sin) / 2;
    const halfHeight = (width * sin + height * cos) / 2;
    return [[x - halfWidth, y - halfHeight], [x + halfWidth, y + halfHeight]] as const;
  }));
}

export const fabBox = (text: string): Box | null => layerBox(text, 'F.Fab', FAB_OUTLINE);

function xyz(key: string, text: string): [number, number, number] {
  const match = new RegExp(`\\(${key}\\s+\\(xyz\\s+([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)\\)`).exec(text);
  if (!match) throw new Error(`model has no ${key}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** The first model. Only a uniform scale and a z rotation are allowed. */
export function model(text: string, env: Record<string, string | undefined> = process.env, root = projectRoot()): Model | null {
  const match = MODEL.exec(text);
  if (!match) return null;
  const path = match[1]!.replace(VARIABLE, (whole, name: string) => env[name] ?? (name === 'IOT_LAB' ? root : whole));
  const offset = xyz('offset', match[2]!);
  const scale = xyz('scale', match[2]!);
  const rotation = xyz('rotate', match[2]!);
  if (new Set(scale).size !== 1 || rotation[0] || rotation[1]) {
    throw new Error(`model scale ${scale.join(' ')} / rotate ${rotation.join(' ')}: only a uniform scale and a z rotation are supported`);
  }
  return { path, offset: [offset[0], offset[1]], scale: scale[0], rotation: rotation[2] };
}

/**
 * STEP xy box (y up) to footprint box (y down). KiCad: scale, rotate by -rotation about z, add the offset, flip y. For a
 * rotation that is not a multiple of 90 the box of the turned corners holds the true box.
 */
export function place(raw: Box, { offset, scale, rotation }: Pick<Model, 'offset' | 'scale' | 'rotation'>): Box {
  const angle = radians(-rotation);
  const cos = round(Math.cos(angle), 12);
  const sin = round(Math.sin(angle), 12);
  const corners = [raw[0], raw[2]].flatMap(x => [raw[1], raw[3]].map(y => {
    const placedX = scale * (x * cos - y * sin) + offset[0];
    const placedY = scale * (x * sin + y * cos) + offset[1];
    return [round(placedX, 6) + 0, round(-placedY, 6) + 0] as const;
  }));
  return pointsBox(corners)!;
}

export function aligned(body: Box, text: string): boolean {
  const reference = union(union(padsBox(text), layerBox(text, 'F.SilkS')), fabBox(text));
  return reference !== null && body[0] >= reference[0] - ALIGN_TOLERANCE_MM && body[1] >= reference[1] - ALIGN_TOLERANCE_MM
    && body[2] <= reference[2] + ALIGN_TOLERANCE_MM && body[3] <= reference[3] + ALIGN_TOLERANCE_MM;
}

/** The body in footprint coordinates, from the first source that applies. */
export function bodyBox(text: string, sources: BodySources): Body {
  const found = model(text, sources.env, sources.root);
  const raw = found ? sources.stepBox(found.path) : null;
  let note = '';
  if (found && raw) {
    const placed = place(raw, found);
    if (aligned(placed, text)) return { box: placed, source: 'step' };
    note = ' (step misaligned)';
  }
  const fab = fabBox(text);
  if (fab) return { box: fab, source: `fab${note}` };
  const entry = sources.key === undefined ? undefined : sources.bodies[sources.key];
  if (entry) return { box: entry.body, source: `datasheet${note}` };
  throw new Error(`no body source${note}: add the datasheet body to --bodies`);
}

/** Pads and body, plus the margin, to a thousandth of a millimetre. */
export function courtyard(text: string, body: Box, margin: number): Box {
  const [x0, y0, x1, y1] = union(padsBox(text), body)!;
  const cut = (value: number): number => round(value, 3) + 0;
  return [cut(x0 - margin), cut(y0 - margin), cut(x1 + margin), cut(y1 + margin)];
}

const grew = (next: Box, old: Box | null): boolean => old !== null
  && (next[2] - next[0] > old[2] - old[0] + GROWN_EPSILON_MM || next[3] - next[1] > old[3] - old[1] + GROWN_EPSILON_MM);

const shown = (box: Box | null): string => (box ? box.map(value => round(value, 3)).join(' ') : '-');

function main(argv: string[]): number {
  const { values, positionals: files } = parseFlags(argv, { margin: { type: 'string' }, bodies: { type: 'string' }, 'dry-run': { type: 'boolean' } }, USAGE);
  if (!files.length) throw new UsageError(USAGE);
  const margin = values.margin === undefined ? DEFAULT_MARGIN_MM : Number(values.margin);
  if (Number.isNaN(margin)) throw new UsageError(USAGE);
  const bodiesFile = values.bodies ?? join(projectRoot(), 'hardware-design/registry/courtyard-bodies.json');
  const bodies = existsSync(bodiesFile) ? readJson<Record<string, BodyEntry>>(bodiesFile) : {};
  let failed = 0;
  console.log('file\tsource\tbody\told\tnew\tgrown');
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    try {
      const body = bodyBox(text, { stepBox, bodies, key: basename(dirname(dirname(resolve(file)))) });
      const next = courtyard(text, body.box, margin);
      const old = courtyardBox(text);
      console.log([file, body.source, shown(body.box), shown(old), shown(next), grew(next, old) ? 'GROWN' : ''].join('\t'));
      const updated = setCourtyard(text, next);
      if (updated !== text && !values['dry-run']) writeFileSync(file, updated);
    } catch (error) {
      console.error(`${file}\tERROR ${error instanceof Error ? error.message : String(error)}`);
      failed += 1;
    }
  }
  return failed ? 1 : 0;
}

runMain(import.meta.url, main);
