// Test helper: records a design contract exemption for BOARD in the registry of a fixture project.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

type Row = Record<string, unknown>;

export function exemptBoard(root: string, board: string, reason = 'test fixture has no design contract'): void {
  const path = join(root, 'hardware-design/registry/boards.json');
  const file = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as { boards: Row[] } : { schema_version: 1, boards: [] as Row[] };
  const row = file.boards.find(entry => entry.id === board) ?? file.boards.find(entry => (entry.revisions as Row[] | undefined)?.some(revision => revision.gate === board));
  if (row) row.design_contract_exempt = { reason }; else file.boards.push({ id: board, design_contract_exempt: { reason } });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file));
}
