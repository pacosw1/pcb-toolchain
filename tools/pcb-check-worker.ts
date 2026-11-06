// Internal check worker. The enclosing iotroute broker owns worker.lock and
// finalizes only after this worker and every owned child have settled.
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson, readObject, readPyJson } from './lib/json-file.ts';
import { verifyBinding, type Binding } from './lib/block-bindings.ts';
import { fingerprint } from './lib/fingerprint.ts';
import { now } from './lib/lean-clock.ts';
import { encodeDeadline } from './lib/lean-workflow.ts';
import { startOwned, OwnedStageError, type Cleanup, type OwnedResult, type OwnedStage } from './lib/owned-stage.ts';
import { OPERATIONS } from './lib/pcb-candidate-admission.ts';
import { ProducerEvents } from './lib/pcb-operation-log.ts';
import { TERMINAL } from './lib/pcb-runs.ts';
import { gateOutcome, type Finding } from './lib/pcb-gate-outcome.ts';
import { CheckJournal, type Row } from './lib/pcb-check-journal.ts';
import { sha } from './lib/pcb-workflow.ts';
import { MeasuredSpan } from './lib/timing.ts';
import { observationEvidence, OBSERVATIONS, producer, requestedInputs, type Requested } from './lib/pcb-outcomes-binding.ts';

interface Manifest extends Row { root: string; board: string; command: string[]; timeout_s: number; heartbeat_s: number; created_at: string; operation: string; gate_config_sha256: string }
type Preliminary = Row & { status: string; exit_code: number; cause: string };
// route-dispatch's bound on a job daemon queue wait; PCB_QUEUE_WAIT_S tunes both.
const QUEUE_WAIT_S = 300;
const QUEUE_CLOCK = 'operation/queue-wait.json';
const nothing = (): Cleanup => ({ complete: true, errors: [], child_reaped: true, leader_spawned: false });

/** Seconds route-dispatch reports in the job daemon's queue, at most `bound`: not the run's own time. */
function queuedS(folder: string, bound: number): number {
  try {
    return Math.min(Math.max(Number(readObject<Row>(join(folder, QUEUE_CLOCK)).seconds) || 0, 0), bound);
  } catch {
    return 0;
  }
}

async function worker(folderPath: string): Promise<number> {
  const folder = resolve(folderPath), manifest = readObject<Manifest>(join(folder, 'run.json'));
  if ((!['check', 'doctor', 'readiness', 'blocks'].includes(manifest.operation) && !OBSERVATIONS.has(manifest.operation) && !OPERATIONS.has(manifest.operation)) || !Array.isArray(manifest.command) || manifest.command.length === 0
      || !Number.isFinite(manifest.timeout_s) || manifest.timeout_s <= 0 || !Number.isFinite(manifest.heartbeat_s) || manifest.heartbeat_s <= 0)
    throw new Error('invalid check manifest');
  if (process.env.IOT_PCB_WORKER_LOCK !== join(folder, 'worker.lock') || !process.env.IOT_LEAN_STAGE_HANDLE)
    throw new Error('check worker requires its admitted owned supervisor');
  const started = now(), deadline = started + manifest.timeout_s;
  let queueBound = 0;
  const journal = new CheckJournal(folder, manifest.created_at, started);
  Object.assign(journal.state, { status: 'running', worker_pid: process.pid, worker_started_clock_s: started });
  journal.emit('run.start', { board: manifest.board, command: manifest.command });
  let gateEnded = false, interrupted = false, proc: OwnedStage | undefined;
  const producers = new ProducerEvents(folder), streams = manifest.operation === 'check' || OPERATIONS.has(manifest.operation);
  let outcome: OwnedResult | undefined, cleanup: Cleanup | undefined, result: Preliminary | undefined;
  let cleanupSpan: Row | undefined;
  const findings: Finding[] = [];
  const onSignal = () => { interrupted = true; };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  const drain = () => {
    for (const row of producers.read()) {
      const type = String(row.type);
      delete row.schema_version; delete row.type;
      row.source_time = row.time ?? null; delete row.time;
      if (type === 'gate.end') gateEnded = true;
      if (type === 'check.end' && Array.isArray(row.findings)) {
        for (const text of row.findings) findings.push({ stage: String(row.stage), cause: String(text), log: join(folder, 'gate', `${String(row.stage)}.log`) });
      }
      journal.emit(type, row);
    }
  };
  let requested: Requested | undefined;
  let log = -1;
  let outcomeBinding: Record<string, string> | undefined;
  try {
    if (existsSync(join(folder, 'cancel.request'))) {
      result = { status: 'cancelled', exit_code: 130, cause: 'cancelled before gate admission' };
      cleanup = nothing();
    } else {
      if (['check', 'schematic'].includes(manifest.operation) && sha(join(manifest.root, 'hardware-design/boards', manifest.board, 'gate.json')) !== manifest.gate_config_sha256)
        throw new Error('configured gate changed after check admission');
      if (manifest.operation !== 'check') mkdirSync(join(folder, 'operation'), { recursive: true });
      log = openSync(join(folder, streams ? 'gate.log' : `operation/${manifest.operation}.log`), 'w');
      if (OBSERVATIONS.has(manifest.operation)) {
        outcomeBinding = producer(manifest.root, process.execPath);
        requested = await requestedInputs(manifest.operation, manifest.root, manifest.arguments as string[]);
      }
      const env: NodeJS.ProcessEnv = { ...process.env, IOT_LEAN_DEADLINE: encodeDeadline(deadline) };
      if (manifest.router === 'iotroute') {
        // Children read this deadline once, so it holds the whole bound; this loop enforces the real one.
        const wait = process.env.PCB_QUEUE_WAIT_S ?? String(QUEUE_WAIT_S);
        queueBound = Number(wait);
        Object.assign(env, { IOT_LEAN_DEADLINE: encodeDeadline(deadline + queueBound), PCB_QUEUE_CLOCK: join(folder, QUEUE_CLOCK), PCB_QUEUE_WAIT_S: wait });
      }
      proc = startOwned(manifest.command, { cwd: manifest.root, env, stdin: 'ignore', stdout: log, stderr: log });
      let heartbeat = now();
      for (;;) {
        if (streams) drain();
        if (interrupted || existsSync(join(folder, 'cancel.request')) || (now() >= deadline && now() >= deadline + queuedS(folder, queueBound))) {
          const cancelled = interrupted || existsSync(join(folder, 'cancel.request'));
          result = { status: cancelled ? 'cancelled' : 'timeout', exit_code: cancelled ? 130 : 124,
            cause: cancelled ? 'cancellation requested' : 'run deadline reached' };
          journal.state.status = 'stopping';
          journal.emit('run.stopping', { cause: result.cause });
          cleanup = await proc.cancel();
          try { outcome = await proc.settled; } catch { /* cleanup from cancel is authoritative */ }
          if (streams) drain();
          break;
        }
        if (proc.done) {
          outcome = await proc.settled;
          cleanup = outcome.cleanup;
          if (manifest.operation === 'check') {
            drain(); result = { ...gateOutcome(folder, outcome.returncode, gateEnded, findings) };
          } else if (OPERATIONS.has(manifest.operation)) {
            drain();
            const operation = readObject<Preliminary>(join(folder, 'operation/result.json'));
            if (operation.exit_code !== outcome.returncode || !TERMINAL.has(operation.status)) throw new Error('operation exit and terminal evidence disagree');
            result = operation;
          } else {
            const code = outcome.returncode;
            result = OBSERVATIONS.has(manifest.operation) ? observationEvidence(folder, manifest, code, outcomeBinding!, requested) as Preliminary : { status: code === 0 ? 'passed' : code === 2 ? 'error' : 'failed', exit_code: code === 0 ? 0 : code === 2 ? 2 : 1,
              cause: manifest.operation + (code === 0 ? ' completed' : ' failed; inspect original tool evidence'), scope: manifest.operation === 'doctor' ? 'environment' : manifest.operation === 'blocks' ? 'block_evidence' : 'assembly_readiness', operation: manifest.operation, tool_exit: code, artifact_directory: null };
            if (manifest.operation === 'blocks' && (manifest.arguments as string[] | undefined)?.[0] === 'bind' && code === 0) {
              const artifact = join(folder, 'operation/binding.json');
              const binding = readPyJson<Binding>(artifact);
              if (binding.schema !== 'iot-lab.block-binding.v1' || binding.status !== 'candidate' || binding.qualified !== false || binding.copper_reuse_approved !== false) throw new Error('block binding must remain an unqualified candidate');
              verifyBinding(binding);
              Object.assign(result, { binding_artifact: artifact, binding_sha256: fingerprint(binding), binding_file_sha256: sha(artifact), qualified: false, copper_reuse_approved: false });
            }
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
