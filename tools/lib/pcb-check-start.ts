// Admit an isolated check and start its one-shot owner. Never writes CAD.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson } from './json-file.ts';
import { iotrouteBin } from './iotroute-bin.ts';
import { runDir, utc } from './pcb-runs.ts';
import { boardConfig, sha } from './pcb-workflow.ts';
import { isFile, resolvePath, which } from './py-path.ts';

export interface CheckOptions { root: string; base: string; board: string; timeout: number; heartbeat: number; changed?: boolean; fresh?: boolean; baseline?: string }

export async function startCheck(options: CheckOptions): Promise<string> {
  const root = resolvePath(options.root), base = resolvePath(options.base);
  if (!Number.isFinite(options.timeout) || options.timeout <= 0 || !Number.isFinite(options.heartbeat) || options.heartbeat <= 0)
    throw new Error('timeout and heartbeat must be positive');
  if (options.changed && options.fresh) throw new Error('--changed and --fresh cannot be used together');
  const { folder: boardFolder, cfg } = boardConfig(root, options.board);
  const config = join(boardFolder, 'gate.json');
  let baseline: string | undefined;
  if (options.baseline) {
    baseline = join(runDir(base, options.baseline), 'gate/findings.json');
    if (!isFile(baseline)) throw new Error('baseline has no structured findings');
  }
  const node = which(process.env.NODE ?? 'node');
  if (!node) throw new Error('Node.js is required to run the existing gate');
  mkdirSync(base, { recursive: true });
  const folder = mkdtempSync(join(base, 'run-'));
  const command = [node, join(root, 'tools/gate.mjs'), options.board, '--evidence-dir', join(folder, 'gate')];
  if (options.changed) command.push('--changed');
  if (options.fresh) command.push('--fresh');
  if (baseline) command.push('--findings-baseline', baseline);
  const manifest = { schema_version: 1, run_id: basename(folder), board: options.board, project: cfg.get('project'),
    created_at: utc(), root, command, timeout_s: options.timeout, heartbeat_s: options.heartbeat,
    operation: 'check', node, gate_config_sha256: sha(config) };
  atomicJson(join(folder, 'run.json'), manifest);
  atomicJson(join(folder, 'state.json'), { schema_version: 1, run_id: basename(folder), board: options.board,
    status: 'starting', seq: 0, updated_unix: Date.now() / 1000, elapsed_s: 0, active_stages: [] });
  const worker = fileURLToPath(new URL('../pcb-check-worker.ts', import.meta.url));
  const finalizer = fileURLToPath(new URL('../pcb-check-finalize.ts', import.meta.url));
  const finalizerCommand = JSON.stringify([node, '--experimental-strip-types', '--no-warnings', finalizer]);
  const env: NodeJS.ProcessEnv = { ...process.env, IOT_LAB: root };
  for (const key of ['IOT_LEAN_BROKER_SOCKET', 'IOT_LEAN_STAGE_HANDLE', 'IOT_LEAN_STAGE_DEPTH', 'IOT_LEAN_DEADLINE', 'IOT_PCB_WORKER_LOCK', 'IOT_PCB_WORKER_FD']) delete env[key];
  const log = openSync(join(folder, 'worker.log'), 'w');
  try {
    const child = spawn(iotrouteBin(), ['lock', 'supervise', join(folder, 'worker.lock'), '--result', join(folder, 'worker-owner.json'),
      '--finalizer', finalizerCommand, '--', node, '--experimental-strip-types', '--no-warnings', worker, folder], {
      cwd: root, env, detached: true, stdio: ['ignore', log, log],
    });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } catch (error) {
    atomicJson(join(folder, 'state.json'), { schema_version: 1, run_id: basename(folder), board: options.board,
      status: 'error', seq: 0, updated_unix: Date.now() / 1000, elapsed_s: 0, active_stages: [], exit_code: 2,
      cause: `cannot start supervisor: ${error instanceof Error ? error.message : String(error)}` });
    throw error;
  } finally { closeSync(log); }
  return folder;
}
