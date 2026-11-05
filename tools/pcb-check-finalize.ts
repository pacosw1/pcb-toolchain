// Runs only after the outer owned broker has settled the worker and its
// descendants. That broker execs this process without releasing worker.lock.
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { atomicJson, plainJson, readObject } from './lib/json-file.ts';
import { iotrouteBin } from './lib/iotroute-bin.ts';
import { now } from './lib/lean-clock.ts';
import { compactTerminal, type Dict } from './lib/pcb-runs.ts';
import { evidenceFiles } from './lib/pcb-evidence.ts';
import { jsonDumps, jsonLoads } from './lib/py-compat.mjs';
import { CheckJournal, type Row } from './lib/pcb-check-journal.ts';
import { timingJson } from './lib/timing.ts';

interface Manifest extends Row { board: string; created_at: string; operation: string }

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
  if (manifest.operation !== 'check') throw new Error('invalid check manifest');
  let preliminary: Row;
  try { preliminary = readObject(join(folder, 'worker-preliminary.json')); }
  catch { preliminary = { status: 'error', exit_code: 2, cause: 'worker ended without preliminary evidence', nested_cleanup: null }; }
  let report: Row;
  try { report = readObject(owner); } catch { report = {}; }
  const ownerCleanup = report.cleanup as Row | undefined;
  const nested = preliminary.nested_cleanup as Row | undefined;
  const validStatus = ['passed', 'failed', 'error', 'cancelled', 'timeout'].includes(String(preliminary.status));
  const settled = validStatus && ownerCleanup?.complete === true && ownerCleanup.child_reaped === true
    && report.error === null && report.returncode === preliminary.exit_code && nested?.complete === true;
  const result: Row = { ...preliminary };
  delete result.nested_cleanup;
  if (!settled) Object.assign(result, { status: 'error', exit_code: 2,
    cause: `${String(preliminary.cause ?? 'worker result unavailable')}; owned process cleanup or result unconfirmed` });
  Object.assign(result, { scope: 'configured_board_gate', schema_version: 1, run_id: folder.split('/').at(-1), board: manifest.board,
    operation: 'check', cleanup: { ...(ownerCleanup ?? {}), complete: settled, nested }, gate_result: join(folder, 'gate/result.json'), evidence_dir: folder });
  const state = readObject<Row>(join(folder, 'state.json'));
  const started = typeof state.worker_started_clock_s === 'number' ? state.worker_started_clock_s : now();
  const journal = new CheckJournal(folder, manifest.created_at, started);
  try { result.evidence_sha256 = evidenceFiles(folder); }
  catch (error) { Object.assign(result, { status: 'error', exit_code: 2, cause: `cannot bind run evidence: ${String(error)}` }); }
  Object.assign(result, { elapsed_s: Math.round((now() - started) * 1000) / 1000,
    timing: timingJson(journal.timeline.summary(undefined, true)), ended_unix_s: Date.now() / 1000 });
  verifyLock(folder);
  atomicJson(join(folder, 'result.json'), result);
  Object.assign(journal.state, result);
  journal.timeline.active.clear();
  const compact = plainJson(compactTerminal(jsonLoads(jsonDumps(result)) as Dict, folder)) as Row;
  delete compact.schema_version; delete compact.run_id; delete compact.elapsed_s;
  journal.emit('run.end', compact);
  return Number(result.exit_code);
}

try { process.exitCode = finalize(process.argv[2] ?? ''); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
