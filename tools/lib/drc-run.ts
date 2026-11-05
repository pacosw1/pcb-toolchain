// DRC of a board with KiCad 10 kicad-cli, for the read commands of pcbtool. The report is read here; drc-summary.ts words it.
import { execFile, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { DrcFile } from './board-edit.ts';
import { summarizeDrc, type DrcSummary } from './drc-summary.ts';
import { kicadCli } from './env.mjs';
import { readJson } from './json-file.ts';

const NOT_COPIED = /\.lck$|\.step$|\.stp$|\.wrl$|-backups$/;

/** A copy of the project folder for a DRC that must not touch the board: heavy models and backups stay behind. */
export function copyProject(folder: string, into: string): void {
  cpSync(folder, into, { recursive: true, dereference: true, filter: source => source === folder || !NOT_COPIED.test(basename(source)) });
}

/** Runs `use` with a temporary folder holding a project copy, and gives the board's path in the copy. */
export async function inProjectCopy<T>(pcb: string, use: (board: string, folder: string) => T | Promise<T>): Promise<T> {
  const board = resolve(pcb);
  const work = mkdtempSync(join(tmpdir(), 'pcbtool-copy-'));
  try {
    const project = join(work, basename(dirname(board)));
    copyProject(dirname(board), project);
    return await use(join(project, basename(board)), work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The DRC summary with schematic parity of the board as it is on disk. */
export function boardDrc(pcb: string): DrcSummary {
  const report = join(dirname(resolve(pcb)), '.pcbtool-drc.json');
  spawnSync(kicadCli, ['pcb', 'drc', '--schematic-parity', '--format', 'json', '-o', report, pcb], { stdio: 'ignore' });
  try {
    return summarizeDrc(readJson<DrcFile>(report));
  } finally {
    rmSync(report, { force: true });
  }
}

/** The report of a kicad-cli run. Fail closed: a killed or failed run, a missing, broken or incomplete report is never a clean DRC. */
export function checkDrcReport(code: number | null, report: string): DrcFile {
  if (code !== 0) throw new Error(`kicad-cli pcb drc exit ${code}`);
  if (!existsSync(report)) throw new Error('kicad-cli pcb drc wrote no report');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(report, 'utf8'));
  } catch {
    throw new Error('kicad-cli pcb drc report is not valid JSON');
  }
  const drc = parsed as DrcFile | null;
  if (drc === null || typeof drc !== 'object' || !Array.isArray(drc.violations) || !Array.isArray(drc.unconnected_items)) {
    throw new Error('kicad-cli pcb drc report has no violations / unconnected_items lists');
  }
  return drc;
}

const run = promisify(execFile);
const OUTPUT_BYTES = 64 * 1024 * 1024;

/** The exit code of a program; a signal counts as a failed run. */
export async function exitOf(program: string, args: string[]): Promise<number | null> {
  try {
    await run(program, args, { maxBuffer: OUTPUT_BYTES });
    return 0;
  } catch (error) {
    return typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null;
  }
}

/** The DRC report of a board with its zones refilled, or an error: checkDrcReport. */
export async function drcRefill(board: string): Promise<DrcFile> {
  const report = join(dirname(board), 'suggest-drc.json');
  const code = await exitOf(kicadCli, ['pcb', 'drc', '--refill-zones', '--format', 'json', '-o', report, board]);
  return checkDrcReport(code, report);
}
