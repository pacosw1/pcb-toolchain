// Internal check worker. The enclosing iotroute broker owns worker.lock and
// finalizes only after this worker and every owned child have settled.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson, plainJson, readObject } from './lib/json-file.ts';
import { now } from './lib/lean-clock.ts';
import { encodeDeadline } from './lib/lean-workflow.ts';
import { startOwned, OwnedStageError, type Cleanup, type OwnedResult, type OwnedStage } from './lib/owned-stage.ts';
import { events } from './lib/pcb-runs.ts';
import { gateOutcome, type Finding } from './lib/pcb-gate-outcome.ts';
import { CheckJournal, type Row } from './lib/pcb-check-journal.ts';
import { sha } from './lib/pcb-workflow.ts';
import { MeasuredSpan } from './lib/timing.ts';

interface Manifest extends Row { root: string; board: string; command: string[]; timeout_s: number; heartbeat_s: number; created_at: string; operation: string; gate_config_sha256: string }
type Preliminary = Row & { status: string; exit_code: number; cause: string };
const nothing = (): Cleanup => ({ complete: true, errors: [], child_reaped: true, leader_spawned: false });

async function worker(folderPath: string): Promise<number> {
  const folder = resolve(folderPath), manifest = readObject<Manifest>(join(folder, 'run.json'));
  if (!['check', 'doctor', 'readiness', 'blocks'].includes(manifest.operation) || !Array.isArray(manifest.command) || manifest.command.length === 0
      || !Number.isFinite(manifest.timeout_s) || manifest.timeout_s <= 0 || !Number.isFinite(manifest.heartbeat_s) || manifest.heartbeat_s <= 0)
    throw new Error('invalid check manifest');
  if (process.env.IOT_PCB_WORKER_LOCK !== join(folder, 'worker.lock') || !process.env.IOT_LEAN_STAGE_HANDLE)
    throw new Error('check worker requires its admitted owned supervisor');
  const started = now(), deadline = started + manifest.timeout_s;
  const journal = new CheckJournal(folder, manifest.created_at, started);
  Object.assign(journal.state, { status: 'running', worker_pid: process.pid, worker_started_clock_s: started });
  journal.emit('run.start', { board: manifest.board, command: manifest.command });
  let cursor = 0, gateEnded = false, interrupted = false, proc: OwnedStage | undefined;
  let outcome: OwnedResult | undefined, cleanup: Cleanup | undefined, result: Preliminary | undefined;
  let cleanupSpan: Row | undefined;
  const findings: Finding[] = [];
  const onSignal = () => { interrupted = true; };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  const drain = () => {
    for (;;) {
      const rows = events(join(folder, 'gate'), cursor, 1000);
      for (const entry of rows) {
        cursor = Number(entry.get('cursor'));
        const row = plainJson(entry) as Row;
        const type = row.type;
        if (row.schema_version !== 1 || typeof type !== 'string') throw new Error('invalid producer event');
        delete row.cursor; delete row.schema_version; delete row.type;
        row.source_time = row.time ?? null; delete row.time;
        if (type === 'gate.end') gateEnded = true;
        if (type === 'check.end' && Array.isArray(row.findings)) {
          for (const text of row.findings) findings.push({ stage: String(row.stage), cause: String(text), log: join(folder, 'gate', `${String(row.stage)}.log`) });
        }
        journal.emit(type, row);
      }
      if (rows.length < 1000) break;
    }
  };
  let log = -1;
  try {
    if (existsSync(join(folder, 'cancel.request'))) {
      result = { status: 'cancelled', exit_code: 130, cause: 'cancelled before gate admission' };
      cleanup = nothing();
    } else {
      if (manifest.operation === 'check' && sha(join(manifest.root, 'hardware-design/boards', manifest.board, 'gate.json')) !== manifest.gate_config_sha256)
        throw new Error('configured gate changed after check admission');
      if (manifest.operation !== 'check') mkdirSync(join(folder, 'operation'), { recursive: true });
      log = openSync(join(folder, manifest.operation !== 'check' ? `operation/${manifest.operation}.log` : 'gate.log'), 'w');
      const env = { ...process.env, IOT_LEAN_DEADLINE: encodeDeadline(deadline) };
      proc = startOwned(manifest.command, { cwd: manifest.root, env, stdin: 'ignore', stdout: log, stderr: log });
      let heartbeat = now();
      for (;;) {
        if (manifest.operation === 'check') drain();
        if (interrupted || existsSync(join(folder, 'cancel.request')) || now() >= deadline) {
          const cancelled = interrupted || existsSync(join(folder, 'cancel.request'));
          result = { status: cancelled ? 'cancelled' : 'timeout', exit_code: cancelled ? 130 : 124,
            cause: cancelled ? 'cancellation requested' : 'run deadline reached' };
          journal.state.status = 'stopping';
          journal.emit('run.stopping', { cause: result.cause });
          cleanup = await proc.cancel();
          try { outcome = await proc.settled; } catch { /* cleanup from cancel is authoritative */ }
          if (manifest.operation === 'check') drain();
          break;
        }
        if (proc.done) {
          outcome = await proc.settled;
          cleanup = outcome.cleanup;
          if (manifest.operation === 'check') {
            drain(); result = { ...gateOutcome(folder, outcome.returncode, gateEnded, findings) };
          } else {
            const code = outcome.returncode;
            result = { status: code === 0 ? 'passed' : code === 2 ? 'error' : 'failed', exit_code: code === 0 ? 0 : code === 2 ? 2 : 1,
              cause: manifest.operation + (code === 0 ? ' completed' : ' failed; inspect original tool evidence'), scope: manifest.operation === 'doctor' ? 'environment' : manifest.operation === 'blocks' ? 'block_evidence' : 'assembly_readiness', operation: manifest.operation, tool_exit: code, artifact_directory: null };
            atomicJson(join(folder, 'operation/result.json'), result);
          }
          break;
        }
        if (now() - heartbeat >= manifest.heartbeat_s) {
          journal.emit('run.heartbeat', { active_stages: [...new Set([...journal.timeline.active.values()].map(span => span.stage))].sort(),
            progress: 'unknown', active_stage_timing: journal.timeline.summary().active_stages,
            last_activity_s: journal.state.last_activity_s ?? null, last_progress_s: journal.state.last_progress_s ?? null });
          heartbeat = now();
        }
        await delay(100);
      }
    }
  } catch (error) {
    if (error instanceof OwnedStageError) cleanup = error.cleanup;
    result = { status: 'error', exit_code: 2, cause: error instanceof Error ? `${error.name}: ${error.message}` : String(error), findings };
  } finally {
    const span = new MeasuredSpan('cleanup', 'cleanup');
    cleanupSpan = { ...span.fields, started_clock_s: now() };
    journal.emit('stage.start', { ...span.fields });
    if (proc && !proc.done) {
      try { cleanup = await proc.cancel(); } catch (error) { cleanup = { complete: false, child_reaped: false, errors: [{ operation: 'cancel', error: String(error) }] }; }
    }
    if (log >= 0) closeSync(log);
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  }
  result ??= { status: 'error', exit_code: 2, cause: 'check ended without a result' };
  cleanup ??= proc ? { complete: false, child_reaped: false, errors: [{ operation: 'cleanup', error: 'owned stage did not report cleanup' }] } : nothing();
  if (cleanup.complete !== true) Object.assign(result, { status: 'error', exit_code: 2, cause: result.cause + '; owned process cleanup unconfirmed' });
  atomicJson(join(folder, 'worker-preliminary.json'), { ...result, nested_cleanup: cleanup,
    cleanup_span: cleanupSpan, gate_returncode: outcome?.returncode ?? null,
    child_cpu_s: outcome?.childCpuS ?? null, cpu_scope: outcome?.cpuScope ?? null });
  journal.state.status = 'stopping';
  journal.emit('run.settling', { provisional_status: result.status });
  return result.exit_code;
}

worker(process.argv[2] ?? '').then(code => { process.exitCode = code; }, error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
