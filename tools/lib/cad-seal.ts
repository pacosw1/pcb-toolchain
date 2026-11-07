// The CAD seal: canonical board CAD changes only through our tools, and a change made any other way stops the next command.
// The gate configuration (gate.json) and the check data files (reference-planes.json, diff-pairs.json, current-paths.json, rf-lines.json,
// and each JSON rule file that a check names) are sealed too: a change there weakens the gate as much as a CAD change.
// hardware-design/boards/BOARD/cad-seal.json (committed) holds the sha256 of each sealed file and the last writer. The local
// log .gate/cad-seal/BOARD.jsonl gets one line per write or accepted edit. Run workspaces and candidate copies (a .gate/ segment
// in the root path) are not canonical and are never sealed.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { assertWritable } from './board-freeze.ts';
import { sha256Text } from './fingerprint.ts';
import { gateInputs } from './gate-inputs.mjs';
import { readObject, sha256File } from './json-file.ts';
import { durableAppend, durableJson } from './pcb-check-durable.ts';
import { SEAL_FILE } from './pcb-source-policy.ts';
import { boardConfig } from './pcb-workflow.ts';

export const SEAL_SCHEMA = 'iot-lab.cad-seal.v1';
const CAD = /\.kicad_(pcb|sch|pro|dru)$/;
// The data files of the gate: gate.json and the check data files by name. A rule file with another name is sealed through the rules of gateInputs.
const SEALED = /(?:\.kicad_(pcb|sch|pro|dru)|\/(?:placement-constraints|gate|reference-planes|diff-pairs|current-paths|rf-lines)\.json)$/;
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

/** The sealed files of BOARD: its gate inputs with a CAD extension or a data name, and the JSON rule files of its checks, inside the root. The list comes from gateInputs, not a second finder. */
function sealedFiles(root: string, board: string): Record<string, string> {
  boardConfig(root, board);   // a clear error for an unknown board, before gateInputs reads its gate.json
  const inputs = gateInputs(root, board), rules = new Set(inputs.rules.filter(path => path.endsWith('.json')));
  const found = inputs.files.filter(path => (SEALED.test(path) || rules.has(path)) && existsSync(path) && !relative(root, path).startsWith('..'));
  return Object.fromEntries(found.map(path => [posix(relative(root, path)), sha256File(path)]).sort(([a], [b]) => (a! < b! ? -1 : 1)));
}

/** One hash of the sealed schematic files of BOARD (.kicad_sch and .kicad_pro), from the same file list as the seal. */
export function schematicSha256(root: string, board: string): string {
  return sha256Text(JSON.stringify(Object.fromEntries(Object.entries(sealedFiles(root, board)).filter(([path]) => /\.kicad_(?:sch|pro)$/.test(path)))));
}

/** The sealed JSON files of BOARD with their hashes: the gate data files and each rule file that gate.json names. */
export function sealedJson(root: string, board: string): Record<string, string> {
  return Object.fromEntries(Object.entries(sealedFiles(root, board)).filter(([path]) => path.endsWith('.json')));
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
  // A seal made before the gate files were sealed lacks them: they show as added, and nothing else differs.
  const old = status.added.some(path => !CAD.test(path)) && !status.changed.length && !status.removed.length
    ? '\nThe gate configuration and the check data files are sealed too. If this seal comes from an older toolchain, it does not cover them: accept it once.' : '';
  throw new Error(`CAD of ${board} changed outside our tools:\n  ${rows.join('\n  ')}${old}\nUndo the change: git checkout -- <file>\nOr accept an edit that a person made in KiCad: tools/pcb seal ${board} --accept --reason TEXT`);
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

/** The calls of the seal lock, injected so a test needs no second process and no real wait. */
export interface SealLockDeps { pid: number; alive(pid: number): boolean; now(): number; sleep(ms: number): void; waitMs: number }
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
const sealLockDeps: SealLockDeps = { pid: process.pid, alive: pidAlive, now: Date.now, sleep: ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }, waitMs: LOCK_WAIT_S * 1000 };
const heldHere = new Set<string>();

function lockOwner(lock: string): number | null {
  try { const pid = (JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')) as { pid?: unknown }).pid; return Number.isInteger(pid) ? (pid as number) : null; } catch { return null; }
}

/**
 * Runs `work` while this process holds the seal lock of BOARD: a directory .gate/cad-seal/BOARD.write-lock that holds owner.json.
 * It is synchronous because sealedWrite is. A lock whose owner pid is gone is taken over; one without a readable owner never is.
 * A nested call for the same board in this process joins the lock it holds.
 */
export function withSealLock<T>(rootPath: string, board: string, work: () => T, deps: SealLockDeps = sealLockDeps): T {
  const lock = join(resolve(rootPath), '.gate/cad-seal', `${board}.write-lock`);
  if (heldHere.has(lock)) return work();
  mkdirSync(dirname(lock), { recursive: true });
  const deadline = deps.now() + deps.waitMs;
  for (;;) {
    // The owner record exists before the lock does: a rename onto a non-empty lock fails, so a crash never leaves a lock without an owner.
    const staging = mkdtempSync(`${lock}.new-`);
    writeFileSync(join(staging, 'owner.json'), JSON.stringify({ pid: deps.pid }));
    try { renameSync(staging, lock); break; } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    const owner = lockOwner(lock);
    if (owner !== null && !deps.alive(owner)) {
      const dead = `${lock}.dead-${deps.pid}`;
      try { renameSync(lock, dead); rmSync(dead, { recursive: true, force: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      continue;
    }
    if (deps.now() >= deadline) throw new Error(`CAD seal of ${board} is locked by pid ${owner ?? 'unknown'} (${lock}). Wait for that tool to end. If it died and left no owner record, remove that folder.`);
    deps.sleep(25);
  }
  heldHere.add(lock);
  try { return work(); } finally { heldHere.delete(lock); rmSync(lock, { recursive: true, force: true }); }
}

/** reseal under the board's seal lock: an adoption or a person's accepted edit. */
export async function resealLocked(root: string, board: string, writer: Writer, reason: string | null = null, deps?: SealLockDeps): Promise<void> {
  withSealLock(root, board, () => reseal(root, board, writer, reason), deps);
}

/** `tools/pcb seal BOARD --accept --reason TEXT`: a person's edit in KiCad becomes the sealed state, and so does the first seal. */
export async function acceptSeal(root: string, board: string, reason: string): Promise<void> {
  if (!reason?.trim()) throw new Error('--accept requires --reason TEXT');
  if (!isCanonicalRoot(root)) throw new Error(`${root} is a run workspace or candidate copy, not canonical; it is never sealed`);
  assertWritable(root, board);
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
export function sealedWrite<T>(path: string, writer: Writer, write: () => T, deps?: SealLockDeps): T {
  const targets = targetsOf(path);
  if (!targets) return write();
  // The seal lock of every covering board is held from the check to the new seal: no second writer is absorbed into this seal.
  const locked = (boards: string[]): T => {
    if (boards.length) return withSealLock(targets.root, boards[0]!, () => locked(boards.slice(1)), deps);
    for (const board of targets.boards) { assertWritable(targets.root, board); verifySeal(targets.root, board); }
    const result = write();   // a write that throws leaves the old seal: a partial write is then caught, not hidden
    for (const board of targets.boards) reseal(targets.root, board, writer);
    return result;
  };
  return locked([...targets.boards].sort());
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
