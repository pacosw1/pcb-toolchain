// The read side of a supervised run: state, events and explanation from its durable folder. State and receipts stay as
// jsonLoads gave them, so a number keeps its int or float type.
import { closeSync, fstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomicJson } from './json-file.ts';
import { lockHeld } from './file-lock.ts';
import { verifySettled } from './pcb-evidence.ts';
import { sha } from './pcb-workflow.ts';
import { fixed, Float, get, item, jsonDumps, jsonLoads, number, PyError, pyStr, sorted, strip, truthy } from './py-compat.mjs';
import { round } from './py-numbers.ts';
import { caught, isDirectory, isFile, joinPath, jsonOf, pathExists } from './py-path.ts';

export const TERMINAL = new Set(['passed', 'failed', 'error', 'cancelled', 'timeout']);
// JavaScript's $ also matches before a final newline; require the actual end, like Python fullmatch.
/** The run folder of ROOT: GIVEN, then PCB_RUNS_DIR, then .gate/cli. */
export function runsBase(root: string, given?: string): string {
  const base = resolve(given ?? process.env.PCB_RUNS_DIR ?? resolve(root, '.gate/cli'));
  try { return realpathSync(base); } catch { return base; }
}

export const RUN_ID = /^run-[A-Za-z0-9_-]+$(?![\s\S])/;
export const EVENT_LIMIT = 100;
const STARTUP_BUDGET_S = 10;
const INVENTORIES = ['engineering_inputs', 'engineering_absent_inputs', 'evidence_sha256', 'artifacts'];
const GATE_FOLDERS = ['gate', 'candidate/gate', 'release-work/gate'];
const DRC_GROUPS = ['violations', 'schematic_parity', 'unconnected_items'];

export type Dict = Map<string, unknown>;

const wallClock = (): number => Date.now() / 1000;
const float = (value: number): Float => new Float(value);

/** datetime.now(timezone.utc).isoformat(timespec='milliseconds'). */
export const utc = (at = new Date()): string => at.toISOString().replace('Z', '+00:00');

/** The value of a repeatable-looking backend flag; it may be given once at most. */
export function backendOption(argv: string[], name: string): string | null {
  const values: string[] = [];
  argv.forEach((arg, index) => {
    if (arg === name) {
      if (index + 1 >= argv.length) throw new PyError('ValueError', `${name} requires a value`);
      values.push(argv[index + 1]!);
    } else if (arg.startsWith(`${name}=`)) {
      values.push(arg.slice(name.length + 1));
    }
  });
  if (values.length > 1) throw new PyError('ValueError', `duplicate backend option: ${name}`);
  return values[0] ?? null;
}

export function runDir(base: string, runId: string): string {
  if (!RUN_ID.test(runId)) throw new PyError('ValueError', 'invalid run ID; use the ID returned by check');
  const path = joinPath(base, runId);
  if (!isFile(joinPath(path, 'run.json'))) throw new PyError('ValueError', `unknown run: ${runId}`);
  return path;
}

/** The sealed receipt holds the inventories, so a streamed event keeps only their sizes. */
export function compactTerminal(result: Dict, folder: string): Dict {
  const view: Dict = new Map(result);
  const counts = new Map<string, bigint>();
  for (const name of INVENTORIES) {
    const inventory = view.get(name) as Dict | unknown[] | undefined;
    if (!view.has(name)) continue;
    counts.set(name, BigInt(inventory instanceof Map ? inventory.size : (inventory as unknown[]).length));
    view.delete(name);
  }
  if (counts.size) view.set('inventory_counts', counts);
  const receipt = joinPath(folder, 'result.json');
  if (isFile(receipt)) view.set('receipt', new Map([['path', receipt], ['sha256', sha(receipt)]]));
  return view;
}

/** null: no lock yet. The lock is the liveness of the supervisor, never its PID. */
export function controllerAlive(folder: string): boolean | null {
  const lock = joinPath(folder, 'worker.lock');
  return pathExists(lock) ? lockHeld(lock) : null;
}

const seconds = (value: unknown): number | null => {
  if (!(value instanceof Float) && typeof value !== 'bigint') return null;
  const parsed = number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const ageSince = (now: number, moment: unknown): Float | null => {
  const start = seconds(moment);
  return start !== null && now >= start ? float(round(now - start, 3)) : null;
};

export function liveStages(stages: unknown, now = wallClock()): Dict[] {
  return (stages as Dict[]).map(stage => {
    const row: Dict = new Map(stage);
    row.set('elapsed_s', ageSince(now, row.get('started_unix_s')));
    row.set('last_activity_age_s', ageSince(now, row.get('last_activity_unix_s')));
    return row;
  });
}

function markStopped(state: Dict, cause: string): void {
  state.set('status', 'error');
  state.set('exit_code', 2n);
  state.set('cause', cause);
  state.set('cleanup', null);
}

/** result.json is written before the terminal state.json. After a crash between the two, a receipt whose seal verifies says how the run ended. */
function adoptReceipt(state: Dict, folder: string): void {
  let receipt: Dict;
  try { receipt = verifySettled(folder) as Dict; } catch { return; }   // a receipt that does not verify cannot end a run: the checks below fail closed
  if (!TERMINAL.has(receipt.get('status') as string)) return;
  for (const [key, value] of receipt) state.set(key, value);
}

function addLiveTiming(state: Dict, age: number, now: number): void {
  const previous = get(state, 'elapsed_s', 0n);
  // Python keeps an integer when max(0, negative_age) returns integer zero.
  const elapsed = typeof previous === 'bigint' && state.get('heartbeat_age_s') === 0n
    ? previous : float(round(number(previous) + age, 3));
  state.set('elapsed_s', elapsed);
  state.set('elapsed_clock', 'supervisor_monotonic_plus_wall_since_update');
  const active = liveStages(get(state, 'active_stage_timing', []), now);
  state.set('active_stage_timing', active);
  const timing = state.get('timing');
  if (truthy(timing)) (timing as Dict).set('active_stages', active);
}

export function status(folder: string, now = wallClock()): Dict {
  const statePath = joinPath(folder, 'state.json');
  let state = jsonOf(statePath) as Dict;
  const alive = controllerAlive(folder);
  // The supervisor may have published its terminal state and released the lock between the first read and the probe.
  if (alive === false) state = jsonOf(statePath) as Dict;
  state.set('controller_alive', alive);
  state.set('evidence_dir', folder);
  const updated = number(item(state, 'updated_unix'));
  const sinceUpdate = round(now - updated, 3);
  const age = Math.max(0, sinceUpdate);
  state.set('heartbeat_age_s', sinceUpdate > 0 ? float(sinceUpdate) : 0n);   // max(0, x) keeps the int 0
  const current = () => item(state, 'status') as string;
  if (!TERMINAL.has(current())) adoptReceipt(state, folder);
  if (current() === 'starting' && alive !== true) {
    // Creating the lock and acquiring it are separate calls: the startup budget covers an absent and a new lock.
    if (now - updated > STARTUP_BUDGET_S) markStopped(state, 'supervisor did not start; inspect worker.log');
  } else if (!TERMINAL.has(current()) && alive === false) {
    markStopped(state, 'supervisor stopped without a terminal result; cleanup unconfirmed');
  } else if (!TERMINAL.has(current()) && alive === null) {
    // The supervisor creates its lock before the worker writes any state past starting; a missing lock is no proof of life.
    markStopped(state, 'supervisor lock is missing; cleanup unconfirmed');
  }
  if (!TERMINAL.has(current())) addLiveTiming(state, age, now);
  return state;
}

/** Shared CLI and viewer control: cancellation itself belongs to the supervisor. */
export function requestCancel(folder: string): Dict {
  const state = status(folder);
  if (TERMINAL.has(item(state, 'status') as string)) return state;
  atomicJson(joinPath(folder, 'cancel.request'), { requested_at: utc() });
  state.set('cancellation_requested', true);
  return state;
}

/** Byte cursors permit reconnecting without rescanning old events. An unfinished last line stays unread. */
export function events(folder: string, cursor = 0, limit = EVENT_LIMIT): Dict[] {
  const path = joinPath(folder, 'events.jsonl');
  let file: number;
  try {
    file = openSync(path, 'r');
  } catch (error) {
    if (!caught(error, 'OSError') || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (cursor) throw new PyError('ValueError', 'event cursor is outside this run');
    return [];
  }
  try {
    const size = fstatSync(file).size;
    if (cursor < 0 || cursor > size) throw new PyError('ValueError', 'event cursor is outside this run');
    if (cursor) {
      const previous = Buffer.allocUnsafe(1);
      if (readSync(file, previous, 0, 1, cursor - 1) !== 1 || previous[0] !== 0x0a)
        throw new PyError('ValueError', 'event cursor must be a returned line boundary');
    }
    const rows: Dict[] = [];
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = cursor;
    let fragments: Buffer[] = [];
    while (offset < size && rows.length < limit) {
      const count = readSync(file, chunk, 0, Math.min(chunk.length, size - offset), offset);
      if (!count) break;
      let at = 0;
      for (;;) {
        const end = chunk.indexOf(0x0a, at);
        if (end < 0 || end >= count) break;
        const line = Buffer.concat([...fragments, chunk.subarray(at, end + 1)]);
        fragments = [];
        const row = jsonLoads(line) as Dict;
        row.set('cursor', BigInt(offset + end + 1));
        rows.push(row);
        at = end + 1;
        if (rows.length >= limit) break;
      }
      if (rows.length < limit && at < count) fragments.push(Buffer.from(chunk.subarray(at, count)));
      offset += count;
    }
    return rows;
  } finally {
    closeSync(file);
  }
}

const orUnavailable = (value: unknown, suffix: string): string => (value === null ? 'unavailable' : pyStr(value) + suffix);

export const stageStatus = (rows: Dict[]): string => rows.map(row => `${pyStr(item(row, 'stage'))} elapsed=${orUnavailable(item(row, 'elapsed_s'), 's')}`
  + ` last-activity=${orUnavailable(item(row, 'last_activity_age_s'), 's ago')}`).join(', ');

function eventDetail(event: Dict, kind: unknown): string {
  if (kind === 'tool.output') return strip(item(event, 'text') as string).replaceAll('\n', ' | ');
  if (kind === 'check.end') return `${pyStr(item(event, 'status'))} ${jsonDumps(item(event, 'metrics'))}`;
  if (kind === 'run.heartbeat') {
    const stages = get(event, 'active_stage_timing', []) as Dict[];
    const detail = `alive; progress unknown; active=${stageStatus(stages)}`;
    return stages.length ? detail : detail + (item(event, 'active_stages') as string[]).join(',');
  }
  if (kind === 'run.end' || kind === 'run.stopping') return `${pyStr(get(event, 'status', ''))}: ${pyStr(item(event, 'cause'))}`;
  return kind === 'tool.exit' ? `exit=${pyStr(item(event, 'code'))}` : '';
}

/** One line of `tools/pcb events`: JSON Lines for a machine, a short sentence for a person. */
export function eventLine(event: Dict, machine: boolean): string {
  if (machine) return jsonDumps(event);
  const kind = item(event, 'type');
  const elapsed = fixed(number(item(event, 'elapsed_s')), 1).padStart(7);
  return `${pyStr(item(event, 'run_id'))} ${elapsed}s ${pyStr(kind)} ${pyStr(get(event, 'stage', ''))} ${eventDetail(event, kind)}`.trimEnd();
}

export function gateDirectory(folder: string): string {
  const found = GATE_FOLDERS.map(name => joinPath(folder, name)).find(isDirectory);
  return found ?? joinPath(folder, 'gate');
}

const logFiles = (folder: string): string[] => {
  try {
    return (sorted(readdirSync(folder).filter(name => name.endsWith('.log'))) as string[]).map(name => joinPath(folder, name));
  } catch {
    return [];
  }
};

function findingGroups(name: string, report: unknown): [string, unknown[]][] {
  if (name === 'erc') return (get(report, 'sheets', []) as unknown[]).map(sheet => ['erc', get(sheet, 'violations', []) as unknown[]]);
  return DRC_GROUPS.map(key => [key, get(report, key, []) as unknown[]]);
}

function collectFindings(gate: string, limit: number): { details: object[]; total: number } {
  const details: object[] = [];
  let total = 0;
  for (const name of ['erc', 'drc']) {
    const path = joinPath(gate, `${name}.json`);
    if (!pathExists(path)) continue;
    try {
      for (const [category, findings] of findingGroups(name, jsonOf(path))) {
        for (const finding of findings) {
          total += 1;
          if (details.length < limit) details.push({ stage: name, category, report: path, finding });
        }
      }
    } catch (error) {
      if (!caught(error, 'ValueError', 'TypeError', 'AttributeError')) throw error;
      details.push({ stage: name, report: path, cause: 'malformed report; inspect original evidence' });
    }
  }
  return { details, total };
}

export function explain(folder: string, limit: number): { run: Dict; details: object[]; findings: unknown; omitted: number; logs: string[] } {
  const run = status(folder);
  const gate = gateDirectory(folder);
  const { details, total } = collectFindings(gate, limit);
  const structured = joinPath(gate, 'findings.json');
  return {
    run, details, findings: pathExists(structured) ? jsonOf(structured) : null, omitted: Math.max(0, total - details.length),
    logs: [...logFiles(gate), ...logFiles(joinPath(folder, 'operation')), joinPath(folder, 'gate.log'), joinPath(folder, 'worker.log')],
  };
}
