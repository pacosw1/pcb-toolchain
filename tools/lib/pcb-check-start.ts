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
import { attach, folderFor, read } from './pcb-cycle.ts';
import { holdLock } from './file-lock.ts';

export interface CheckOptions { root: string; base: string; board: string; operation?: 'check' | 'doctor' | 'readiness' | 'blocks' | 'outcomes' | 'schematic'; arguments?: string[]; timeout: number; heartbeat: number; changed?: boolean; fresh?: boolean; baseline?: string; cycle?: string }

export async function startCheck(options: CheckOptions): Promise<string> {
  const root = resolvePath(options.root), base = resolvePath(options.base);
  if (!Number.isFinite(options.timeout) || options.timeout <= 0 || !Number.isFinite(options.heartbeat) || options.heartbeat <= 0)
    throw new Error('timeout and heartbeat must be positive');
  if (options.changed && options.fresh) throw new Error('--changed and --fresh cannot be used together');
  const operation = options.operation ?? 'check';
  const configInfo = (operation === 'check' || operation === 'schematic') ? boardConfig(root, options.board) : undefined;
  const config = configInfo ? join(configInfo.folder, 'gate.json') : undefined;
  let baseline: string | undefined;
  if (options.baseline) {
    baseline = join(runDir(base, options.baseline), 'gate/findings.json');
    if (!isFile(baseline)) throw new Error('baseline has no structured findings');
  }
  const cycleFolder = options.cycle ? folderFor(base, options.cycle) : undefined;
  if (cycleFolder) {
    const cycle = read(join(cycleFolder, 'cycle.json'));
    if (cycle.status !== 'open' || resolvePath(cycle.root) !== root) throw new Error('cycle must be open and belong to this checkout');
    if ((operation === 'check' || operation === 'readiness' || operation === 'schematic') && cycle.board !== options.board) throw new Error('run belongs to another board than its engineering cycle');
  }
  const node = which(process.env.NODE ?? 'node');
  if (!node) throw new Error('Node.js is required to run the existing gate');
  mkdirSync(base, { recursive: true });
  const folder = mkdtempSync(join(base, 'run-'));
  const board = operation === 'doctor' || operation === 'blocks' || operation === 'outcomes' ? (cycleFolder ? read(join(cycleFolder, 'cycle.json')).board : operation === 'doctor' ? 'ENVIRONMENT' : operation === 'blocks' ? 'BLOCKS' : options.board)
    : operation === 'readiness' && !cycleFolder ? 'ASSEMBLY' : options.board;
  const command = operation === 'doctor' ? [node, join(root, 'tools/doctor.mjs'), '--gate-only']
    : operation === 'readiness' ? [node, join(root, 'tools/check-release-readiness.mjs'), ...(options.arguments ?? [])]
    : operation === 'blocks' ? [node, '--experimental-strip-types', '--no-warnings', join(root, 'tools/blocks.ts'), ...(options.arguments ?? [])]
    : operation === 'schematic' ? [node, '--experimental-strip-types', '--no-warnings', join(root, 'tools/schematic_contract.ts'), ...(options.arguments ?? []), '--root', root, '--json', '--output', join(folder, 'operation/report.json')]
    : operation === 'outcomes' ? [node, '--experimental-strip-types', '--no-warnings', join(root, 'tools/placement_outcomes.ts'), ...(options.arguments ?? []), '--root', root, '--json', '--output', join(folder, 'operation/report.json')]
    : [node, join(root, 'tools/gate.mjs'), board, '--evidence-dir', join(folder, 'gate')];
  if (options.changed) command.push('--changed');
  if (options.fresh) command.push('--fresh');
  if (baseline) command.push('--findings-baseline', baseline);
  const manifest = { schema_version: 1, run_id: basename(folder), board, project: configInfo?.cfg.get('project') ?? null,
    created_at: utc(), root, command, timeout_s: options.timeout, heartbeat_s: options.heartbeat,
    operation, node, gate_config_sha256: config ? sha(config) : null,
    ...(['readiness', 'blocks', 'outcomes', 'schematic'].includes(operation) ? { arguments: options.arguments ?? [] } : {}), ...(cycleFolder ? { cycle: basename(cycleFolder) } : {}) };
  atomicJson(join(folder, 'run.json'), manifest);
  if (cycleFolder) await attach(cycleFolder, folder, { withLock: async (path, work) => {
    const lock = await holdLock(path, { waitS: 30 });
    try { return work(); } finally { await lock.release(); }
  } });
  atomicJson(join(folder, 'state.json'), { schema_version: 1, run_id: basename(folder), board,
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
