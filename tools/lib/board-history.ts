// `pcb history`: one time-ordered log of a board. It joins the logs that exist and stores nothing, so it is no second source of truth.
// A seal line has no time. It takes the place of its run, or the place after the line before it, and `placed_by` says which.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readChanges } from './change-log.ts';
import { readObject } from './json-file.ts';
import { verifySettled } from './pcb-evidence.ts';
import { RUN_ID } from './pcb-runs.ts';
import { releaseApprovalStatus } from './release-approval.mjs';
import { releaseOrders, type ReleaseOrder } from './release-order.mjs';
import { loadTransitions } from './transitions.ts';

type Row = Record<string, unknown>;
export interface HistoryItem { name: string; sha256?: string | null; path?: string }
export interface HistoryEntry {
  at: string | null; placed_by: 'time' | 'run' | 'log_order'; source: 'change' | 'seal' | 'layout' | 'run' | 'release'; id: string; type: string; by: string | null; summary: string;
  stages: string[]; inputs: HistoryItem[]; outputs: HistoryItem[]; status?: string; sealed?: boolean; cause?: string;
}
export interface BoardHistory { schema: 'iot-lab.board-history.v1'; board: string; entries: HistoryEntry[]; problems: string[] }
type Placed = HistoryEntry & { order: number };

/** The stage that a run of each operation belongs to. An edit run belongs to the stage of its kind. */
const RUN_STAGE: Record<string, string> = { design: 'A1', parts: 'A3', place: 'A11', route: 'A14', repair: 'A16', check: 'A18', build: 'A20', release: 'A21' };
const runStages = (operation: string, kind: unknown): string[] => { const stage = RUN_STAGE[operation === 'edit' ? String(kind) : operation]; return stage ? [stage] : []; };

const messageOf = (error: unknown): string => (error as Error).message;
const text = (value: unknown): string | null => typeof value === 'string' ? value : null;
const timeOf = (value: string): number => { const time = Date.parse(value); return Number.isNaN(time) ? -Infinity : time; };

function jsonLines(path: string, name: string, problems: string[]): Row[] {
  if (!existsSync(path)) return [];
  const rows: Row[] = [];
  readFileSync(path, 'utf8').split('\n').filter(Boolean).forEach((line, index) => {
    try { rows.push(JSON.parse(line) as Row); } catch { problems.push(`${name} line ${index + 1} is not JSON`); }
  });
  return rows;
}

function changes(root: string, board: string, problems: string[]): Placed[] {
  try {
    return readChanges(root, board).map(event => {
      const groups = Object.entries(event.groups);
      return { at: event.at, placed_by: 'time', order: timeOf(event.at), source: 'change', id: event.id, type: event.kind, by: event.by, summary: event.reason, stages: [...(loadTransitions().kinds.find(kind => kind.id === event.kind)?.reenter ?? [])],
        inputs: [...event.refs.map(name => ({ name })), ...groups.filter(([, change]) => event.kind !== 'baseline' || change.before).map(([name, change]) => ({ name, sha256: change.before }))],
        outputs: groups.map(([name, change]) => ({ name, sha256: change.after })) };
    });
  } catch (error) { problems.push(`The change log is not valid: ${messageOf(error)}`); return []; }
}

function layouts(root: string, board: string, problems: string[]): Placed[] {
  return jsonLines(join(root, '.gate/layout-plan', `${board}.jsonl`), 'layout log', problems).map((row, index) => {
    const at = text(row.time), keys = ['rules_sha256', 'route_plan_sha256', 'schematic_sha256', 'board_shape_sha256'].filter(key => key in row);
    return { at, placed_by: 'time', order: at ? timeOf(at) : -Infinity, source: 'layout', id: `layout-${index + 1}`, type: String(row.type), by: text(row.by), summary: text(row.reason) ?? '', stages: [row.type === 'layout_plan.approved' ? 'A8' : 'A7'],
      inputs: keys.map(key => ({ name: key.replace('_sha256', ''), sha256: text(row[key]) })),
      outputs: text(row.image) ? [{ name: 'image', path: text(row.image)!, sha256: text(row.image_sha256) }] : [] };
  });
}

function runEntry(base: string, id: string, board: string): Placed | null {
  const folder = join(base, id), run = readObject<Row>(join(folder, 'run.json'));
  if (run.board !== board) return null;
  const at = text(run.created_at), action = (run.action ?? {}) as Row;
  const entry: Placed = { at, placed_by: 'time', order: at ? timeOf(at) : -Infinity, source: 'run', id, type: String(run.operation), by: null, summary: '', sealed: false, stages: runStages(String(run.operation), run.kind), inputs: [
    ...(text(action.source_revision) ? [{ name: 'source_revision', sha256: text(action.source_revision) }] : []),
    ...(text(run.gate_config_sha256) ? [{ name: 'gate_config', sha256: text(run.gate_config_sha256) }] : [])], outputs: [] };
  try {
    verifySettled(folder);
    const result = readObject<{ status?: string; evidence_sha256?: Record<string, string> }>(join(folder, 'result.json'));
    return { ...entry, sealed: true, status: String(result.status), summary: String(result.status), outputs: Object.entries(result.evidence_sha256 ?? {}).map(([name, sha256]) => ({ name, path: join(folder, name), sha256 })) };
  } catch (error) { return { ...entry, summary: 'not sealed', cause: messageOf(error) }; }
}

function runs(base: string, board: string, problems: string[]): Placed[] {
  if (!existsSync(base)) return [];
  return readdirSync(base).filter(name => RUN_ID.test(name)).sort().flatMap(id => {
    try { return runEntry(base, id, board) ?? []; } catch (error) { problems.push(`${id}: ${messageOf(error)}`); return []; }
  });
}

/** The time of a seal line is never known. A line of a run comes after that run, and no line comes before the line above it. */
function seals(root: string, board: string, known: Placed[], problems: string[]): Placed[] {
  const byId = new Map(known.map(entry => [entry.id, entry])), rows = jsonLines(join(root, '.gate/cad-seal', `${board}.jsonl`), 'seal log', problems);
  let order = -Infinity;
  return rows.map((row, index) => {
    const run = byId.get(String(row.run_id));
    order = Math.max(order, run?.order ?? -Infinity);
    return { at: null, placed_by: run ? 'run' : 'log_order', order, source: 'seal', id: `seal-${index + 1}`, type: String(row.tool), by: null, summary: text(row.reason) ?? '', stages: ['A4', 'B4'],
      inputs: [{ name: 'cad-seal', sha256: text(row.before) }], outputs: [{ name: 'cad-seal', sha256: text(row.after) }] };
  });
}

/** The committed release records have no time, and the local release log gives it. A record with no time takes the place after the record above it. */
function releases(root: string, board: string, base: string, known: Placed[], problems: string[]): Placed[] {
  const log = jsonLines(join(root, '.gate/release-approval', `${board}.jsonl`), 'release log', problems);
  const timeIn = (type: string, key: string, value: string): string | null => text(log.findLast(row => row.type === type && row[key] === value)?.time);
  let last = Math.max(-Infinity, ...known.map(entry => entry.order));
  const placed = (at: string | null) => { const order = at ? timeOf(at) : last; last = Math.max(last, order); return { at, placed_by: at ? 'time' as const : 'log_order' as const, order, source: 'release' as const }; };
  // `base` holds no manifest. The history shows the record, and `pcb state` judges its freshness.
  const { approval, problems: bad } = releaseApprovalStatus(root, board, base);
  problems.push(...bad);
  const rows: Placed[] = approval ? [{ ...placed(timeIn('release_approval.approved', 'candidate_sha256', approval.candidate_sha256)), id: 'release-approval', type: 'release_approval.approved', by: approval.by, summary: approval.reason, stages: ['A22'],
    inputs: [{ name: 'candidate', sha256: approval.candidate_sha256 }, { name: 'report', path: approval.report, sha256: approval.report_sha256 }, { name: 'image', path: approval.image, sha256: approval.image_sha256 }],
    outputs: [{ name: 'release-approval', path: join('hardware-design/boards', board, 'release-approval.json') }] }] : [];
  let orders: ReleaseOrder[] = [];
  try { orders = releaseOrders(root, board); } catch (error) { problems.push(messageOf(error)); }
  return [...rows, ...orders.map((order): Placed => ({ ...placed(timeIn('release_order.recorded', 'reference', order.reference)), id: `order-${order.reference}`, type: 'release_order.recorded', by: order.by, summary: `${order.quantity} x ${order.what}`, stages: ['A24'],
    inputs: [{ name: 'candidate', sha256: order.candidate_sha256 }, { name: 'approval', sha256: order.approval_sha256 }], outputs: [{ name: `order ${order.reference}` }] }))];
}

/** The log of BOARD, oldest first. A source that cannot be read is a problem in the output, and the other sources stay. */
export function boardHistory(root: string, board: string, base: string): BoardHistory {
  const problems: string[] = [], finished = runs(base, board, problems);
  const placed = [...finished, ...seals(root, board, finished, problems), ...changes(root, board, problems), ...layouts(root, board, problems), ...releases(root, board, base, finished, problems)];
  const entries = placed.map((entry, index) => ({ entry, index })).sort((a, b) => a.entry.order - b.entry.order || a.index - b.index).map(({ entry: { order: _, ...entry } }) => entry);
  return { schema: 'iot-lab.board-history.v1', board, entries, problems };
}

export function historyText(history: BoardHistory): string {
  const lines = history.entries.map(entry => [entry.at ?? `(${entry.placed_by})`, entry.source, entry.id, entry.type, entry.summary, entry.by ? `by ${entry.by}` : '', entry.cause ?? ''].filter(Boolean).join(' '));
  return [...lines, ...history.problems.map(problem => `PROBLEM: ${problem}`)].join('\n') || `${history.board} has no history`;
}
