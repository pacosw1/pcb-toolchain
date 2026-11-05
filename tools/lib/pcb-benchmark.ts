// Measure complete run outcomes; never substitute proxy route scores for gates. tools/pcb_benchmark.py is the twin
// until pcb_cli.py goes. Receipt values stay as jsonLoads gave them, so 12.0 prints as 12.0 in the summary.
import { basename } from 'node:path';
import { verify } from './pcb-evidence.ts';
import { Float, get, item, jsonLoads, number, splitlines, truthy } from './py-compat.mjs';
import { caught, joinPath, jsonOf, pathExists, textOf } from './py-path.ts';
import { fromEvents, timingJson, type TimingEvent } from './timing.ts';

const GATE_SCOPES = new Set(['configured_board_gate', 'candidate_board_gate']);
const COMPARABLE = 'matching recorded source and compliance scope';
const NOT_COMPARABLE = 'comparison requires at least two runs with matching source fingerprints, board and scope';
const QUALIFICATION = 'observed_run_metrics; no whole-board speed or bench qualification inferred';

interface BenchmarkRow { board: unknown; scope: unknown; input_sha256: unknown }

/** Plain numbers and objects, the shape lib/timing.ts reads. */
function plain(value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries([...value].map(([key, entry]) => [key, plain(entry)]));
  if (Array.isArray(value)) return value.map(plain);
  return value instanceof Float || typeof value === 'bigint' ? number(value) : value;
}

function jsonLines(path: string): TimingEvent[] {
  if (!pathExists(path)) return [];
  return splitlines(textOf(path)).filter(Boolean).map(line => plain(jsonLoads(line)) as TimingEvent);
}

const count = (rows: TimingEvent[], test: (row: TimingEvent) => boolean): number => rows.filter(test).length;

function evidenceVerified(folder: string): boolean {
  try {
    verify(folder);
    return true;
  } catch (error) {
    if (caught(error, 'OSError', 'ValueError')) return false;
    throw error;
  }
}

/** Python's == 0: 0, 0.0 and False all match. */
const isZero = (value: unknown): boolean =>
  (typeof value === 'bigint' || typeof value === 'boolean' || value instanceof Float) && number(value) === 0;

function gateValid(folder: string, result: unknown): boolean {
  const path = joinPath(folder, 'gate/result.json');
  if (!pathExists(path)) return false;
  const receipt = jsonOf(path);
  return isZero(get(receipt, 'exit')) && get(receipt, 'changedDuringRun') === false
    && get(get(receipt, 'provenance', new Map()), 'input_sha256') === get(result, 'input_sha256');
}

function summarizeRun(folder: string): BenchmarkRow & Record<string, unknown> {
  const manifest = jsonOf(joinPath(folder, 'run.json'));
  const result = jsonOf(joinPath(folder, 'result.json'));
  const events = jsonLines(joinPath(folder, 'events.jsonl'));
  const notes = jsonLines(joinPath(folder, 'notes.jsonl'));
  const completed = get(result, 'status') === 'passed' && get(get(result, 'cleanup', new Map()), 'complete') === true;
  const verified = evidenceVerified(folder);
  const gateScope = GATE_SCOPES.has(get(result, 'scope') as string);
  const valid = gateValid(folder, result);
  const elapsed = get(result, 'elapsed_s');
  const source = get(result, 'source_sha256');
  const timing = get(result, 'timing');
  const check = (status: string[]) => (row: TimingEvent) => row.type === 'check.end' && status.includes(row.status as string);
  return {
    run_id: basename(folder), board: item(manifest, 'board'), operation: get(manifest, 'operation', 'check'), scope: get(result, 'scope'),
    status: item(result, 'status'), input_sha256: truthy(source) ? source : get(result, 'input_sha256'), elapsed_s: elapsed,
    child_cpu_s: get(result, 'child_cpu_s'), timing: truthy(timing) ? timing : timingJson(fromEvents(events, get(manifest, 'created_at'), true)),
    cpu_scope: get(result, 'cpu_scope'), evidence_verified: verified,
    time_to_configured_targets_s: completed && gateScope && valid && verified ? elapsed : null,
    cache_hits: count(events, row => row.type === 'cache.hit'), completed_checks: count(events, check(['passed', 'failed'])),
    blocked_checks: count(events, check(['blocked'])), error_checks: count(events, check(['error'])),
    recorded_interventions: count(notes, row => row.kind === 'intervention'), recorded_rework: count(notes, row => row.kind === 'rework'),
    intervention_coverage: 'explicit_notes_only', evidence: folder,
  };
}

export function summarize(folders: string[]): object {
  const runs = folders.map(summarizeRun);
  const first = runs[0];
  const comparable = runs.length > 1 && runs.every(run => truthy(run.input_sha256) && run.input_sha256 === first!.input_sha256
    && run.scope === first!.scope && run.board === first!.board);
  return { schema_version: 1, runs, comparable, comparison_reason: comparable ? COMPARABLE : NOT_COMPARABLE, qualification: QUALIFICATION };
}
