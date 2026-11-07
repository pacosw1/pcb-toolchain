// Test helper: records a design contract exemption and a layout plan exemption for BOARD in the registry of a fixture project.
// `layout: false` leaves the layout plan exemption out, for a test of the layout plan itself.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

type Row = Record<string, unknown>;

export function exemptBoard(root: string, board: string, reason = 'test fixture has no design contract', more: Row = {}, layout = true): void {
  const path = join(root, 'hardware-design/registry/boards.json');
  const file = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as { boards: Row[] } : { schema_version: 1, boards: [] as Row[] };
  const row = file.boards.find(entry => entry.id === board) ?? file.boards.find(entry => (entry.revisions as Row[] | undefined)?.some(revision => revision.gate === board));
  const exempt = { design_contract_exempt: { reason }, ...(layout ? { layout_plan_exempt: { reason: 'test fixture has no layout plan' } } : {}) };
  if (row) { Object.assign(row, exempt); if (!layout) delete row.layout_plan_exempt; } else file.boards.push({ id: board, directory: board, ...more, ...exempt });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file));
}
