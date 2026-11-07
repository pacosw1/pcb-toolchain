// A board in and out of the placer: `iotplace read` makes a problem from the board JSON, `iotplace write` a pose into a board
// copy. Both run on the KiCad 11 document of tools/lib/board-json.ts; a write refills and saves with KiCad 10.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { boardJson } from '../lib/board-json.ts';
import { iotplaceBin } from '../lib/iotplace-bin.ts';
import { jsonDumps } from '../lib/py-compat.mjs';
import type { Pose } from './compact-geometry.ts';
import { checkProblem, type ReviewedProblem } from './engineering-problem.ts';

function inTempFolder<T>(body: (folder: string) => T): T {
  const folder = mkdtempSync(join(tmpdir(), 'placer-io-'));
  try {
    return body(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

function saveDocument(board: string, folder: string): string {
  const path = join(folder, 'board.json');
  writeFileSync(path, JSON.stringify(boardJson(board)));
  return path;
}

/** Runs `body` with the path of the board's JSON document. */
export const withBoardDocument = <T>(board: string, body: (document: string) => T): T => inTempFolder(folder => body(saveDocument(board, folder)));

/** Writes the problem of `board` to `output` and gives the reader's summary. `args` are the flags of `iotplace read`. */
export const readProblem = (board: string, output: string, args: readonly string[] = []): string => inTempFolder(folder => execFileSync(
  iotplaceBin(), ['read', board, `--board-json=${saveDocument(board, folder)}`, '-o', output, ...args], { encoding: 'utf8' }));

export interface WriteOptions { outlineScale?: number; retainCopper?: boolean; keepMisses?: boolean }
export interface WriteReport { moved_units: number; removed_tracks: number; removed_collisions: number; moved_block_tracks: number }

/** A copy of `board` with `pose`. A reviewed problem must pass its screen (unless keepMisses), keeps all copper and has no virtual outline. */
export function writeBoard(board: string, problem: ReviewedProblem, pose: Pose, output: string, options: WriteOptions = {}): WriteReport {
  const { outlineScale = 1, keepMisses = false } = options;
  let { retainCopper = false } = options;
  if (resolve(board) === resolve(output)) throw new Error('a write makes a copy only: the output must differ from the input board');
  if (problem.engineering) {
    if (realpathSync(board) !== realpathSync(problem.board_file)) throw new Error('reviewed placement writer source differs from its native model');
    const checked = checkProblem(problem, pose);
    if ((checked.status !== 'passed' && !keepMisses) || outlineScale !== 1) throw new Error(`reviewed engineering constraints reject placement: ${jsonDumps(checked.blockers)}`);
    retainCopper = true;   // Preserve the reviewed source; reconnect only explicit affected nets later.
  }
  return inTempFolder(folder => {
    const [prob, places] = [join(folder, 'prob.json'), join(folder, 'pose.json')];
    writeFileSync(prob, jsonDumps(problem));
    writeFileSync(places, jsonDumps(pose));
    const flags = ['--outline-scale', String(outlineScale), ...(retainCopper ? ['--retain-copper'] : [])];
    const text = execFileSync(iotplaceBin(), ['write', board, `--board-json=${saveDocument(board, folder)}`, prob, places, '-o', output, ...flags], { encoding: 'utf8' });
    return JSON.parse(text.trim().split('\n').at(-1) as string) as WriteReport;
  });
}
