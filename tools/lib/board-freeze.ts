// A frozen board: the row of the board in hardware-design/registry/boards.json has `frozen: {reason}`.
// A frozen board refuses every write of its canonical CAD (a sealed write, an adoption, `seal --accept`, a rule change)
// unless a person recorded an unfreeze in hardware-design/boards/BOARD/unfreeze.json (schema iot-lab.unfreeze.v1).
// The record stays until a person removes it. It is no gate input (lib/gate-inputs.mjs). FOCUS.md `## Frozen` is a different rule (lib/pcb-workflow.ts).
import { join } from 'node:path';
import { registryExemption } from './design-exemption.ts';
import { readObject } from './json-file.ts';
import { durableJson } from './pcb-check-durable.ts';
import { isFile } from './py-path.ts';

export const UNFREEZE_SCHEMA = 'iot-lab.unfreeze.v1';
export interface UnfreezeRecord { schema: string; board: string; by: string; reason: string; frozen_reason: string }
export interface FreezeStatus { board: string; state: 'not_frozen' | 'frozen' | 'unfrozen' | 'invalid'; frozen_reason: string | null; record: UnfreezeRecord | null; problems: string[] }

const KEYS = ['schema', 'board', 'by', 'reason', 'frozen_reason'];
const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
export const unfreezePath = (root: string, board: string): string => join(root, 'hardware-design/boards', board, 'unfreeze.json');

/** Whether BOARD is frozen and whether a valid unfreeze record exists. A damaged registry field or record is an error state, never a free board. */
export function freezeStatus(root: string, board: string): FreezeStatus {
  const frozenReason = registryExemption(root, board, 'frozen');
  if (frozenReason === null) return { board, state: 'not_frozen', frozen_reason: null, record: null, problems: [] };
  const path = unfreezePath(root, board);
  if (!isFile(path)) return { board, state: 'frozen', frozen_reason: frozenReason, record: null, problems: [] };
  let record: UnfreezeRecord;
  try { record = readObject<UnfreezeRecord>(path, 'unfreeze.json must be a JSON object'); }
  catch (error) { return { board, state: 'invalid', frozen_reason: frozenReason, record: null, problems: [(error as Error).message] }; }
  const problems: string[] = [];
  if (record.schema !== UNFREEZE_SCHEMA) problems.push(`schema must be ${UNFREEZE_SCHEMA}`);
  if (record.board !== board) problems.push(`board must be ${board}`);
  if (!text(record.by)) problems.push('by must be text');
  if (!text(record.reason)) problems.push('reason must be text');
  return { board, state: problems.length ? 'invalid' : 'unfrozen', frozen_reason: frozenReason, record: problems.length ? null : record, problems };
}

/** Stops with a clear message unless BOARD may be written. */
export function assertWritable(root: string, board: string): void {
  const status = freezeStatus(root, board);
  if (status.state === 'not_frozen' || status.state === 'unfrozen') return;
  if (status.state === 'invalid') throw new Error(`${board} is frozen: ${status.frozen_reason}\nThe unfreeze record is not valid (${status.problems.join('; ')}). A person records it again: tools/pcb unfreeze ${board} --record --by NAME --reason TEXT`);
  throw new Error(`${board} is frozen: ${status.frozen_reason}\nA frozen board accepts no write of its CAD. A person records an unfreeze first: tools/pcb unfreeze ${board} --record --by NAME --reason TEXT`);
}

/** Writes the unfreeze record of a frozen board. The tool does not check who BY is. */
export function recordUnfreeze(root: string, board: string, { by, reason }: { by?: string; reason?: string }): UnfreezeRecord {
  if (!text(by)) throw new Error('--by NAME is required');
  if (!text(reason)) throw new Error('--reason TEXT is required');
  const status = freezeStatus(root, board);
  if (status.state === 'not_frozen') throw new Error(`${board} is not frozen: its row in hardware-design/registry/boards.json has no frozen field`);
  const record: UnfreezeRecord = { schema: UNFREEZE_SCHEMA, board, by: by.trim(), reason: reason.trim(), frozen_reason: status.frozen_reason as string };
  durableJson(unfreezePath(root, board), Object.fromEntries(KEYS.map(key => [key, record[key as keyof UnfreezeRecord]])));
  return record;
}
