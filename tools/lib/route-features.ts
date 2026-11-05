// The routing-flow feature switches for tools that are not Python: tools/route-features.json, then <board>/gate.json "route_features"
// merged per feature, then ROUTE_FEATURES="name=1,name=0" ("all=1" and "all=0" set every flag first). tools/route_features.py has the
// DSN side of them; a board's learned halo nets are read by it and written here, so the two must agree on the fingerprint.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { root } from './env.mjs';
import { readJson } from './json-file.ts';

const FLAGS = ['triage_opens', 'rule_compiler', 'via_off_small_pads', 'pin_escape_check', 'via_halo', 'routing_rules', 'fail_fast'];
/** Folders above a board that can hold its gate.json. */
const GATE_SEARCH_DEPTH = 4;

export interface Feature { on?: boolean; learn_noroom?: boolean; [key: string]: unknown }
export type Features = Record<string, Feature>;

const isFile = (file: string): boolean => existsSync(file) && statSync(file).isFile();
const stem = (pcb: string): string => pcb.replace(/\.[^./]*$/, '');
const boardsFolder = (project: string): string => join(project, 'hardware-design', 'boards');

/** The board folder, or null: ROUTE_BOARD, a board named as the file (revision B keeps its CAD under BASE-PWR), then the gate.json above the file. */
export function boardDir(pcb: string, project = root, env: NodeJS.ProcessEnv = process.env): string | null {
  const named = env.ROUTE_BOARD ?? '';
  if (named) {
    const folder = join(boardsFolder(project), named);
    return existsSync(folder) && statSync(folder).isDirectory() ? folder : null;
  }
  const own = join(boardsFolder(project), stem(basename(pcb)));
  if (isFile(join(own, 'gate.json'))) return own;
  let folder = dirname(resolve(pcb));
  for (let i = 0; i < GATE_SEARCH_DEPTH; i++) {
    if (isFile(join(folder, 'gate.json'))) return folder;
    folder = dirname(folder);
  }
  return null;
}

const isOn = (value: string): boolean => !['0', 'off', 'false', ''].includes(value.trim());

/** The resolved features of a board and its folder. */
export function loadFeatures(pcb: string, project = root, env: NodeJS.ProcessEnv = process.env): { features: Features; folder: string | null } {
  const features = readJson<{ features: Features }>(env.ROUTE_FEATURES_FILE || join(project, 'tools', 'route-features.json')).features;
  const folder = boardDir(pcb, project, env);
  if (folder && isFile(join(folder, 'gate.json'))) {
    const { route_features: over = {} } = readJson<{ route_features?: Features }>(join(folder, 'gate.json'));
    for (const [name, value] of Object.entries(over)) features[name] = { ...features[name], ...value };
  }
  const items = (env.ROUTE_FEATURES ?? '').split(',').filter(item => item.includes('=')).map((item): [string, string] => {
    const at = item.indexOf('=');
    return [item.slice(0, at).trim(), item.slice(at + 1)];
  });
  // all= first, so "all=0,via_halo=1" works.
  for (const [name, value] of items) if (name === 'all') for (const flag of FLAGS) features[flag]!.on = isOn(value);
  for (const [name, value] of items) if (name in features) features[name]!.on = isOn(value);
  return { features, folder };
}

export const featureOn = (features: Features, name: string): boolean => Boolean(features[name]?.on);

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Exact CAD and rule identity for learned hints. */
export function sourceFingerprint(pcb: string): Record<string, string> {
  return Object.fromEntries(['.kicad_pcb', '.kicad_pro', '.kicad_dru'].filter(suffix => isFile(stem(pcb) + suffix)).map(suffix => [suffix, sha256(stem(pcb) + suffix)]));
}

export const haloFile = (folder: string): string => join(folder, '.gate', 'halo-nets.json');

/** The learned halo nets of a board. A file of other CAD or rules gives none. */
export function learnedHalo(pcb: string, folder: string): string[] {
  const file = haloFile(folder);
  if (!isFile(file)) return [];
  const { nets = [], source_fingerprint: stamp } = readJson<{ nets?: string[]; source_fingerprint?: Record<string, string> }>(file);
  const wanted = sourceFingerprint(pcb);
  const same = stamp !== undefined && Object.keys(stamp).length === Object.keys(wanted).length && Object.entries(wanted).every(([suffix, hash]) => stamp[suffix] === hash);
  return same ? nets : [];
}
