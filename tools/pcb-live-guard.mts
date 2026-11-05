#!/usr/bin/env node
// Coordinated entry point for the existing toolchain. The native writer remains the existing verified CLI;
// a durable coordinator pin spans the process and, for detached runs, its confirmed child cleanup.
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardPath, configFile, Coordinator, HttpError, loadConfig, projectId } from './pcb-live-common.mts';
import type { Lease, LiveConfig, Revision } from './pcb-live-common.mts';

const hash = (v: string | Buffer): string => createHash('sha256').update(v).digest('hex');
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const TERMINAL = new Set(['passed', 'failed', 'error', 'cancelled', 'timeout']);
const WRITERS = new Set(['build', 'edit', 'route', 'repair', 'release']);
const idPattern = /^run-[A-Za-z0-9_-]+$/;
interface Receipt { schema: 1; root: string; config: LiveConfig; lease: Lease; board: string; operation: string;
  runId?: string; runDir?: string; previewDir: string; target?: string; before?: string; revision?: number;
  guardPid?: number; writerPid?: number }

function save(file: string, value: Receipt): void {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
function verifyManaged(root: string): void {
  const dir = path.join(root, 'tools'), listing = path.join(dir, '.toolchain-files'), stamp = path.join(dir, '.toolchain-version');
  if (!fs.existsSync(listing)) return;
  if (!fs.existsSync(stamp)) throw new Error('managed tool files have no version stamp');
  const version = fs.readFileSync(stamp, 'utf8').trim().split(/\s+/)[0];
  const manifestPath = path.join(os.homedir(), '.local/share/pcb-toolchain', version, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { files?: Record<string, string> };
  for (const name of fs.readFileSync(listing, 'utf8').split('\n').filter(Boolean)) {
    const target = path.resolve(dir, name);
    if (!target.startsWith(path.resolve(dir) + path.sep)) throw new Error('invalid managed tool path');
    let st: fs.Stats;
    try { st = fs.lstatSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const expected = manifest.files?.['tools/' + name];
    if (!st.isFile() || typeof expected !== 'string' || hash(fs.readFileSync(target)) !== expected)
      throw new Error(`managed tool file ${name} was changed; no files were replaced`);
  }
}
function runsBase(root: string, args: string[]): string {
  let base = process.env.PCB_RUNS_DIR ?? path.join(root, '.gate/cli');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runs-dir' && args[i + 1]) base = args[++i];
    else if (args[i].startsWith('--runs-dir=')) base = args[i].slice(11);
  }
  return path.resolve(root, base);
}
function runDir(root: string, args: string[], runId: string): string {
  if (!idPattern.test(runId)) throw new Error('invalid run ID');
  return path.join(runsBase(root, args), runId);
}
function commandArgs(args: string[]): { op: string; subject: string } {
  const commands = new Set([...WRITERS, 'adopt']);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project') { i++; continue; }
    if (args[i].startsWith('--project=')) continue;
    if (commands.has(args[i])) {
      const rest = args.slice(i + 1); let subject = '';
      for (let j = 0; j < rest.length; j++) {
        if (['--runs-dir', '--timeout', '--heartbeat', '--cycle', '--router', '--kind', '--spec', '--from-run', '--engineering-manifest', '--design-contract', '--baseline', '--defect'].includes(rest[j])) { j++; continue; }
        if (rest[j].startsWith('-')) continue;
        subject = rest[j]; break;
      }
      if (!subject) throw new Error(`${args[i]} requires a board or run ID`);
      return { op: args[i], subject };
    }
  }
  return { op: '', subject: '' };
}
function lineRunId(line: string): string | null {
  try { const o = JSON.parse(line) as { run_id?: unknown }; if (typeof o.run_id === 'string' && idPattern.test(o.run_id)) return o.run_id; } catch { /* plain CLI output */ }
  return /^(?:START:\s*)?(run-[A-Za-z0-9_-]+)\b/.exec(line)?.[1] ?? null;
}
async function finish(c: Coordinator, lease: Lease): Promise<void> {
  try { await c.end(lease); }
  catch (error) {
    if (!(error instanceof HttpError) || error.status !== 409) throw error;
    const status = await c.status(lease.board);
    if (status?.commitGeneration === lease.generation) throw error;
    // The matching pin is already gone; a lost acknowledgement must not strand recovery.
  }
  try { await c.release(lease); } catch (e) { if (!(e instanceof HttpError) || e.status !== 409) throw e; }
}
async function metadataAfterLostResponse(c: Coordinator, lease: Lease, expected: number | null, wanted: string): Promise<Revision | null> {
  const current = await c.metadata(lease.board);
  const next = expected === null ? 1 : expected + 1;
  return current && current.sha256 === wanted && current.generation === lease.generation && current.revision === next ? current : null;
}
async function publish(c: Coordinator, lease: Lease, expected: number | null, bytes: Buffer): Promise<Revision> {
  try { return await c.publish(lease, expected, bytes); }
  catch (error) { const found = await metadataAfterLostResponse(c, lease, expected, hash(bytes)); if (found) return found; throw error; }
}
export function verifiedCandidate(folder: string, expected: string): boolean {
  const root = fs.realpathSync(folder);
  const result = JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8')) as {
    status?: string; cleanup?: { complete?: boolean }; candidate_sha256?: string; evidence_sha256?: Record<string, string> };
  if (result.status !== 'passed' || result.cleanup?.complete !== true || result.candidate_sha256 !== expected ||
      !result.evidence_sha256 || typeof result.evidence_sha256['run.json'] !== 'string') return false;
  for (const [name, wanted] of Object.entries(result.evidence_sha256)) {
    const p = fs.realpathSync(path.resolve(root, name));
    if (!p.startsWith(root + path.sep) || !/^[0-9a-f]{64}$/.test(wanted) || hash(fs.readFileSync(p)) !== wanted) return false;
  }
  const operation = JSON.parse(fs.readFileSync(path.join(root, 'operation/result.json'), 'utf8')) as {
    candidate_verified?: boolean; identity_preserved?: boolean; protected_source_changes?: unknown; candidate_sha256?: string };
  const changes = operation.protected_source_changes;
  const clear = changes == null || changes === false || (Array.isArray(changes) && changes.length === 0) ||
    (typeof changes === 'object' && !Array.isArray(changes) && Object.keys(changes as object).length === 0);
  return operation.candidate_verified === true && operation.identity_preserved === true && clear && operation.candidate_sha256 === expected;
}
function moveReceipt(file: string, r: Receipt, runId: string, args: string[]): void {
  const folder = runDir(r.root, args, runId), manifest = JSON.parse(fs.readFileSync(path.join(folder, 'run.json'), 'utf8')) as { board?: unknown; root?: unknown };
  if (manifest.board !== r.board || typeof manifest.root !== 'string' || fs.realpathSync(manifest.root) !== r.root) throw new Error('run identity does not match the guarded board');
  r.runId = runId; r.runDir = folder; save(file, r);
  const index = path.join(r.previewDir, 'run.json');
  fs.writeFileSync(index + '.tmp', JSON.stringify({ board: r.board, runId }), { mode: 0o600 }); fs.renameSync(index + '.tmp', index);
}
async function guardian(file: string): Promise<void> {
  const r = JSON.parse(fs.readFileSync(file, 'utf8')) as Receipt;
  if (!r.runId || !r.runDir || !idPattern.test(r.runId)) throw new Error('guard receipt has no run identity');
  const c = new Coordinator(r.config);
  for (;;) {
    if (!fs.existsSync(file)) return;
    try {
      const result = JSON.parse(fs.readFileSync(path.join(r.runDir, 'result.json'), 'utf8')) as { status?: string; cleanup?: { complete?: boolean } };
      if (result.status && TERMINAL.has(result.status) && result.cleanup?.complete === true) {
        if (r.operation === 'adopt') {
          if (!r.guardPid || !r.writerPid || !r.target || !r.before || !r.revision) { await sleep(3000); continue; }
          const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } };
          if (alive(r.guardPid) || alive(r.writerPid)) { await sleep(3000); continue; }
          const bytes = fs.readFileSync(r.target), actual = hash(bytes);
          const adoptionFile = path.join(r.runDir, 'adoption.json');
          if (fs.existsSync(adoptionFile)) {
            const adoption = JSON.parse(fs.readFileSync(adoptionFile, 'utf8')) as { target?: string; before_sha256?: string; after_sha256?: string };
            if (adoption.before_sha256 !== r.before || adoption.after_sha256 !== actual || adoption.target !== r.target ||
                !verifiedCandidate(r.runDir, actual)) { await sleep(3000); continue; }
            const meta = await c.metadata(r.lease.board);
            if (meta?.sha256 === r.before && meta.revision === r.revision) await publish(c, r.lease, r.revision, bytes);
            else if (!(meta?.sha256 === actual && meta.generation === r.lease.generation && meta.revision === r.revision + 1)) { await sleep(3000); continue; }
          } else if (actual !== r.before) { await sleep(3000); continue; }
        }
        await finish(c, r.lease); fs.rmSync(file, { force: true }); return;
      }
    } catch { /* absent result, network outage, or unconfirmed cleanup: keep the board pinned */ }
    await sleep(3000);
  }
}
function spawnGuardian(file: string): void {
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-strip-types', fileURLToPath(import.meta.url), '--guardian', file],
    { detached: true, stdio: 'ignore', env: process.env });
  child.once('error', error => console.error('pcb: could not start lock guardian:', error.message));
  child.unref();
}
async function childProcess(program: string, args: string[], env: NodeJS.ProcessEnv, onLine: (line: string) => void, held?: Buffer[], onSpawn?: (pid: number) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['inherit', 'pipe', 'inherit'], env });
    if (child.pid && onSpawn) onSpawn(child.pid);
    let pending = '';
    const forward = (signal: NodeJS.Signals): void => { try { child.kill(signal); } catch { /* already exited */ } };
    const interrupt = (): void => forward('SIGINT'), terminate = (): void => forward('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    child.stdout.on('data', (chunk: Buffer) => {
      if (held) held.push(Buffer.from(chunk)); else process.stdout.write(chunk);
      pending += chunk.toString('utf8');
      const lines = pending.split(/\r?\n/); pending = lines.pop() ?? '';
      for (const line of lines) onLine(line);
      if (pending.length > 1024 * 1024) pending = pending.slice(-4096);
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
      if (pending) onLine(pending);
      resolve(code ?? (signal === 'SIGINT' ? 130 : 143));
    });
  });
}
async function dispatch(root: string, program: string, args: string[]): Promise<number> {
  root = fs.realpathSync(root);
  const cfg = loadConfig(), project = projectId(root, cfg), { op, subject } = commandArgs(args);
  if (!project || !op) return childProcess(program, args, { ...process.env }, () => undefined);
  if (!cfg) throw new Error('live coordinator is not configured');
  const runFolder = op === 'adopt' ? runDir(root, args, subject) : null;
  const board = op === 'adopt' ? (JSON.parse(fs.readFileSync(path.join(runFolder!, 'run.json'), 'utf8')) as { board: string }).board : subject;
  const target = boardPath(root, board), boardKey = `${project}/${path.relative(root, target).split(path.sep).join('/')}`;
  const displayBoard = path.relative(path.join(root, 'hardware-design/boards'), target).split(path.sep)[0];
  const owner = `${os.hostname()}:${process.pid}:${randomUUID()}`, coordinator = new Coordinator(cfg);
  const host = `${os.hostname()} (${path.basename(root)}, ${hash(root).slice(0, 6)})`;
  const source = hash(`${host}\0${project}\0${root}`), waitingId = `waiting-${randomUUID()}`;
  const report = async (status: string, cause: string): Promise<void> => {
    try {
      await coordinator.request('POST', '/live/events', { source, eventId: randomUUID(), host, board: `${project}/${displayBoard}`,
        run: waitingId, kind: 'run.state', data: { status, cause, operation: op, supervisorAlive: status === 'queued' } });
    } catch { /* observation does not grant or release a lock */ }
  };
  let lease: Lease | null = null, interrupted = false;
  const cancel = (): void => { interrupted = true; };
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  const until = Date.now() + 300_000; let announced = false, reported = 0;
  while (!lease) {
    if (interrupted) { if (announced) await report('cancelled', 'Stopped while waiting for the board'); process.off('SIGINT', cancel); process.off('SIGTERM', cancel); return 130; }
    try { lease = await coordinator.acquire(boardKey, owner); }
    catch (error) {
      if (!(error instanceof HttpError) || error.status !== 409) throw error;
      const cause = error.message === 'board has an observed unguarded writer'
        ? 'Waiting for an observed unguarded writer to finish' : 'Waiting for another writer to release this board';
      if (!announced) { console.error(`pcb: ${cause} (${board})`); announced = true; }
      if (Date.now() - reported >= 15000) { await report('queued', cause); reported = Date.now(); }
      if (Date.now() >= until) { await report('error', 'Timed out waiting for the board lock'); throw new Error('timed out waiting for the board lock'); }
      await sleep(3000);
    }
  }
  process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  if (announced) await report('started', 'Board lock acquired; the toolchain is starting');
  if (lease.board !== boardKey || lease.owner !== owner || !Number.isSafeInteger(lease.generation) || !/^[0-9a-f]{64}$/.test(lease.token)) throw new Error('coordinator returned an invalid lease');
  const guardDir = path.join(root, '.gate/live-guards'), id = randomUUID(), previewDir = path.join(root, '.gate/live-previews', id);
  fs.mkdirSync(guardDir, { recursive: true, mode: 0o700 }); fs.mkdirSync(previewDir, { recursive: true, mode: 0o700 });
  const file = path.join(guardDir, id + '.json');
  const receipt: Receipt = { schema: 1, root, config: cfg, lease, board, operation: op, previewDir, guardPid: process.pid };
  save(file, receipt); // the pin may survive a lost response or a crash
  let pinned = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await coordinator.begin(lease); pinned = true; break; }
    catch (error) {
      if (error instanceof HttpError || attempt === 2) {
        // No writer has been started. Release a pin even if its acknowledgement was lost;
        // retain the receipt if coordinator state cannot be confirmed.
        try { await finish(coordinator, lease); fs.rmSync(file, { force: true }); }
        catch { console.error('pcb: lock cleanup is unconfirmed; its receipt remains for recovery'); }
        throw error;
      }
      await sleep(1000);
    }
  }
  if (!pinned) throw new Error('board lock could not be pinned');
  if (op === 'adopt') {
    let before: string;
    try {
      const bytes = fs.readFileSync(target); before = hash(bytes);
      let meta = await coordinator.metadata(boardKey);
      if (!meta) meta = await publish(coordinator, lease, null, bytes);
      if (meta.sha256 !== before) throw new Error('board differs from the coordinator revision; reconcile the checkout before adoption');
      receipt.target = target; receipt.before = before; receipt.revision = meta.revision; receipt.runId = subject; receipt.runDir = runFolder!; save(file, receipt);
    } catch (error) { await finish(coordinator, lease); fs.rmSync(file, { force: true }); throw error; }
    const held: Buffer[] = [];
    const code = await childProcess(program, args, { ...process.env }, () => undefined, held, pid => { receipt.writerPid = pid; save(file, receipt); });
    const current = fs.existsSync(target) ? fs.readFileSync(target) : null;
    if (code !== 0) {
      if (current && hash(current) === before) { await finish(coordinator, lease); fs.rmSync(file, { force: true }); }
      else console.error('pcb: adoption may have changed the board; its lock remains pinned for recovery');
      process.stdout.write(Buffer.concat(held));
      return code;
    }
    const adoption = JSON.parse(fs.readFileSync(path.join(runFolder!, 'adoption.json'), 'utf8')) as { before_sha256?: string; after_sha256?: string };
    if (!current || adoption.before_sha256 !== before || adoption.after_sha256 !== hash(current)) throw new Error('adoption receipt does not match the board; lock remains pinned');
    await publish(coordinator, lease, receipt.revision!, current);
    await finish(coordinator, lease); fs.rmSync(file, { force: true });
    process.stdout.write(Buffer.concat(held)); return code;
  }
  const env = { ...process.env, IOTROUTE_LIVE_FILE: path.join(previewDir, 'live-route.json'), PCB_LIVE_ROUTE_FILE: path.join(previewDir, 'live-route.json'),
    IOTPLACE_LIVE_FILE: path.join(previewDir, 'live-place.json'), PCB_LIVE_PLACEMENT_FILE: path.join(previewDir, 'live-place.json'),
    PCB_LIVE_SOURCE: source, PCB_LIVE_HOST: host, PCB_LIVE_BOARD: `${project}/${displayBoard}`,
    PCB_LIVE_COORDINATOR: cfg.url, PCB_LIVE_TOKEN_FILE: cfg.tokenFile };
  const base = runsBase(root, args);
  const priorRuns = new Set(fs.existsSync(base) ? fs.readdirSync(base).filter(n => idPattern.test(n)) : []);
  let associated = false;
  const code = await childProcess(program, args, env, line => {
    if (associated) return;
    const runId = lineRunId(line); if (!runId) return;
    try { moveReceipt(file, receipt, runId, args); spawnGuardian(file); associated = true; }
    catch (error) { console.error('pcb: cannot attach live guard:', error instanceof Error ? error.message : String(error)); }
  });
  if (!associated) {
    const created = fs.existsSync(base) ? fs.readdirSync(base).filter(n => idPattern.test(n) && !priorRuns.has(n)) : [];
    if (!created.length) {
      await finish(coordinator, lease); fs.rmSync(file, { force: true });
      if (announced) await report('failed', 'The toolchain stopped before starting a run');
    } else {
      console.error('pcb: run identity was not confirmed; board lock remains pinned for recovery');
      await report('error', 'Run identity could not be confirmed; board remains locked');
    }
  }
  return code;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--guardian' && args[1]) return guardian(args[1]);
  if (args[0] === '--check-managed' && args[1]) { verifyManaged(args[1]); return; }
  if (args[0] === '--registered' && args[1]) { console.log(projectId(args[1], loadConfig()) ? 'registered' : 'unregistered'); return; }
  const split = args.indexOf('--');
  if (args[0] !== '--project' || !args[1] || split !== 2 || !args[3]) throw new Error('usage: pcb-live-guard --project DIR -- PROGRAM [ARGS...]');
  process.exitCode = await dispatch(args[1], args[3], args.slice(4));
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  void main().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    if (process.argv.includes('--json')) console.log(JSON.stringify({ status: 'error', exit_code: 2, cause: message }));
    else console.error('pcb:', message);
    process.exitCode = 2;
  });
}
