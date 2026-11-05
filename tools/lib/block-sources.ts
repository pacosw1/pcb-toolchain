// Blocks and boards of a project, read live at request time. Nothing generated is stored in the repository.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  bom, C_NUMBER, checkParts, cost, jlcClass, parseFootprints, resolveDatasheet, usedIn, validateFacts,
  type DatasheetIndex, type Evidence, type Facts,
} from './block-parts.ts';
import { compare, globNames } from './py-compat.mjs';
import { isDict, type Dict } from './py-values.ts';

export interface Layout { hd: string; lib: string; reg: string }
export interface Item { kind: 'block' | 'board'; id: string; dir: string; pcb: string; sch: string }

export const layoutOf = (root: string): Layout => {
  const hd = join(root, 'hardware-design');
  return { hd, lib: join(hd, 'blocks', 'iot-lab.kicad_blocks'), reg: join(hd, 'registry') };
};

const read = (path: string): string => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};

/** json.loads(text or '{}') of a file that may be absent, as plain values. */
export const readLoose = (path: string): Dict => {
  const value: unknown = JSON.parse(read(path) || '{}');
  return isDict(value) ? value : {};
};

/** Every block, then every board. A .kicad_pcb not named after its folder is a scratch copy. */
export function items({ hd, lib }: Layout): Item[] {
  const found: Item[] = [];
  for (const name of globNames(lib).filter(entry => entry.endsWith('.kicad_block')).sort(compare)) {
    const id = name.slice(0, -'.kicad_block'.length), dir = join(lib, name);
    found.push({ kind: 'block', id, dir, pcb: join(dir, `${id}.kicad_pcb`), sch: join(dir, `${id}.kicad_sch`) });
  }
  const boards = join(hd, 'boards');
  const pcbs = globNames(boards).flatMap(board => globNames(join(boards, board, 'cad')).flatMap(project =>
    globNames(join(boards, board, 'cad', project)).filter(name => name.endsWith('.kicad_pcb')).map(name => join(boards, board, 'cad', project, name))));
  for (const pcb of pcbs.sort(compare)) {
    const id = basename(pcb, '.kicad_pcb');
    if (id !== basename(dirname(pcb))) continue;
    found.push({ kind: 'board', id, dir: dirname(pcb), pcb, sch: pcb.replace(/\.kicad_pcb$/, '.kicad_sch') });
  }
  return found;
}

export const findItem = (layout: Layout, kind: string, id: string): Item | undefined =>
  items(layout).find(item => item.kind === kind && item.id === id);

/** A path under `root`, or null for one that leaves it. */
export function safePath(root: string, name: string): string | null {
  if (!name || isAbsolute(name)) return null;
  const base = realpathSync(root);
  let path: string;
  try {
    path = realpathSync(join(base, name));
  } catch {
    path = join(base, name);
  }
  return path.startsWith(base + sep) ? path : null;
}

const hashes = new Map<string, string>();

export function datasheetIndex({ reg }: Layout, names: readonly string[]): DatasheetIndex {
  const index: DatasheetIndex = new Map();
  for (const name of names) {
    const path = safePath(join(reg, 'datasheets'), name);
    const stat = path ? statSync(path, { throwIfNoEntry: false }) : undefined;
    if (!path || !stat) continue;
    const key = `${path}\0${stat.mtimeMs}\0${stat.size}`;
    if (!hashes.has(key)) hashes.set(key, createHash('sha256').update(readFileSync(path)).digest('hex'));
    index.set(name, [hashes.get(key) as string, (readLoose(`${path}.source.json`).sha256 as string) ?? '']);
  }
  return index;
}

const dated = (reg: string, file: string): string[] =>
  globNames(join(reg, 'evidence')).map(date => join(reg, 'evidence', date, file)).filter(path => statSync(path, { throwIfNoEntry: false })).sort(compare);

/** Newest dated JLC snapshot for a C-number. */
export function evidence({ reg }: Layout, lcsc: string): Evidence | null {
  const files = C_NUMBER.test(lcsc) ? dated(reg, `${lcsc}.json`) : [];
  const newest = files.at(-1);
  if (!newest) return null;
  const snapshot = readLoose(newest);
  const purchase = (snapshot.purchase_record ?? {}) as Dict;
  const bridge = /"JLCPCB Part Class"\s*:\s*"([^"]+)"/.exec(read(join(reg, 'cad-assets', lcsc, 'easyeda-bridge-source.json')));
  const api = dated(reg, `${lcsc}.api.json`).at(-1);
  const record = api ? readLoose(api).record as Dict | undefined : undefined;
  return {
    date: ((snapshot.fetched_at_utc as string) ?? '').slice(0, 10), stock: purchase.overseasStockCount ?? null, verified: snapshot.stock_verified ?? null,
    file: relative(reg, newest), price: (purchase.initialPrice as number) ?? null, jlc_class: jlcClass(record, bridge?.[1] ?? null),
  };
}

const SOURCE_FILES = ['.kicad_sch', '.kicad_pcb', '.kicad_pro', '.kicad_dru', '.json'];

export function detail(layout: Layout, kind: string, id: string): Dict | null {
  const item = findItem(layout, kind, id);
  if (!item) return null;
  const parts = parseFootprints(read(item.pcb));
  const registry = new Set(readdirSync(join(layout.reg, 'datasheets')));
  for (const part of parts) part.datasheet = resolveDatasheet(part, registry);
  const names = [...new Set(parts.map(part => part.datasheet).filter(Boolean))].sort(compare);
  const index = datasheetIndex(layout, names);
  const rows = bom(parts);
  for (const row of rows) row.evidence = evidence(layout, row.lcsc);
  const present = (path: string): boolean => Boolean(statSync(path, { throwIfNoEntry: false }));
  const result: Dict = {
    kind, id, bom: rows, cost: cost(rows), part_errors: checkParts(parts, index),
    datasheets: names.map(name => ({ name, ok: index.has(name) && index.get(name)?.[0] === index.get(name)?.[1], present: index.has(name) })),
    files: readdirSync(item.dir).filter(name => SOURCE_FILES.some(suffix => name.endsWith(suffix))).sort(compare),
    has_sch: present(item.sch), has_pcb: present(item.pcb),
  };
  const all = items(layout);
  if (kind === 'block') {
    const meta = readLoose(join(item.dir, `${id}.json`));
    const facts = readLoose(join(item.dir, 'facts.json')) as Facts;
    const boards = new Map(all.filter(entry => entry.kind === 'board').map(entry => [entry.id, read(entry.pcb)]));
    Object.assign(result, { description: meta.description ?? '', keywords: meta.keywords ?? '', facts, fact_errors: validateFacts(facts), used_in: usedIn(boards, id) });
  } else {
    const board = new Map([[id, read(item.pcb)]]);
    result.blocks = all.filter(entry => entry.kind === 'block' && usedIn(board, entry.id).length).map(entry => entry.id);
  }
  return result;
}

export function cacheKey(paths: readonly string[], variant: string): string {
  const hash = createHash('sha256').update(variant);
  for (const path of paths) hash.update(createHash('sha256').update(readFileSync(path)).digest());
  return hash.digest('hex').slice(0, 24);
}

function* walk(folder: string): Generator<string> {
  const entries = readdirSync(folder, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name));
  for (const entry of entries) if (!entry.isDirectory()) yield join(folder, entry.name);
  for (const entry of entries) if (entry.isDirectory()) yield* walk(join(folder, entry.name));
}

/** Short hash of path, size and mtime of every file under `roots`: changes when a source changes. */
export function revision(roots: readonly string[]): string {
  const hash = createHash('sha256');
  for (const root of roots) {
    if (!statSync(root, { throwIfNoEntry: false })) continue;
    for (const path of walk(root)) {
      const stat = statSync(path, { throwIfNoEntry: false, bigint: true });
      if (stat) hash.update(`${path}|${stat.size}|${stat.mtimeNs}\n`);
    }
  }
  return hash.digest('hex').slice(0, 16);
}
