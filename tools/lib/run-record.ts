// One run record per routing job (W5, CIP #805): OUTDIR/run.jsonl, one JSON line per action. tools/run_record.py is the
// Python twin while the job scripts write through it; both read and append the same file.
//
// Record: {"t": ISO time, "elapsed_s": seconds since the job start (null when unknown), "stage": job stage,
//          "action": what was done, "inputs": what it used, "evidence": file or line it can be checked against,
//          "result": what came out, "why": the reason in one sentence}
//
// derive() rebuilds the records no live writer owns from the files a job already writes: progress.jsonl, each routing
// stage's run{sfx}.log, optimize{sfx}.log, report{sfx}.json and stall{sfx}.json, stages.jsonl, open-triage.json and
// outcome.json. A routing stage is 'route' plus the suffix of its files ('' for the final stage, '-fast' for tag fast).
// Each stage's router-relative log clock is offset by that stage's own 'route{sfx} start' row (optimize{sfx}.log: its
// 'route{sfx} end' row, where the optimizer starts).
//
// Rows are Maps from jsonLoads, so a read row and a derived row have one shape, and 12.0 stays 12.0 when written back.
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fixed, Float, get, item, jsonDumps, jsonLoads, number, PyError, pyStr, sorted, splitlines, strip, truthy } from './py-compat.mjs';
import { pyFloat, round } from './py-numbers.ts';
import { caught, isDirectory, isFile, jsonOf, textOf } from './py-path.ts';

export const FILE = 'run.jsonl';
export const KEYS = ['t', 'elapsed_s', 'stage', 'action', 'inputs', 'evidence', 'result', 'why'] as const;
const LOGGED_ACTIONS = new Set(['pass', 'checkpoint', 'stop', 'router end', 'skip', 'diagnosis', 'fanout']);
const STAGE_FILE = /^(?:run|optimize|report|stall)(-[^/]+)?\.(?:log|json)$/;
const STAGE_FILE_KINDS = [['run', 'log'], ['optimize', 'log'], ['report', 'json'], ['stall', 'json']] as const;
const OPEN_WHY: Record<string, string> = {
  blocked: 'no path exists on the loaded board (pins, keepouts or fixed wiring)',
  congestion: 'routable alone; other copper took the space',
  ignored: 'its net class is ignored',
};
const TRIAGE_WHY: Record<string, string> = { ENCLOSED: 'no legal path on the clearance grid', ROUTER_MISS: 'a path exists; the router missed it' };

export type Row = Map<string, unknown>;
export interface RecordFields { inputs?: unknown; evidence?: unknown; result?: unknown; why?: string; elapsed_s?: unknown; t?: unknown }
export interface RouteStage {
  stage: string; sfx: string; files: Record<string, string>;
  attempt: number | null; start_s: unknown; end_s: unknown;
}

const clocks = new Map<string, number>();   // absolute OUTDIR -> t0, set by start()
const dict = (fields: object): Row => new Map(Object.entries(fields));
const seconds = (value: number): Float => new Float(round(value, 1));
const wallClock = (): number => Date.now() / 1000;
const pad = (value: number): string => String(value).padStart(2, '0');

function localSeconds(now = new Date()): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `${date}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

const float = (value: unknown): number => (typeof value === 'string' ? pyFloat(value) : number(value));

const logNumber = (text: string): Float => new Float(float(text));
const whole = (text: string): bigint => BigInt(text);
const plainDict = (value: unknown): unknown =>
  value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype ? dict(value) : value;

export const recordPath = (outdir: string): string => (outdir.endsWith('.jsonl') ? outdir : join(outdir, FILE));

function progressStart(outdir: string): number | null {
  try {
    const first = textOf(join(outdir, 'progress.jsonl')).split('\n', 1)[0]!;
    return float(item(jsonLoads(first), 't0'));
  } catch (error) {
    if (caught(error, 'OSError', 'ValueError', 'KeyError', 'TypeError')) return null;
    throw error;
  }
}

/** Bind the job clock of OUTDIR (default: the t0 of progress.jsonl, else now) for the live writers. */
export function start(outdir: string, t0?: number): number {
  const value = t0 ?? (progressStart(outdir) || wallClock());
  clocks.set(resolve(outdir), value);
  return value;
}

/** The job's t0: the start() binding, else progress.jsonl, else now. */
export const clock = (outdir: string): number => clocks.get(resolve(outdir)) || progressStart(outdir) || wallClock();

export function elapsed(outdir: string): Float | null {
  const t0 = clocks.get(resolve(outdir)) || progressStart(outdir);
  return t0 ? seconds(wallClock() - t0) : null;
}

/** One record in key order; every key present. */
export function record(stage: unknown, action: unknown, fields: RecordFields = {}): Row {
  return new Map<string, unknown>([
    ['t', fields.t || localSeconds()], ['elapsed_s', fields.elapsed_s ?? null], ['stage', stage], ['action', action],
    ['inputs', plainDict(fields.inputs ?? null)], ['evidence', fields.evidence ?? null], ['result', plainDict(fields.result ?? null)],
    ['why', fields.why ?? ''],
  ]);
}

const writeRow = (outdir: string, row: Row): void => appendFileSync(recordPath(outdir), `${jsonDumps(row)}\n`);

/** Append one record to OUTDIR/run.jsonl (elapsed_s from the job clock when not given); returns the record. */
export function append(outdir: string, stage: unknown, action: unknown, fields: RecordFields = {}): Row {
  const measured = fields.elapsed_s === undefined && !fields.t ? elapsed(outdir) : fields.elapsed_s;
  const row = record(stage, action, { ...fields, elapsed_s: measured });
  writeRow(outdir, row);
  return row;
}

const looseText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');   // errors='replace': a job may be writing this file
  } catch {
    return null;
  }
};

/** The rows of a JSONL file; [] when absent. An unparsable last line is an append in progress and is skipped; one before the last is corruption. */
export function readJsonl(path: string): Row[] {
  const lines = (looseText(path) ?? '').split('\n').filter(line => strip(line));
  const rows: Row[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      rows.push(jsonLoads(line) as Row);
    } catch (error) {
      if (!caught(error, 'ValueError')) throw error;
      if (index === lines.length - 1) break;
      throw new PyError('ValueError', `${path}: line ${index + 1} is not JSON: ${(error as Error).message}`);
    }
  }
  return rows;
}

export const read = (outdir: string): Row[] => readJsonl(recordPath(outdir));

// ------------------------------------------------------------------ the router's log and report

type LogRule = [RegExp, (match: string[], at: (t: string) => Float, line: string) => Row];
const LOG_PREFIX = String.raw`^\s*([\d.]+)\s+\w+\s+`;
const logRule = (pattern: string): RegExp => new RegExp(LOG_PREFIX + pattern);
const LOG_RULES: LogRule[] = [
  [logRule(String.raw`Auto-routing pass #(\d+) was completed in ([\d.]+) seconds with score ([\d.]+) \((\d+) unrouted and (\d+) violations?\)(?: \(routed (\d+), failed (\d+), ripped (\d+)\))?`),
    ([, t, pass, took, score, open, violations, routed, failed, ripped], at, line) => {
      const result: Row = dict({ pass: whole(pass!), open: whole(open!), violations: whole(violations!), seconds: logNumber(took!), score: logNumber(score!) });
      if (routed !== undefined) {
        result.set('routed', whole(routed));
        result.set('failed', whole(failed!));
        result.set('ripups', whole(ripped!));
      }
      return record('route', 'pass', { evidence: strip(line), result, elapsed_s: at(t!), why: `autorouter pass ${pass}: ${open} open, ${violations} violations, ${ripped || 0} rip-ups` });
    }],
  [logRule(String.raw`checkpoint: best board so far \((\d+) unrouted, (\d+) violations?\) written to '([^']+)'`),
    ([, t, open, violations, ses], at) => record('route', 'checkpoint', {
      evidence: ses, result: { open: whole(open!), violations: whole(violations!) }, elapsed_s: at(t!), why: 'lowest open count so far: best board written',
    })],
  [logRule('stop requested: (.*)'),
    ([, t, reason], at, line) => record('route', 'stop', {
      evidence: strip(line), result: { reason: strip(reason!) }, elapsed_s: at(t!), why: 'the job asked the router to stop (stall or deadline)',
    })],
  [logRule(String.raw`Auto-routing stage completed: started with (\d+) unrouted nets, completed in ([\d.]+) seconds, final score: ([\d.]+) \((\d+) unrouted and (\d+) violations?\)`),
    ([, t, started, took, score, open, violations], at, line) => record('route', 'router end', {
      evidence: strip(line), elapsed_s: at(t!), why: `autorouting stage over: ${started} -> ${open} open`,
      result: { open: whole(open!), violations: whole(violations!), seconds: logNumber(took!), score: logNumber(score!), started_open: whole(started!) },
    })],
  [logRule(String.raw`(\d+) item\(s\) cannot be routed even on the board as loaded \(([^)]*)\); they were skipped after their (\w+) failure`),
    ([, t, items, cause, nth], at, line) => record('route', 'skip', {
      evidence: strip(line), result: { items: whole(items!) }, elapsed_s: at(t!), why: `${items} items ${cause}; skipped after their ${nth} failure`,
    })],
  [logRule(String.raw`diagnosis of (\d+) unrouted connections in ([\d.]+) s: (\d+) routable alone \(congestion\), (\d+) not routable on the loaded board \(blocked\), (\d+) in ignored net classes`),
    ([, t, open, took, congestion, blocked, ignored], at, line) => record('route', 'diagnosis', {
      evidence: strip(line), elapsed_s: at(t!), why: `${congestion} open connections are routable alone (congestion), ${blocked} are blocked on the loaded board`,
      result: { open: whole(open!), congestion: whole(congestion!), blocked: whole(blocked!), ignored: whole(ignored!), seconds: logNumber(took!) },
    })],
  [logRule(String.raw`Fanout stage completed: (\d+) passes, completed in ([\d.]+) seconds`),
    ([, t, passes, took], at, line) => record('route', 'fanout', {
      evidence: strip(line), result: { passes: whole(passes!), seconds: logNumber(took!) }, elapsed_s: at(t!), why: 'SMD fanout before autorouting',
    })],
];

/** The record of a router log line that is an action, else null. offset: job elapsed_s at the router start. */
export function parseLogLine(line: string, offset = 0, stage = 'route', inputs?: object): Row | null {
  const at = (t: string) => seconds(offset + float(t));
  for (const [pattern, build] of LOG_RULES) {
    const match = pattern.exec(line);
    if (!match) continue;
    const row = build(match as unknown as string[], at, line);
    row.set('stage', stage);
    if (inputs && Object.keys(inputs).length) row.set('inputs', dict(inputs));
    return row;
  }
  return null;
}

export const parseLog = (text: string, offset = 0, stage = 'route', inputs?: object): Row[] =>
  (splitlines(text) as string[]).map(line => parseLogLine(line, offset, stage, inputs)).filter(row => row !== null);

const orEmpty = (value: unknown): Row => (truthy(value) ? value as Row : new Map());
const listOr = (value: unknown): Row[] => (truthy(value) ? value as Row[] : []);

function endName(end: Row): unknown {
  const kind = get(end, 'kind', '?');
  return get(end, 'kind') === 'pin' ? `${pyStr(get(end, 'component', ''))}.${pyStr(get(end, 'pin', ''))}` : kind;
}

/** One record per failed connection of a router report: its diagnosis class and the text of the connection routed alone. */
export function reasons(report: unknown, elapsedS: unknown = null, stage = 'route', evidence = 'report.json', attempt: number | null = null): Row[] {
  return listOr(get(report, 'unrouted')).map(unrouted => {
    const diagnosis = orEmpty(get(unrouted, 'diagnosis'));
    const alone = orEmpty(get(diagnosis, 'from_alone') || get(diagnosis, 'to_alone'));
    const kind = get(diagnosis, 'class', 'unknown');
    const inputs = dict({
      net: get(unrouted, 'net'), from: endName(orEmpty(get(unrouted, 'from'))), to: endName(orEmpty(get(unrouted, 'to'))), length_mm: get(unrouted, 'length_mm'),
    });
    if (attempt !== null) inputs.set('attempt', BigInt(attempt));
    const why = OPEN_WHY[kind as string] ?? 'the router gave no class; the cause is unknown';
    return record(stage, 'open', {
      inputs, evidence: `${evidence} unrouted[]`, elapsed_s: elapsedS, why: `${pyStr(kind)}: ${why}`,
      result: { class: kind, router_text: get(alone, 'details', ''), passes_failed: listOr(get(diagnosis, 'in_context')).map(row => get(row, 'pass')) },
    });
  });
}

// ------------------------------------------------------------------ derive from the job's files

function loadJson(outdir: string, name: string): unknown {
  try {
    return jsonOf(join(outdir, name));
  } catch (error) {
    if (caught(error, 'OSError', 'ValueError')) return null;
    throw error;
  }
}

const rows = (outdir: string, name: string): Row[] => readJsonl(join(outdir, name));
const logText = (outdir: string, name: string): string => looseText(join(outdir, name)) ?? '';

const fileNames = (outdir: string): string[] => {
  try {
    return sorted(readdirSync(outdir)) as string[];
  } catch {
    return [];
  }
};

interface StageClock { attempt: number | null; start_s: unknown; end_s: unknown }

function stageClocks(outdir: string, progress: Row[]): Map<string, StageClock> {
  const stages = new Map<string, StageClock>();
  for (const row of progress) {
    const match = /^route(\S*) (start|end)$/.exec((get(row, 'stage') || '') as string);
    if (!match) continue;
    const suffix = match[1]!;
    const stage = stages.get(suffix) ?? { attempt: 0, start_s: null, end_s: null };
    stages.set(suffix, stage);
    if (match[2] === 'start') Object.assign(stage, { attempt: stage.attempt! + 1, start_s: get(row, 'elapsed_s'), end_s: null });
    else stage.end_s = get(row, 'elapsed_s');
  }
  for (const name of fileNames(outdir)) {
    const match = STAGE_FILE.exec(name);
    if (match && !name.startsWith('run.json') && !stages.has(match[1] ?? '')) stages.set(match[1] ?? '', { attempt: null, start_s: null, end_s: null });
  }
  return stages;
}

const offsetOf = (value: unknown): number => (truthy(value) ? number(value) : 0);

/**
 * Every routing stage of the job with its own clock and files, in start order. attempt counts its start rows; start_s
 * and end_s are its last rows, because its files hold the last attempt. A stage with no rows still has its files read.
 */
export function routeStages(outdir: string, progress: Row[]): RouteStage[] {
  const stages = [...stageClocks(outdir, progress)].map(([sfx, clockRow]) => {
    const present = STAGE_FILE_KINDS.filter(([kind, extension]) => isFile(join(outdir, `${kind}${sfx}.${extension}`)));
    const files = Object.fromEntries(present.map(([kind, extension]) => [kind, `${kind}${sfx}.${extension}`]));
    return { stage: `route${sfx}`, sfx, files, ...clockRow };
  });
  const unknownLast = (stage: RouteStage) => Number(stage.start_s === null);
  const bySuffix = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return stages.sort((a, b) => unknownLast(a) - unknownLast(b) || offsetOf(a.start_s) - offsetOf(b.start_s) || bySuffix(a.sfx, b.sfx));
}

function configureRecords(outdir: string): Row[] {
  const configuration = loadJson(outdir, 'effective-configuration.json') || loadJson(outdir, 'input-manifest.json');
  if (!truthy(configuration)) return [];
  const features = orEmpty(get(configuration, 'features'));
  const on = [...features].filter(([, value]) => value instanceof Map && truthy(value.get('on'))).map(([name]) => name);
  return [record('job', 'configure', {
    inputs: get(configuration, 'configuration'), evidence: 'effective-configuration.json', elapsed_s: new Float(0),
    result: { features_on: sorted(on), command: get(configuration, 'command') }, why: 'the inputs and feature flags bound at the job start',
  })];
}

function pick(row: Row, keys: string[]): Row {
  return new Map(keys.map(key => [key, get(row, key)]));
}

function progressRecords(progress: Row[]): Row[] {
  return progress.filter(row => get(row, 'pass') === null).map(row => {
    const stage = get(row, 'stage', '') as string;
    const result = new Map([...pick(row, ['open', 'best_open', 'vias', 'eta_s'])].filter(([, value]) => value !== null));
    return record(stage.split(' ')[0], stage, {
      evidence: 'progress.jsonl', elapsed_s: get(row, 'elapsed_s'), t: get(row, 't'), result: result.size ? result : null, why: 'stage boundary of the job',
    });
  });
}

function livePassRecords(progress: Row[], stage: string, identity: object): Row[] {
  return progress.filter(row => get(row, 'stage') === stage && get(row, 'pass') !== null).map(row => record(stage, 'pass', {
    inputs: { ...identity, log: 'progress.jsonl' }, evidence: 'progress.jsonl', result: pick(row, ['pass', 'open']),
    elapsed_s: get(row, 'elapsed_s'), t: get(row, 't'), why: `autorouter pass ${pyStr(get(row, 'pass'))}: ${pyStr(get(row, 'open'))} open (live watcher)`,
  }));
}

function acknowledgment(acknowledged: unknown): string {
  if (acknowledged === true) return 'broker acknowledged the request';
  return acknowledged === false ? 'broker did not acknowledge the request' : 'broker acknowledgment is unknown';
}

/** An interrupt receipt confirms a request, not an exit. Historical producers wrote 'stopped' for that same request. */
function stallWording(stall: Row): { action: string; format: string; why: string } {
  const passes = `${pyStr(get(stall, 'stall_passes'))} passes without a lower open count`;
  if (!stall.has('interrupt_attempted')) {
    return { action: 'stall stop', format: 'historical_stopped', why: `${passes}: historical stop receipt; independent process-exit confirmation is unavailable` };
  }
  const attempted = stall.get('interrupt_attempted');
  const [action, detail] = attempted === true ? ['stall interrupt attempted', acknowledgment(get(stall, 'interrupt_acknowledged'))]
    : attempted === false ? ['stall interrupt not attempted', 'no owned router handle'] : ['stall interrupt unknown', 'attempt status is unknown'];
  return { action, format: 'interrupt_request', why: `${passes}: ${detail}; this receipt does not confirm process exit` };
}

function stallRecords(outdir: string, stage: RouteStage, identity: object): Row[] {
  const stall = 'stall' in stage.files ? loadJson(outdir, stage.files.stall!) : null;
  if (!truthy(stall) || !((stall as Row).has('interrupt_attempted') || truthy(get(stall, 'stopped')))) return [];
  const { action, format, why } = stallWording(stall as Row);
  const t0 = progressStart(outdir);
  const stopped = get(stall, 'seconds');
  const elapsedS = truthy(stopped) && t0 ? seconds(number(stopped) - t0) : stage.end_s;
  return [record(stage.stage, action, { inputs: { ...identity, receipt_format: format }, evidence: stage.files.stall, result: stall, elapsed_s: elapsedS, why })];
}

function stageRecords(outdir: string, stage: RouteStage, progress: Row[]): Row[] {
  const { stage: name, files } = stage;
  const identity = { attempt: stage.attempt === null ? null : BigInt(stage.attempt) };
  const out: Row[] = [];
  const passes = files.run === undefined ? [] : parseLog(logText(outdir, files.run), offsetOf(stage.start_s), name,
    { ...identity, log: files.run, clock: stage.start_s !== null ? 'stage start' : 'unknown' });
  out.push(...passes);
  if (!passes.some(row => row.get('action') === 'pass')) out.push(...livePassRecords(progress, name, identity));
  if (files.optimize !== undefined) {
    out.push(...parseLog(logText(outdir, files.optimize), offsetOf(stage.end_s), `optimize${stage.sfx}`,
      { ...identity, log: files.optimize, clock: stage.end_s !== null ? 'route end' : 'unknown' }));
  }
  const report = files.report === undefined ? null : loadJson(outdir, files.report);
  if (truthy(report)) out.push(...reasons(report, stage.end_s, name, files.report, stage.attempt));
  out.push(...stallRecords(outdir, stage, identity));
  return out;
}

function ownedStageRecords(outdir: string): Row[] {
  return rows(outdir, 'stages.jsonl').map(row => {
    const status = get(row, 'status');
    const result = new Map(['returncode', 'wall_s', 'cause'].filter(key => row.has(key)).map(key => [key, row.get(key)]));
    return record(get(row, 'stage'), `stage ${pyStr(status)}`, {
      inputs: { command: get(row, 'command') }, evidence: 'stages.jsonl', result,
      why: status === 'complete' ? 'owned subprocess stage of the job' : `stage ${pyStr(status)}: ${pyStr(get(row, 'cause'))}`,
    });
  });
}

function triageRecords(outdir: string, progress: Row[]): Row[] {
  const triage = loadJson(outdir, 'open-triage.json');
  if (!truthy(triage)) return [];
  const end = progress.find(row => get(row, 'stage') === 'triage end');
  const elapsedS = end ? get(end, 'elapsed_s') : null;
  const connections = listOr(get(triage, 'connections')).map(connection => {
    const kind = get(connection, 'class');
    const why = TRIAGE_WHY[kind as string] ?? `${truthy(kind) ? pyStr(kind) : 'no class'}: the cause is unknown; the triage did not establish whether a legal path exists`;
    return record('triage', 'open', {
      inputs: { net: get(connection, 'net'), from: get(connection, 'a'), to: get(connection, 'b') }, evidence: 'open-triage.json',
      result: { class: kind, blockers: get(connection, 'blockers') }, elapsed_s: elapsedS, why,
    });
  });
  return [record('triage', 'triage', {
    evidence: 'open-triage.json', elapsed_s: elapsedS, result: pick(triage as Row, ['open', 'enclosed', 'router_miss', 'unknown']),
    why: 'each open signal connection classed as ENCLOSED (no legal path), ROUTER_MISS (a path exists) or UNKNOWN (the cause is unknown)',
  }), ...connections];
}

function outcomeRecords(outdir: string, progress: Row[]): Row[] {
  const outcome = loadJson(outdir, 'outcome.json');
  if (!truthy(outcome)) return [];
  const status = get(outcome, 'status');
  const note = get(outcome, 'note');
  return [record('job', `exit ${pyStr(status).toUpperCase()}`, {
    evidence: 'outcome.json', elapsed_s: progress.length ? get(progress.at(-1), 'elapsed_s') : null,
    result: pick(outcome as Row, ['signal_open', 'ground_open', 'errors', 'returncode', 'qualified']), why: truthy(note) ? note as string : `job ${pyStr(status)}`,
  })];
}

/** All records that the job's files imply, in job order. No file is changed. */
export function derive(outdir: string): Row[] {
  const progress = rows(outdir, 'progress.jsonl');
  return [
    ...configureRecords(outdir), ...progressRecords(progress),
    ...routeStages(outdir, progress).flatMap(stage => stageRecords(outdir, stage, progress)),
    ...ownedStageRecords(outdir), ...triageRecords(outdir, progress), ...outcomeRecords(outdir, progress),
  ];
}

/** Python tuple equality: 1 and 1.0 are the same key. */
const keyPart = (value: unknown): unknown => (value instanceof Float || typeof value === 'bigint' ? number(value) : value ?? null);

function rowKey(row: Row): string {
  const field = (name: string): Row => (row.get(name) instanceof Map ? row.get(name) as Row : new Map());
  const result = field('result');
  const inputs = field('inputs');
  const action = row.get('action');
  const parts = [row.get('stage'), action, result.get('pass'), inputs.get('net'), inputs.get('from'), inputs.get('to'),
    LOGGED_ACTIONS.has(action as string) ? row.get('evidence') : null];
  return JSON.stringify(parts.map(keyPart));
}

/** Append to run.jsonl every derived record that is not there yet; returns the number appended. */
export function sync(outdir: string): number {
  const have = new Set(read(outdir).map(rowKey));
  let added = 0;
  for (const row of derive(outdir)) {
    const key = rowKey(row);
    if (have.has(key)) continue;
    have.add(key);
    writeRow(outdir, row);
    added += 1;
  }
  return added;
}

/** run.jsonl plus the derived records not in it yet, nothing written (the live web view reads this). */
export function view(outdir: string): Row[] {
  const current = read(outdir);
  const have = new Set(current.map(rowKey));
  return [...current, ...derive(outdir).filter(row => !have.has(rowKey(row)))];
}

const isNumeric = (value: unknown): boolean =>
  typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean' || value instanceof Float;

/** Records in job order: by elapsed_s where known, file order otherwise (stable). */
export function ordered(records: Row[]): Row[] {
  let last = 0;
  const keyed = records.map((row, index) => {
    const value = get(row, 'elapsed_s');
    if (value !== null) last = number(value);
    return { row, index, at: last };
  });
  return keyed.sort((a, b) => a.at - b.at || a.index - b.index).map(entry => entry.row);
}

function resultText(result: unknown): string {
  if (result instanceof Map) {
    const shown = [...result].filter(([key, value]) => !(value instanceof Map) && !Array.isArray(value) && key !== 'command');
    return shown.map(([key, value]) => `${key}=${pyStr(value)}`).join(' ');
  }
  return result === null ? '' : pyStr(result);
}

export function format(row: Row): string {
  const value = get(row, 'elapsed_s');
  const at = isNumeric(value) ? `${fixed(number(value), 1).padStart(7)}s` : '      -s';
  const inputs = get(row, 'inputs');
  const net = inputs instanceof Map ? get(inputs, 'net', '') : '';
  const head = `${at} ${pyStr(get(row, 'stage', ''))}: ${pyStr(get(row, 'action', ''))}${truthy(net) ? ` ${pyStr(net)}` : ''}`;
  const result = resultText(get(row, 'result'));
  const why = pyStr(get(row, 'why', ''));
  return result ? `${head}  [${result}]  -- ${why}` : `${head}  -- ${why}`;
}

export function logLines(outdir: string, doSync = true): string[] {
  if (doSync && isDirectory(outdir)) sync(outdir);
  return ordered(read(outdir)).map(format);
}
