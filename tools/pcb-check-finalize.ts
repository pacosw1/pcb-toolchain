// Runs only after the outer owned broker has settled the worker and its
// descendants. That broker execs this process without releasing worker.lock.
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { plainJson, readObject } from './lib/json-file.ts';
import { durableJson } from './lib/pcb-check-durable.ts';
import { iotrouteBin } from './lib/iotroute-bin.ts';
import { now } from './lib/lean-clock.ts';
import { compactTerminal, events, type Dict } from './lib/pcb-runs.ts';
import { evidenceFiles } from './lib/pcb-evidence.ts';
import { gateOutcome, type Finding } from './lib/pcb-gate-outcome.ts';
import { jsonDumps, jsonLoads } from './lib/py-compat.mjs';
import { CheckJournal, type Row } from './lib/pcb-check-journal.ts';
import { MeasuredSpan, timingJson } from './lib/timing.ts';
import { sha } from './lib/pcb-workflow.ts';
import { observationEvidence, OBSERVATIONS, type Requested } from './lib/pcb-outcomes-binding.ts';

interface Manifest extends Row { root: string; board: string; created_at: string; operation: string; gate_config_sha256: string }

function verifyLock(folder: string): void {
  const path = join(folder, 'worker.lock'), fd = Number(process.env.IOT_PCB_WORKER_FD);
  if (process.env.IOT_PCB_WORKER_LOCK !== path || !Number.isSafeInteger(fd) || fd < 3) throw new Error('finalizer lacks its worker lock');
  const result = spawnSync(iotrouteBin(), ['lock', 'verify-fd', path, '3'], { stdio: ['ignore', 'pipe', 'pipe', fd], encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`worker lock is unconfirmed: ${result.error?.message ?? result.stderr.trim()}`);
}

function finalize(ownerPath: string): number {
  const owner = resolve(ownerPath), folder = resolve(join(owner, '..'));
  if (owner !== join(folder, 'worker-owner.json')) throw new Error('invalid owner receipt path');
  verifyLock(folder);
  const manifest = readObject<Manifest>(join(folder, 'run.json'));
  if (!['check', 'doctor', 'readiness', 'blocks'].includes(manifest.operation) && !OBSERVATIONS.has(manifest.operation)) throw new Error('invalid check manifest');
  let preliminary: Row;
  try { preliminary = readObject(join(folder, 'worker-preliminary.json')); }
  catch { preliminary = { status: 'error', exit_code: 2, cause: 'worker ended without preliminary evidence', nested_cleanup: null }; }
  let report: Row;
  try { report = readObject(owner); } catch { report = {}; }
  const ownerCleanup = report.cleanup as Row | undefined;
  const nested = preliminary.nested_cleanup as Row | undefined;
  const validStatus = ['passed', 'failed', 'error', 'cancelled', 'timeout'].includes(String(preliminary.status));
  const cleanupConfirmed = ownerCleanup?.complete === true && ownerCleanup.child_reaped === true && nested?.complete === true;
  let settled = validStatus && cleanupConfirmed && report.error === null && report.returncode === preliminary.exit_code;
  let evidenceProblem: string | undefined;
  if (settled && manifest.operation !== 'check' && ['passed', 'failed'].includes(String(preliminary.status))) {
    try {
      const operation = readObject<Row>(join(folder, 'operation/result.json'));
      for (const key of ['status', 'exit_code', 'cause', 'scope', 'operation', 'tool_exit'])
        if (operation[key] !== preliminary[key]) throw new Error('operation result changed before sealing');
      if (OBSERVATIONS.has(manifest.operation)) {
        if (manifest.operation === 'schematic' && sha(join(manifest.root, 'hardware-design/boards', manifest.board, 'gate.json')) !== manifest.gate_config_sha256) throw new Error('configured gate changed after admission');
        const actual = observationEvidence(folder, manifest as never, Number(operation.tool_exit), preliminary.engineering_producer_inputs as Record<string, string>, preliminary.engineering_requested_inputs as Requested | undefined);
        for (const key of ['status', 'exit_code', 'engineering_status', 'report_sha256']) if (actual[key] !== operation[key] || actual[key] !== preliminary[key]) throw new Error('outcome evidence changed before sealing');
        if (JSON.stringify(actual.engineering_inputs) !== JSON.stringify(preliminary.engineering_inputs)) throw new Error('outcome inputs changed before sealing');
      }
      if ((operation.tool_exit === 0) !== (operation.status === 'passed')) throw new Error('operation exit disagrees with result');
    } catch (error) { settled = false; evidenceProblem = error instanceof Error ? error.message : String(error); }
  }
  if (settled && manifest.operation === 'check' && ['passed', 'failed'].includes(String(preliminary.status))) {
    try {
      if (sha(join(manifest.root, 'hardware-design/boards', manifest.board, 'gate.json')) !== manifest.gate_config_sha256)
        throw new Error('configured gate changed after check admission');
      let cursor = 0, ended = false;
      const findings: Finding[] = [];
      for (;;) {
        const rows = events(join(folder, 'gate'), cursor, 1000);
        for (const entry of rows) {
          cursor = Number(entry.get('cursor'));
          const row = plainJson(entry) as Row;
          if (row.schema_version !== 1 || typeof row.type !== 'string') throw new Error('invalid producer event');
          if (row.type === 'gate.end') ended = true;
          if (row.type === 'check.end' && Array.isArray(row.findings))
            for (const text of row.findings) findings.push({ stage: String(row.stage), cause: String(text), log: join(folder, 'gate', `${String(row.stage)}.log`) });
        }
        if (rows.length < 1000) break;
      }
      const actual = gateOutcome(folder, Number(preliminary.gate_returncode), ended, findings);
      for (const key of ['status', 'exit_code', 'cause', 'metrics', 'input_sha256', 'findings'] as const)
        if (JSON.stringify(actual[key]) !== JSON.stringify(preliminary[key])) throw new Error(`gate ${key} changed before sealing`);
    } catch (error) { settled = false; evidenceProblem = error instanceof Error ? error.message : String(error); }
  }
  const result: Row = { ...preliminary };
  delete result.nested_cleanup; delete result.gate_returncode; delete result.cleanup_span;
  if (!settled) Object.assign(result, { status: 'error', exit_code: 2,
    cause: evidenceProblem ? `gate evidence unconfirmed: ${evidenceProblem}`
      : `${String(preliminary.cause ?? 'worker result unavailable')}; owned process cleanup or result unconfirmed` });
  Object.assign(result, { scope: manifest.operation === 'doctor' ? 'environment' : manifest.operation === 'readiness' ? 'assembly_readiness' : manifest.operation === 'blocks' ? 'block_evidence' : manifest.operation === 'outcomes' ? 'placement_outcomes' : manifest.operation === 'schematic' ? 'schematic_function' : manifest.operation === 'design' ? 'design_assessment' : manifest.operation === 'parts' ? 'part_evidence' : manifest.operation === 'routing' ? 'routing_decision' : manifest.operation === 'placement' ? 'placement_constraints' : manifest.operation === 'ml' ? 'ml_observation' : 'configured_board_gate', schema_version: 1, run_id: folder.split('/').at(-1), board: manifest.board,
    operation: manifest.operation, cleanup: { ...(ownerCleanup ?? {}), complete: cleanupConfirmed, nested },
    ...(manifest.operation === 'check' ? { gate_result: join(folder, 'gate/result.json') } : {}), evidence_dir: folder });
  const state = readObject<Row>(join(folder, 'state.json'));
  const started = typeof state.worker_started_clock_s === 'number' ? state.worker_started_clock_s : now();
  const journal = new CheckJournal(folder, manifest.created_at, started);
  const cleanupSpan = preliminary.cleanup_span as Row | undefined;
  if (cleanupSpan && typeof cleanupSpan.started_clock_s === 'number') {
    const fields = { ...cleanupSpan }; delete fields.started_clock_s;
    journal.emit('stage.end', { ...fields, ended_unix_s: Date.now() / 1000,
      duration_s: Math.max(0, now() - cleanupSpan.started_clock_s), duration_source: 'same_host_monotonic',
      status: cleanupConfirmed ? 'passed' : 'error' });
  }
  const sealing = new MeasuredSpan('evidence-sealing', 'sealing');
  journal.emit('stage.start', { ...sealing.fields });
  try { result.evidence_sha256 = evidenceFiles(folder); journal.emit('stage.end', sealing.end()); }
  catch (error) { journal.emit('stage.end', sealing.end('error')); Object.assign(result, { status: 'error', exit_code: 2, cause: `cannot bind run evidence: ${String(error)}` }); }
  Object.assign(result, { elapsed_s: Math.round((now() - started) * 1000) / 1000,
    timing: timingJson(journal.timeline.summary(undefined, true)), ended_unix_s: Date.now() / 1000 });
  verifyLock(folder);
  durableJson(join(folder, 'result.json'), result);
  Object.assign(journal.state, result);
  journal.timeline.active.clear();
  const compact = plainJson(compactTerminal(jsonLoads(jsonDumps(result)) as Dict, folder)) as Row;
  delete compact.schema_version; delete compact.run_id; delete compact.elapsed_s;
  journal.emit('run.end', compact);
  return Number(result.exit_code);
}

try { process.exitCode = finalize(process.argv[2] ?? ''); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
