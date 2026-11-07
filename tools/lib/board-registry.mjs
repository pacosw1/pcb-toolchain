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
