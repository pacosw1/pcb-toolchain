// A board row of the registry may record why it has no design contract, or no layout plan. Candidate commands and `next` read it here.
import { join } from 'node:path';
import { readObject } from './json-file.ts';
import { isFile } from './py-path.ts';

type Row = Record<string, unknown>;
const REGISTRY = 'hardware-design/registry/boards.json';

/** The reason a board has the exemption FIELD; null when it has none.
 *  An unreadable registry or a malformed exemption is an error: it must never read as an exemption or as no exemption. */
export function registryExemption(root: string, board: string, field: 'design_contract_exempt' | 'layout_plan_exempt'): string | null {
  const path = join(root, REGISTRY);
  if (!isFile(path)) return null;
  const boards = readObject(path, `${REGISTRY} must be a JSON object`).boards;
  if (!Array.isArray(boards)) throw new Error(`${REGISTRY} needs a boards list`);
  const rows = boards.filter((row): row is Row => !!row && typeof row === 'object' && !Array.isArray(row));
  const row = rows.find(entry => entry.id === board) ?? rows.find(entry => Array.isArray(entry.revisions) && entry.revisions.some(revision => revision?.gate === board));
  if (!row || row[field] === undefined) return null;
  const given = row[field] as Row | null, reason = given && typeof given === 'object' && !Array.isArray(given) ? given.reason : undefined;
  if (typeof reason !== 'string' || !reason.trim()) throw new Error(`${REGISTRY}: ${field} of ${board} must be an object with a non-empty reason`);
  return reason;
}

/** The reason a board is exempt from the design contract; null when it has no exemption. */
export const designExemption = (root: string, board: string): string | null => registryExemption(root, board, 'design_contract_exempt');
