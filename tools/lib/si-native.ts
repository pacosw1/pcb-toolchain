// The signal-integrity gates on the Mac side. `iotroute si-planes` and `iotroute si-pairs` do the checking; this fetches the board
// they read, with zones refilled by KiCad 10 (tools/lib/board-json.ts), and passes on their output and exit code.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardJson } from './board-json.ts';
import { iotrouteBin } from './iotroute-bin.ts';

/** Exit 2 of both checkers: nothing was checked. */
export const TOOL_ERROR = 2;

export type Checker = 'si-planes' | 'si-pairs';
export interface CheckerRun { readBoard: typeof boardJson; binary: () => string }

/** Runs one checker with its output on stdout. An error before it starts is exit 2: a gate never reads that as a pass. */
export function runChecker(checker: Checker, board: string, spec: string, options: string[], run: CheckerRun = { readBoard: boardJson, binary: iotrouteBin }): number {
  const work = mkdtempSync(join(tmpdir(), 'si-board-'));
  try {
    const boardFile = join(work, 'board.json');
    // A missing board goes on to the checker, which reports it in its own words.
    if (existsSync(board)) writeFileSync(boardFile, JSON.stringify(run.readBoard(board, { refill: true })));
    const child = spawnSync(run.binary(), [checker, board, spec, ...options, ...(existsSync(boardFile) ? ['--board-json', boardFile] : [])], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (child.error) throw child.error;
    return child.status ?? TOOL_ERROR;
  } catch (error) {
    console.log(`ERROR ${(error as Error).message}`);
    return TOOL_ERROR;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
