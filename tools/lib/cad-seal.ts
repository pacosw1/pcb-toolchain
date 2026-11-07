// The CAD seal: canonical board CAD changes only through our tools, and a change made any other way stops the next command.
// hardware-design/boards/BOARD/cad-seal.json (committed) holds the sha256 of each sealed file and the last writer. The local
// log .gate/cad-seal/BOARD.jsonl gets one line per write or accepted edit. Run workspaces and candidate copies (a .gate/ segment
// in the root path) are not canonical and are never sealed.
import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { sha256Text } from './fingerprint.ts';
import { holdLock } from './file-lock.ts';
import { gateInputs } from './gate-inputs.mjs';
import { readObject, sha256File } from './json-file.ts';
import { durableAppend, durableJson } from './pcb-check-durable.ts';
import { SEAL_FILE } from './pcb-source-policy.ts';
import { boardConfig } from './pcb-workflow.ts';

export const SEAL_SCHEMA = 'iot-lab.cad-seal.v1';
const SEALED = /(?:\.kicad_(pcb|sch|pro|dru)|\/placement-constraints\.json)$/;
const BOARDS = 'hardware-design/boards';
const LOCK_WAIT_S = 5;

export interface Writer { tool: string; run_id: string | null }
export interface Seal { schema: string; board: string; files: Record<string, string>; sha256: string; writer: Writer }
export interface SealStatus { board: string; state: 'sealed' | 'changed' | 'missing' | 'not_canonical'; seal: string; sha256: string | null; changed: string[]; added: string[]; removed: string[] }

/** A run workspace or candidate copy has a .gate/ segment in its path. */
export const isCanonicalRoot = (root: string): boolean => !resolve(root).split(sep).includes('.gate');
/** The tool that runs now, for the log: the script name. */
export const processWriter = (): Writer => ({ tool: basename(process.argv[1] ?? 'unknown').replace(/\.(ts|mts|mjs)$/, ''), run_id: null });

const sealPath = (root: string, board: string): string => join(root, BOARDS, board, SEAL_FILE);
const logPath = (root: string, board: string): string => join(root, '.gate/cad-seal', `${board}.jsonl`);
const posix = (path: string): string => path.split(sep).join('/');

/** The sealed files of BOARD: its gate inputs with a CAD extension, inside the root. The list comes from gateInputs, not a second finder. */
function sealedFiles(root: string, board: string): Record<string, string> {
  boardConfig(root, board);   // a clear error for an unknown board, before gateInputs reads its gate.json
  const found = gateInputs(root, board).files.filter(path => SEALED.test(path) && existsSync(path) && !relative(root, path).startsWith('..'));
  return Object.fromEntries(found.map(path => [posix(relative(root, path)), sha256File(path)]).sort(([a], [b]) => (a! < b! ? -1 : 1)));
}

function readSeal(root: string, board: string): Seal | null {
  const path = sealPath(root, board);
  if (!existsSync(path)) return null;
  const record = readObject<Seal>(path);
  if (record.schema !== SEAL_SCHEMA || record.board !== board || typeof record.files !== 'object' || record.files === null || typeof record.sha256 !== 'string') throw new Error(`${path} is not a ${SEAL_SCHEMA} record of ${board}`);
  return record;
}

export function sealStatus(rootPath: string, board: string): SealStatus {
  const root = resolve(rootPath), seal = sealPath(root, board);
  const status = (state: SealStatus['state'], sha256: string | null = null, changed: string[] = [], added: string[] = [], removed: string[] = []): SealStatus => ({ board, state, seal, sha256, changed, added, removed });
  if (!isCanonicalRoot(root)) return status('not_canonical');
  const record = readSeal(root, board);
  if (!record) return status('missing');
  const now = sealedFiles(root, board);
  const changed = Object.keys(now).filter(path => path in record.files && record.files[path] !== now[path]);
  const added = Object.keys(now).filter(path => !(path in record.files)), removed = Object.keys(record.files).filter(path => !(path in now));
  return status(changed.length || added.length || removed.length ? 'changed' : 'sealed', record.sha256, changed, added, removed);
}

/** Throws when BOARD has no seal or its sealed CAD changed. The message names each file and the two ways out. */
export function verifySeal(root: string, board: string): void {
  const status = sealStatus(root, board);
  if (status.state === 'missing') throw new Error(`${board} has no CAD seal (${status.seal}). Create the first seal: tools/pcb seal ${board} --accept --reason "first seal"`);
  if (status.state !== 'changed') return;
  const rows = [...status.changed.map(path => `changed: ${path}`), ...status.added.map(path => `added: ${path}`), ...status.removed.map(path => `removed: ${path}`)];
  throw new Error(`CAD of ${board} changed outside our tools:\n  ${rows.join('\n  ')}\nUndo the change: git checkout -- <file>\nOr accept an edit that a person made in KiCad: tools/pcb seal ${board} --accept --reason TEXT`);
}

/** Records the CAD of BOARD as it is now. A root that is not canonical is left alone. */
export function reseal(rootPath: string, board: string, writer: Writer, reason: string | null = null): void {
  const root = resolve(rootPath);
  if (!isCanonicalRoot(root)) return;
  const before = readSeal(root, board)?.sha256 ?? null, files = sealedFiles(root, board), sha256 = sha256Text(JSON.stringify(files));
  const record: Seal = { schema: SEAL_SCHEMA, board, files, sha256, writer };
  durableJson(sealPath(root, board), record);
  mkdirSync(dirname(logPath(root, board)), { recursive: true });
  durableAppend(logPath(root, board), JSON.stringify({ tool: writer.tool, run_id: writer.run_id, before, after: sha256, reason }) + '\n');
}

/** reseal under the board's seal lock, for callers that run async: an adoption or a person's accepted edit. */
export async function resealLocked(root: string, board: string, writer: Writer, reason: string | null = null): Promise<void> {
  const lock = await holdLock(join(resolve(root), '.gate/cad-seal', `${board}.lock`), { waitS: LOCK_WAIT_S });
  try { reseal(root, board, writer, reason); } finally { await lock.release(); }
}

/** `tools/pcb seal BOARD --accept --reason TEXT`: a person's edit in KiCad becomes the sealed state, and so does the first seal. */
export async function acceptSeal(root: string, board: string, reason: string): Promise<void> {
  if (!reason?.trim()) throw new Error('--accept requires --reason TEXT');
  if (!isCanonicalRoot(root)) throw new Error(`${root} is a run workspace or candidate copy, not canonical; it is never sealed`);
  await resealLocked(root, board, { tool: 'seal-accept', run_id: null }, reason.trim());
}

/** The root and the boards whose seal covers PATH, or null when PATH is not canonical CAD of a gate board. */
function targetsOf(path: string): { root: string; boards: string[] } | null {
  if (!SEALED.test(path)) return null;
  let folder = dirname(resolve(path));
  while (!existsSync(folder)) folder = dirname(folder);
  const real = join(realpathSync(folder), relative(folder, resolve(path)));
  let boards = dirname(real);
  while (basename(boards) !== 'boards' || basename(dirname(boards)) !== 'hardware-design') {
    if (dirname(boards) === boards) return null;
    boards = dirname(boards);
  }
  const root = dirname(dirname(boards)), file = posix(relative(root, real)), first = relative(boards, real).split(sep)[0]!;
  if (!isCanonicalRoot(root)) return null;
  const covering = readdirSync(boards).filter(name => existsSync(join(boards, name, SEAL_FILE)) && file in (readSeal(root, name)?.files ?? {}));
  const owner = existsSync(join(boards, first, 'gate.json')) ? [first] : [];
  const names = [...new Set([...owner, ...covering])];
  return names.length ? { root, boards: names } : null;
}

/** Runs `write`. When PATH is canonical CAD it checks the seal first and records the new state after, so a tool cannot break the seal. */
export function sealedWrite<T>(path: string, writer: Writer, write: () => T): T {
  const targets = targetsOf(path);
  if (!targets) return write();
  for (const board of targets.boards) verifySeal(targets.root, board);
  const result = write();   // a write that throws leaves the old seal: a partial write is then caught, not hidden
  for (const board of targets.boards) reseal(targets.root, board, writer);
  return result;
}

/** After an interrupted adoption: reseal only when PATH is the single file that differs from the seal. Anything else stays for a person. */
export function resealOnly(path: string, writer: Writer): void {
  const targets = targetsOf(path);
  if (!targets) return;
  const file = posix(relative(targets.root, realpathSync(path)));
  for (const board of targets.boards) {
    const status = sealStatus(targets.root, board);
    if (status.state === 'changed' && status.added.length === 0 && status.removed.length === 0 && status.changed.length === 1 && status.changed[0] === file) reseal(targets.root, board, writer);
  }
}
