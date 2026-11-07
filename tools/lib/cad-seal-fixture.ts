// Test helper: seals a fixture board and starts its change log, so the seal check and the change guard pass.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { boardShape } from './board-shape.ts';
import { isCanonicalRoot, reseal } from './cad-seal.ts';
import { changePath, recordChange } from './change-log.ts';
import { boardConfig } from './pcb-workflow.ts';
import { releaseOrdersPath } from './release-order.mjs';

/** The log hashes the board shape, so a placeholder board text moves into a board that parses. Two texts stay two boards. */
function parsedBoard(root: string, board: string): void {
  const pcb = `${boardConfig(root, board).project}.kicad_pcb`, text = existsSync(pcb) ? readFileSync(pcb, 'utf8') : '';
  try { boardShape(text); } catch { mkdirSync(dirname(pcb), { recursive: true }); writeFileSync(pcb, `(kicad_pcb (fixture ${JSON.stringify(text)}))\n`); }
}

export const ORDERED_HASH = 'a'.repeat(64);

/** Writes one order record, so a defect has a recorded release to name. */
export function orderFixture(root: string, board: string): void {
  writeFileSync(releaseOrdersPath(root, board), `${JSON.stringify({ schema: 'iot-lab.release-order.v1', board, by: 'Ana', candidate_sha256: ORDERED_HASH, approval_sha256: 'b'.repeat(64), what: 'boards', quantity: 5, reference: 'PO-1' })}\n`);
}

/** A sealed board that the machine lets release: its layout plan is exempt, so a test of a release record needs no plan. */
export function releaseFixtureBoard(root: string, board: string): void {
  mkdirSync(join(root, 'hardware-design/registry'), { recursive: true });
  writeFileSync(join(root, 'hardware-design/registry/boards.json'), JSON.stringify({ schema_version: 1, boards: [{ id: board, layout_plan_exempt: { reason: 'fixture' } }] }));
  sealFixtureBoard(root, board);
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
