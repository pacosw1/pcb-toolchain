// Proof that a failed compaction step broke a mandatory rule of copper this run may not change, so no other placement can
// help. The rule check is the board's route_rules plugin, run by the router job; it writes route-0/mandatory-preflight.json.
// Here its receipt is checked against the CAD itself: a stop needs a locked track that the input board, the step board and
// the receipt all hold unchanged, under the policy files as they are now. Unknown, stale or malformed records never stop a run.
import { existsSync, readFileSync } from 'node:fs';
import { boardJson } from '../lib/board-json.ts';
import { tracks, vias, type Board } from '../lib/board-types.ts';
import { sha256File } from '../lib/json-file.ts';
import { joinPath } from '../lib/py-path.ts';
import type { Dict } from '../lib/py-values.ts';

const ROW_FIELDS = ['uuid', 'net', 'layer', 'via', 'kind', 'locked', 'geometry', 'width'] as const;
const LOCKED_PRESERVATION = 'locked or retained by this invocation';
const BOARD_NAME = /^[A-Z0-9][A-Z0-9-]*$/;

export type Row = Dict;

const sameRow = (a: Row | undefined, b: Row | undefined): boolean => a !== undefined && b !== undefined
  && ROW_FIELDS.every(field => JSON.stringify(a[field]) === JSON.stringify(b[field]));

const same = (a: unknown, b: unknown): boolean => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, item]) => [key, sorted(item)]));
}

const byUuid = (rows: Row[]): Map<unknown, Row> => new Map(rows.map(row => [row.uuid, row]));
const isRows = (value: unknown): value is Row[] => Array.isArray(value) && value.every(row => row !== null && typeof row === 'object' && !Array.isArray(row));

/** The copper of a board document as receipt rows. */
export function copperRows(board: Board): Row[] {
  const trackRows = tracks(board).map(t => ({
    uuid: t.id, net: t.net, layer: t.layer, via: false, kind: t.mid ? 'PCB_ARC' : 'PCB_TRACK', locked: t.locked,
    geometry: [[t.start.x, t.start.y], [t.end.x, t.end.y]], width: t.width,
  }));
  const viaRows = vias(board).map(v => ({
    uuid: v.id, net: v.net, layer: v.layers[0] ?? '', via: true, kind: 'PCB_VIA', locked: v.locked, geometry: [[v.at.x, v.at.y]], width: v.size,
  }));
  return [...trackRows, ...viaRows];
}

export const boardRows = (path: string): Row[] => copperRows(boardJson(path).board);

function policyBinding(receipt: Dict): Dict {
  const identity = receipt.board_identity as Dict;
  const project = identity.source_project;
  return Object.fromEntries(Object.entries(receipt.policy_sources as Dict).map(([path, hash]) => [path === project ? '<input-project>' : path, hash]));
}

const withoutProject = (receipt: Dict): Dict => Object.fromEntries(Object.entries(receipt.board_identity as Dict).filter(([key]) => key !== 'source_project'));

function bound(receipt: Dict, seed: Dict, candidateSha: string, policyHashes: Dict): boolean {
  return receipt.board_sha256 === candidateSha && receipt.qualified === false && same(receipt.policy_sources, policyHashes)
    && same(policyBinding(receipt), policyBinding(seed)) && same(receipt.preserved_pair_profile, seed.preserved_pair_profile)
    && same(receipt.routed_nets, seed.routed_nets) && receipt.unlock_nets === seed.unlock_nets
    && same(withoutProject(receipt), withoutProject(seed));
}

/** The faults of `receipt` that prove a locked source track fails: it is unchanged in the seed, the candidate and the receipt. */
export function lockedFaults(receipt: Dict, candidateSha: string, candidateRows: Row[], seed: Dict, policyHashes: Dict): Dict[] {
  try {
    const collections = [receipt.faults, receipt.source_records, seed.faults, seed.source_records, candidateRows];
    if (!collections.every(isRows)) return [];
    if (!bound(receipt, seed, candidateSha, policyHashes)) return [];
    const [source, reported] = [seed.source_records, receipt.source_records] as [Row[], Row[]];
    const originals = byUuid(source), actual = byUuid(candidateRows), claimed = byUuid(reported);
    if (originals.size !== source.length || actual.size !== candidateRows.length || claimed.size !== reported.length) return [];
    return (receipt.faults as Dict[]).filter(fault => {
      const original = originals.get(fault.uuid);
      if (!fault.uuid || fault.source_locked !== true || fault.preservation !== LOCKED_PRESERVATION) return false;
      if (!original || original.locked !== true || original.via || original.kind !== 'PCB_TRACK') return false;
      if (!sameRow(actual.get(fault.uuid), original) || !sameRow(claimed.get(fault.uuid), original)) return false;
      if (fault.net !== original.net || fault.layer !== original.layer) return false;
      return (seed.faults as Dict[]).some(row => same(row, fault));
    });
  } catch (error) {
    if (error instanceof TypeError) return [];
    throw error;
  }
}

/** The receipt of a step, read against the input board. */
export function stepFaults(receipt: Dict, stepBoard: string, inputRows: Row[], rowsOf: (path: string) => Row[] = boardRows): Dict[] {
  const policy = Object.fromEntries(Object.keys(receipt.policy_sources as Dict).map(path => [path, sha256File(path)]));
  return lockedFaults(receipt, sha256File(stepBoard), rowsOf(stepBoard), { ...receipt, source_records: inputRows }, policy);
}

function gateConfig(root: string, board: string): Dict | null {
  const folder = joinPath(root, 'hardware-design/boards', board);
  const path = ['gate.json', 'gate.pending.json'].map(name => joinPath(folder, name)).find(file => existsSync(file));
  return path ? JSON.parse(readFileSync(path, 'utf8')) as Dict : null;
}

/** The first candidate board whose route_rules plugin has mandatory preserved-copper rules. */
export function mandatoryBoard(root: string, candidates: readonly string[]): string | null {
  for (const board of candidates) {
    if (!BOARD_NAME.test(board)) continue;
    const plugin = gateConfig(root, board)?.route_rules;
    if (typeof plugin !== 'string') continue;
    const file = joinPath(root, plugin);
    if (existsSync(file) && /^def preserved_input_faults\b/m.test(readFileSync(file, 'utf8'))) return board;
  }
  return null;
}
