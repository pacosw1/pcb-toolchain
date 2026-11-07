// Test helper: seals a fixture board and starts its change log, so the seal check and the change guard pass.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { boardShape } from './board-shape.ts';
import { isCanonicalRoot, reseal } from './cad-seal.ts';
import { changePath, recordChange } from './change-log.ts';
import { boardConfig } from './pcb-workflow.ts';

/** The log hashes the board shape, so a placeholder board text moves into a board that parses. Two texts stay two boards. */
function parsedBoard(root: string, board: string): void {
  const pcb = `${boardConfig(root, board).project}.kicad_pcb`, text = existsSync(pcb) ? readFileSync(pcb, 'utf8') : '';
  try { boardShape(text); } catch { mkdirSync(dirname(pcb), { recursive: true }); writeFileSync(pcb, `(kicad_pcb (fixture ${JSON.stringify(text)}))\n`); }
}

/** A second call starts the log again: the fixture edit that came before it needs no event. */
export const sealFixtureBoard = (root: string, board: string): void => {
  if (!isCanonicalRoot(root)) return reseal(root, board, { tool: 'fixture', run_id: null }, 'fixture');
  rmSync(changePath(root, board), { force: true });
  rmSync(join(root, 'hardware-design/boards', board, 'cad-seal.json'), { force: true });
  parsedBoard(root, board);
  reseal(root, board, { tool: 'fixture', run_id: null }, 'fixture');
  recordChange(root, board, { kind: 'baseline', reason: 'fixture', by: 'fixture', refs: [] });
};
