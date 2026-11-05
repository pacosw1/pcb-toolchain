// Parts of a design block or board: what a .kicad_pcb says about them, their BOM, cost and declared facts. Pure code.
import { jsonDumps } from './py-compat.mjs';
import { round } from './py-numbers.ts';

export interface Part {
  ref: string;
  value: string;
  footprint: string;
  lcsc: string;
  mpn: string;
  description: string;
  datasheet: string;
  url: string;
  /** false when the footprint is excluded from the BOM. */
  bom?: false;
}

export interface Evidence {
  date: string;
  stock: unknown;
  verified: unknown;
  file: string;
  price?: number | null;
  jlc_class?: string | null;
}

export interface BomRow {
  refs: string[];
  value: string;
  footprint: string;
  lcsc: string;
  mpn: string;
  datasheet: string;
  qty: number;
  description: string;
  evidence?: Evidence | null;
}

/** File name to [actual sha256, sha256 in its .source.json], for the files that exist. */
export type DatasheetIndex = Map<string, [string, string]>;

export interface Facts {
  level?: unknown;
  layout_rules?: { rule?: unknown; source?: unknown }[];
  ports?: unknown[];
  [key: string]: unknown;
}

// Economic PCBA feeder loading fee per unique Extended part (jlcpcb.com/help/article/pcb-assembly-price, read
// 2026-09-26); Preferred parts are exempt.
export const JLC_EXTENDED_FEE_USD = 3.07;
export const C_NUMBER = /^C\d+$/;
const PROPERTY = /\(property "([^"]+)" "((?:[^"\\]|\\[^\n])*)"/g;
const FOOTPRINT = 'footprint "';

/** Top-level footprints of a .kicad_pcb text. `datasheet` is a file name only; a URL goes to `url`. */
export function parseFootprints(pcbText: string): Part[] {
  const parts: Part[] = [];
  for (const chunk of pcbText.split(/\n\t\((?=\S)/).slice(1)) {
    if (!chunk.startsWith(FOOTPRINT)) continue;
    const props = new Map<string, string>();
    for (const [, key, value] of chunk.matchAll(PROPERTY)) if (!props.has(key as string)) props.set(key as string, value as string);
    const datasheet = props.get('Datasheet') ?? '';
    const isUrl = datasheet.includes('://');
    const part: Part = {
      ref: props.get('Reference') ?? '', value: props.get('Value') ?? '',
      footprint: chunk.slice(FOOTPRINT.length, chunk.indexOf('"', FOOTPRINT.length)),
      lcsc: props.get('LCSC') ?? '', mpn: props.get('MPN') ?? '', description: props.get('Description') ?? '',
      datasheet: datasheet.toLowerCase().endsWith('.pdf') && !isUrl ? datasheet.slice(datasheet.lastIndexOf('/') + 1) : '',
      url: isUrl ? datasheet : '',
    };
    if (/\(attr[^)]*exclude_from_bom/.test(chunk)) part.bom = false;
    parts.push(part);
  }
  return parts;
}

/** The registry file for a part: <MPN>.pdf when it exists, else the local file named in the footprint. */
export function resolveDatasheet(part: Pick<Part, 'mpn' | 'datasheet'>, registry: ReadonlySet<string>): string {
  const byMpn = `${part.mpn}.pdf`;
  return part.mpn && registry.has(byMpn) ? byMpn : part.datasheet;
}

/** Boards whose .kicad_pcb holds a group named after the block: KiCad keeps one group per placed block. */
export function usedIn(boardTexts: ReadonlyMap<string, string>, blockId: string): string[] {
  const pattern = new RegExp(`\\(group "(?:[^"]*:)?${blockId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`);
  return [...boardTexts].filter(([, text]) => pattern.test(text)).map(([board]) => board).sort();
}

/** Natural order of references: C2 before C10. */
export function compareRefs(a: string, b: string): number {
  const x = a.split(/(\d+)/), y = b.split(/(\d+)/);
  for (let i = 0; i < x.length && i < y.length; i++) {
    const p = x[i] as string, q = y[i] as string;
    const order = i % 2 ? Number(p) - Number(q) : p < q ? -1 : p > q ? 1 : 0;
    if (order) return order;
  }
  return x.length - y.length;
}

export function bom(parts: readonly Part[]): BomRow[] {
  const groups = new Map<string, { part: Part; refs: string[] }>();
  for (const part of parts) {
    if (part.bom === false) continue;
    const key = JSON.stringify([part.value, part.footprint, part.lcsc, part.mpn, part.datasheet]);
    const group = groups.get(key) ?? { part, refs: [] };
    group.refs.push(part.ref);
    groups.set(key, group);
  }
  const descriptions = new Map<string, string>();
  for (const part of [...parts].sort((a, b) => compareRefs(a.ref, b.ref))) {
    if (!descriptions.has(part.ref)) descriptions.set(part.ref, part.description);
  }
  const rows = [...groups.values()].map(({ part, refs }): BomRow => {
    const ordered = [...refs].sort(compareRefs);
    return {
      refs: ordered, value: part.value, footprint: part.footprint, lcsc: part.lcsc, mpn: part.mpn,
      datasheet: part.datasheet, qty: refs.length,
      description: ordered.map(ref => descriptions.get(ref)).find(Boolean) ?? '',
    };
  });
  return rows.sort((a, b) => compareRefs(a.refs[0] as string, b.refs[0] as string));
}

export function checkParts(parts: readonly Part[], datasheets: DatasheetIndex): string[] {
  const errors: string[] = [];
  for (const { bom: listed, ref, lcsc, datasheet, url } of parts) {
    if (listed === false) continue;
    if (!C_NUMBER.test(lcsc)) errors.push(`${ref}: no JLC C-number`);
    const hashes = datasheets.get(datasheet);
    if (!datasheet) errors.push(url ? `${ref}: datasheet is only a URL, not in registry/datasheets` : `${ref}: no datasheet`);
    else if (!hashes) errors.push(`${ref}: ${datasheet} not in registry/datasheets`);
    else if (hashes[0] !== hashes[1]) errors.push(`${ref}: ${datasheet} sha256 does not match its .source.json`);
  }
  return errors;
}

export function validateFacts(facts: Facts): string[] {
  const errors = [0, 1, 2].includes(facts.level as number) ? [] : ['level must be 0, 1 or 2'];
  (facts.layout_rules ?? []).forEach((rule, index) => {
    if (!rule.rule) errors.push(`layout rule ${index + 1} has no text`);
    if (!rule.source) errors.push(`layout rule ${index + 1} has no source`);
  });
  return errors;
}

/** KiCad design block metadata: three keys, no indent, no trailing newline. */
export const kicadMeta = (description: string, keywords: string): string =>
  `{\n"description": ${jsonDumps(description)},\n"keywords": ${jsonDumps(keywords)},\n"fields": {}\n}`;

/** JLC class from the saved parts-API record, which knows Preferred; else the bridge class. */
export function jlcClass(record: Record<string, unknown> | null | undefined, bridgeClass: string | null): string | null {
  if (!record || !Object.keys(record).length) return bridgeClass;
  if (record.componentLibraryType === 'base') return 'Basic Part';
  return record.preferredComponentFlag ? 'Preferred Extended Part' : 'Extended Part';
}

/** Parts cost: unit price at the smallest quantity x qty. JLC adds a per-order fee for each unique Extended part. */
export function cost(rows: readonly Pick<BomRow, 'refs' | 'qty' | 'lcsc' | 'evidence'>[]) {
  let total = 0;
  const extended = new Set<string>(), unknown = new Set<string>(), missing: string[] = [];
  for (const { refs, qty, lcsc, evidence } of rows) {
    const price = evidence?.price;
    if (price === null || price === undefined) {
      missing.push(...refs);
      continue;
    }
    total += price * qty;
    if (evidence?.jlc_class?.startsWith('Extended')) extended.add(lcsc);
    else if (!evidence?.jlc_class) unknown.add(lcsc);
  }
  const fee = extended.size * JLC_EXTENDED_FEE_USD;
  return {
    parts_usd: round(total, 4), extended: [...extended].sort(), missing, unknown_class: [...unknown].sort(),
    extended_fee_usd: fee, first_board_usd: round(total + fee, 4),
  };
}
