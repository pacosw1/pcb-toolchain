// The board registry (hardware-design/registry/boards.json) read by the plain Node tools.
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {PyError} from './py-compat.mjs';

const SAFE_DIRECTORY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The registry rows, or [] when the registry file does not exist. */
export function registryBoards(root) {
  const path = join(root, 'hardware-design/registry/boards.json');
  if (!existsSync(path)) return [];
  const boards = JSON.parse(readFileSync(path, 'utf8')).boards;
  if (!Array.isArray(boards)) throw new PyError('ValueError', `${path}: boards must be a list`);
  return boards;
}

/**
 * The folder under hardware-design/boards that holds the packet files of a gate name. A revision gate such as
 * CELLULAR-B belongs to the folder of the board that owns the revision, like the context reader (registryRevision).
 */
export function packetDirectory(root, board) {
  const rows = registryBoards(root);
  const owner = rows.find(row => row.revisions?.some(revision => revision.gate === board));
  const directory = (owner ?? rows.find(row => row.id === board))?.directory ?? board;
  if (typeof directory !== 'string' || !SAFE_DIRECTORY.test(directory)) throw new PyError('ValueError', `unsafe board directory for ${board}: ${directory}`);
  return directory;
}

/**
 * The gate file to read for a board: the registry row decides the state, not the file names.
 * - pending_gate in the row: the board has no active gate. A gate.json is a conflict and is refused.
 * - no pending_gate: gate.json is the active gate. A gate.pending.json beside it is the next revision and is ignored.
 *   A gate.pending.json alone is refused: the registry does not say that the board is pending.
 * Returns null when the folder has no gate file to read.
 */
export function gateFileName(root, board, folder) {
  const row = registryBoards(root).find(entry => entry.id === board);
  const active = existsSync(join(folder, 'gate.json')), waiting = existsSync(join(folder, 'gate.pending.json'));
  if (row && 'pending_gate' in row) {
    if (row.pending_gate !== 'gate.pending.json') throw new PyError('ValueError', `${board}: pending_gate must be gate.pending.json`);
    if (active) throw new PyError('ValueError', `${board}: the registry row has pending_gate but gate.json exists`);
    return waiting ? 'gate.pending.json' : null;
  }
  if (active) return 'gate.json';
  if (waiting) throw new PyError('ValueError', `${board}: gate.pending.json exists but the registry row has no pending_gate`);
  return null;
}
