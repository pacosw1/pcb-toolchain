// Admit an isolated check and start its one-shot owner. Never writes CAD.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson, readObject } from './json-file.ts';
import { iotrouteBin } from './iotroute-bin.ts';
import { runDir, utc } from './pcb-runs.ts';
import { boardConfig, sha } from './pcb-workflow.ts';
import { isFile, resolvePath, which } from './py-path.ts';
import { admitAction, type ActionRequest } from './pcb-action.ts';
import { attach, folderFor, read } from './pcb-cycle.ts';
import { CANDIDATE, candidateFields, OPERATIONS, type CandidateRequest } from './pcb-candidate-admission.ts';
import { parentCandidate } from './pcb-candidate.ts';
import { verify } from './pcb-evidence.ts';
import { holdLock } from './file-lock.ts';
import { verifySeal } from './cad-seal.ts';
import { assertRouteNotRepeated } from './route-repeat.ts';

export interface LoopContext { id: string; round: number; launch_id: string; source_sha256: string; deadline_ms: number }
export interface CheckOptions extends CandidateRequest { root: string; base: string; board: string; operation?: string; fromRun?: string; arguments?: string[]; timeout: number; heartbeat: number; changed?: boolean; fresh?: boolean; baseline?: string; cycle?: string; loopContext?: LoopContext }

function readDesign(args: string[]) {
  const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : args.find(item => item.startsWith(name + '='))?.slice(name.length + 1); };
  const given = option('--contract'); if (!given) throw new Error('design check requires --contract FILE');
  const path = resolvePath(given), content = readObject<Record<string, unknown>>(path), identity = content.identity as Record<string, unknown> | undefined;
  if (!identity || typeof identity.design_id !== 'string') throw new Error('design contract requires an identity object');
  return { path, content, id: identity.design_id, board: typeof identity.board === 'string' ? identity.board : null,
    stage: option('--through') ?? String(content.current_stage ?? 'requirements'), hash: sha(path) };
}

export async function startCheck(options: CheckOptions): Promise<string> {
  const root = resolvePath(options.root), base = resolvePath(options.base);
  if (!Number.isFinite(options.timeout) || options.timeout <= 0 || !Number.isFinite(options.heartbeat) || options.heartbeat <= 0)
    throw new Error('timeout and heartbeat must be positive');
  if (options.changed && options.fresh) throw new Error('--changed and --fresh cannot be used together');
  const operation = options.operation ?? 'check';
  const design = operation === 'design' ? readDesign(options.arguments ?? []) : undefined;
  if (design && design.id !== options.board) throw new Error('design action subject differs from its exact contract identity');
  const actualBoard = design ? design.board ?? design.id : options.board;
  const action = options.arguments?.[0];
  const configInfo = (operation === 'check' || OPERATIONS.has(operation) || operation === 'schematic' || operation === 'routing' || operation === 'placement' || (operation === 'parts' && action !== 'selection' && action !== 'inspect')) ? boardConfig(root, options.board) : undefined;
  const config = configInfo ? join(configInfo.folder, 'gate.json') : undefined;
  if (configInfo) verifySeal(root, options.board);
  let baseline: string | undefined;
  if (options.baseline) {
    baseline = join(runDir(base, options.baseline), 'gate/findings.json');
    if (!isFile(baseline)) throw new Error('baseline has no structured findings');
  }
  const cycleFolder = options.cycle ? folderFor(base, options.cycle) : undefined;
  if (cycleFolder) {
    const cycle = read(join(cycleFolder, 'cycle.json'));
    if (cycle.status !== 'open' || resolvePath(cycle.root) !== root) throw new Error('cycle must be open and belong to this checkout');
    if ((operation === 'check' || OPERATIONS.has(operation) || operation === 'readiness' || operation === 'schematic' || operation === 'design' || operation === 'routing' || operation === 'placement' || (operation === 'parts' && action !== 'inspect')) && cycle.board !== actualBoard) throw new Error('run belongs to another board than its engineering cycle');
  }
  const parentFolder = options.fromRun ? runDir(base, options.fromRun) : undefined;
  const fromRun = parentFolder ? { folder: parentFolder, result_sha256: sha(join(parentFolder, 'result.json')) } : undefined;
  if (fromRun) { verify(fromRun.folder); if (!CANDIDATE.has(operation)) parentCandidate(root, action === 'inspect' && cycleFolder ? read(join(cycleFolder, 'cycle.json')).board : options.board, fromRun); }
  const candidate = OPERATIONS.has(operation) ? candidateFields(root, operation, options.board, options, parentFolder) : {};
  const actionRecord = admitAction({ root, board: options.board, operation, timeout_s: options.timeout, ...candidate, ...(fromRun ? { from_run: fromRun } : {}) } as ActionRequest);
  if (options.loopContext && (operation !== 'route' || !/^loop-[a-f0-9]{16}$/.test(options.loopContext.id)
      || !Number.isSafeInteger(options.loopContext.round) || options.loopContext.round < 1 || options.loopContext.round > 8
      || !/^[a-f0-9]{24}$/.test(options.loopContext.launch_id) || options.loopContext.source_sha256 !== actionRecord?.source_revision
      || !Number.isFinite(options.loopContext.deadline_ms) || options.loopContext.deadline_ms <= Date.now())) throw new Error('invalid or expired loop context');
  // A loop round is a decision of its own (tools/ROUTING-LOOP.md): its context is checked above.
  if (operation === 'route' && !options.loopContext) assertRouteNotRepeated(base, root, options.board, actionRecord);
  const node = which(process.env.NODE ?? 'node');
  if (!node) throw new Error('Node.js is required to run the existing gate');
  mkdirSync(base, { recursive: true });
  const folder = mkdtempSync(join(base, 'run-'));
  const board = operation === 'doctor' || operation === 'blocks' || operation === 'outcomes' || operation === 'ml' || (operation === 'parts' && action === 'inspect') ? (cycleFolder ? read(join(cycleFolder, 'cycle.json')).board : operation === 'doctor' ? 'ENVIRONMENT' : operation === 'blocks' ? 'BLOCKS' : operation === 'parts' ? 'PARTS' : options.board)
    : operation === 'readiness' && !cycleFolder ? 'ASSEMBLY' : actualBoard;
  const designArgs = (options.arguments ?? []).map((arg, index, all) => design && all[index - 1] === '--contract' ? design.path : design && arg.startsWith('--contract=') ? '--contract=' + design.path : arg);
  const backendRoot = fromRun ? join(fromRun.folder, 'workspace') : root;
  const command = OPERATIONS.has(operation) ? [node, '--experimental-strip-types', '--no-warnings', fileURLToPath(new URL('../pcb-operation.ts', import.meta.url)), folder]
    : operation === 'doctor' ? [node, join(root, 'tools/doctor.mjs'), '--gate-only']
    : operation === 'readiness' ? [node, join(root, 'tools/check-release-readiness.mjs'), ...(options.arguments ?? [])]
    : operation === 'blocks' ? [node, '--experimental-strip-types', '--no-warnings', join(root, 'tools/blocks.ts'), ...(options.arguments ?? []), ...(action === 'bind' ? ['--output', join(folder, 'operation/binding.json')] : [])]
    : operation === 'placement' ? [node, '--experimental-strip-types', '--no-warnings', join(root, 'tools/engineering_constraints.ts'), ...(options.arguments ?? []), '--root', backendRoot, '--json', '--output', join(folder, 'operation/report.json')]
    : operation === 'routing' ? [node, '--experimental-strip-types', '--no-warnings', join(root, 'tools/route_decision.ts'), ...(options.arguments ?? []), '--root', backendRoot, '--json', '--output', join(folder, 'operation/report.json')]
    : operation === 'parts' ? [node, '--experimental-strip-types', '--no-warnings', join(root, 'tools/part_evidence.ts'), ...(options.arguments ?? []), '--root', backendRoot, '--json', '--output', join(folder, 'operation/report.json'), ...(action === 'inspect' ? ['--cache', join(folder, 'operation/cache')] : [])]
    : operation === 'design' ? [node, '--experimental-strip-types', '--no-warnings', join(root, 'tools/design_contract.ts'), ...designArgs, '--root', root, '--json', '--output', join(folder, 'operation/report.json')]
    : operation === 'schematic' ? [node, '--experimental-strip-types', '--no-warnings', join(root, 'tools/schematic_contract.ts'), ...(options.arguments ?? []), '--root', root, '--json', '--output', join(folder, 'operation/report.json')]
    : operation === 'outcomes' ? [node, '--experimental-strip-types', '--no-warnings', join(root, 'tools/placement_outcomes.ts'), ...(options.arguments ?? []), '--root', root, '--json', '--output', join(folder, 'operation/report.json')]
    : operation === 'ml' ? [node, '--experimental-strip-types', '--no-warnings', join(root, 'tools/pcb_ml.ts'), ...(options.arguments ?? []), '--root', root, '--json', '--output', join(folder, 'operation/report.json')]
    : [node, join(root, 'tools/gate.mjs'), board, '--evidence-dir', join(folder, 'gate')];
  if (options.changed) command.push('--changed');
  if (options.fresh) command.push('--fresh');
  if (baseline) command.push('--findings-baseline', baseline);
  const manifest = { schema_version: 1, run_id: basename(folder), board, project: configInfo?.cfg.get('project') ?? null,
    created_at: utc(), root, command, timeout_s: options.timeout, heartbeat_s: options.heartbeat,
    ...(design ? { design_id: design.id, design_stage: design.stage, design_contract: { path: design.path, sha256: design.hash, content: design.content } } : {}),
    ...candidate, ...(actionRecord ? { action: actionRecord } : {}), ...(fromRun ? { from_run: fromRun } : {}),
    operation, node, gate_config_sha256: config ? sha(config) : null, ...(options.loopContext ? { loop_context: options.loopContext } : {}),
    ...(['readiness', 'blocks', 'outcomes', 'schematic', 'design', 'parts', 'routing', 'placement', 'ml'].includes(operation) ? { arguments: options.arguments ?? [] } : {}), ...(cycleFolder ? { cycle: basename(cycleFolder) } : {}) };
  atomicJson(join(folder, 'run.json'), manifest);
  if (cycleFolder) await attach(cycleFolder, folder, { withLock: async (path, work) => {
    const lock = await holdLock(path, { waitS: 30 });
    try { return work(); } finally { await lock.release(); }
  } }, operation === 'parts' && action === 'inspect' ? 'datasheets' : operation === 'ml' ? 'verification' : operation === 'edit' && options.kind === 'route' ? 'routing' : undefined);
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
