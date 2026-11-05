#!/usr/bin/env node
// Read-only observation of toolchain worktrees. The coordinator stores the cursor and snapshots;
// workers only advance local offsets after an acknowledged, idempotent event.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { discoverExternal } from './pcb-live-processes.mts';
import type { ExternalRun } from './pcb-live-processes.mts';
import { exportModel } from './pcb-live-model.mts';
import { placementHistory } from './pcb-live-placement-history.mts';

const MAX_BOARD = 20 * 1024 * 1024;
const MAX_LINE = 48 * 1024;
const digest = (v: string | Buffer): string => createHash('sha256').update(v).digest('hex');
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const real = (p: string): string => fs.realpathSync(p);
const within = (root: string, p: string): boolean => p.startsWith(root + path.sep);
const file = (p: string): boolean => { try { return fs.lstatSync(p).isFile(); } catch { return false; } };
const dir = (p: string): boolean => { try { return fs.lstatSync(p).isDirectory(); } catch { return false; } };
const stampOf = (st: fs.Stats): string => `${st.ino}:${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
function stableRead(p: string, expected: fs.Stats, limit: number): Buffer | null {
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stampOf(stat) !== stampOf(expected) || stat.size > limit) return null;
    const bytes = Buffer.allocUnsafe(stat.size + 1); let n = 0;
    while (n < bytes.length) { const read = fs.readSync(fd, bytes, n, bytes.length - n, n); if (!read) break; n += read; }
    return n === stat.size && stampOf(fs.fstatSync(fd)) === stampOf(stat) ? bytes.subarray(0, n) : null;
  } finally { fs.closeSync(fd); }
}
class WorkerHttpError extends Error {
  readonly status: number;
  constructor(status: number) { super(`coordinator HTTP ${status}`); this.status = status; }
}

export function coordinatorUrl(input: string): string {
  const u = new URL(input);
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('coordinator URL must be an origin');
  if (u.protocol === 'http:') {
    const a = u.hostname.split('.').map(Number);
    const tailnet = net.isIPv4(u.hostname) && a[0] === 100 && a[1] >= 64 && a[1] <= 127;
    if (!tailnet && u.hostname !== '127.0.0.1' && u.hostname !== '[::1]') throw new Error('HTTP coordinator requires a tailnet or loopback IP');
  } else if (u.protocol !== 'https:') throw new Error('invalid coordinator protocol');
  return u.origin;
}
export function worktrees(project: string): string[] {
  const root = real(project);
  try {
    const out = execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain', '-z'], { timeout: 5000, maxBuffer: 1024 * 1024 });
    const roots = out.toString().split('\0').filter(s => s.startsWith('worktree ')).map(s => s.slice(9));
    return [...new Set(roots.flatMap(p => { try { const r = real(p); return dir(path.join(r, 'hardware-design/boards')) ? [r] : []; } catch { return []; } }))].sort();
  } catch { return dir(path.join(root, 'hardware-design/boards')) ? [root] : []; }
}

interface State { epoch?: string; offsets: Record<string, number>; stamps: Record<string, string>; hashes: Record<string, string>; counters: Record<string, number>; externalRuns?: Record<string, ExternalRun> }
interface Args { project: string; projectId: string; host: string; url: string; tokenFile: string; stateFile: string; interval: number; discover: boolean; once: boolean }

export class Worker {
  readonly root: string; readonly source: string; readonly host: string; readonly projectId: string;
  readonly url: string; readonly token: string; readonly stateFile: string;
  private state: State; private known: Map<string, number>;
  private uploadLimit = MAX_BOARD;
  private recovering = new Set<string>();
  private external = new Map<string, ExternalRun>();
  private modelBusy = false;
  ready = false;
  constructor(a: Args, known = new Map<string, number>()) {
    this.root = real(a.project); this.host = a.host; this.projectId = a.projectId; this.url = coordinatorUrl(a.url);
    this.token = fs.readFileSync(a.tokenFile, 'utf8').trim(); this.stateFile = a.stateFile; this.known = known;
    if (this.token.length < 32) throw new Error('coordinator token is too short');
    this.source = digest(`${this.host}\0${this.projectId}\0${this.root}`);
    this.state = { offsets: {}, stamps: {}, hashes: {}, counters: {} };
    if (file(this.stateFile)) {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Partial<State>;
      this.state = { epoch: raw.epoch, offsets: raw.offsets ?? {}, stamps: raw.stamps ?? {}, hashes: raw.hashes ?? {}, counters: raw.counters ?? {} };
      this.external = new Map(Object.entries(raw.externalRuns ?? {}));
    }
  }
  private save(): void {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(tmp, this.stateFile);
  }
  private async request(endpoint: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers); headers.set('authorization', `Bearer ${this.token}`);
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(this.url + endpoint, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (response.ok) return response;
      if ((response.status === 503 || response.status === 429) && attempt < 6) {
        await response.body?.cancel();
        await sleep(Math.min(3000, 200 * 2 ** attempt) + Math.floor(Math.random() * 250));
        continue;
      }
      throw new WorkerHttpError(response.status);
    }
  }
  private async post(endpoint: string, body: unknown): Promise<unknown> {
    return (await this.request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  }
  async syncEpoch(): Promise<void> {
    const identity = await (await this.request('/live/identity')).json() as { epoch?: unknown; maxSnapshotBytes?: unknown };
    if (typeof identity.epoch !== 'string' || !identity.epoch) throw new Error('invalid coordinator history identity');
    if (typeof identity.maxSnapshotBytes === 'number' && Number.isSafeInteger(identity.maxSnapshotBytes) && identity.maxSnapshotBytes > 0)
      this.uploadLimit = Math.min(MAX_BOARD, identity.maxSnapshotBytes);
    if (this.state.epoch !== identity.epoch) {
      this.state = { epoch: identity.epoch, offsets: {}, stamps: {}, hashes: {}, counters: {} }; this.external.clear(); this.known.clear(); this.save();
    }
    this.ready = true;
  }
  private async upload(hash: string, bytes: Buffer): Promise<void> {
    if (Date.now() - (this.known.get(hash) ?? 0) < 86400_000) return;
    await this.request('/blobs/' + hash, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(bytes) });
    this.known.set(hash, Date.now());
  }
  async retain(): Promise<void> {
    const hashes = [...new Set(Object.values(this.state.hashes))];
    for (let i = 0; i < hashes.length; i += 500) {
      const response = await this.post('/blobs/missing', { sha256: hashes.slice(i, i + 500) }) as { missing: string[] };
      if (!Array.isArray(response.missing)) throw new Error('invalid blob retention response');
      for (const [key, hash] of Object.entries(this.state.hashes)) if (response.missing.includes(hash)) {
        delete this.state.stamps[key]; this.known.delete(hash);
      }
    }
    this.save();
  }
  private async event(eventId: string, board: string, run: string, kind: string, data: unknown): Promise<void> {
    await this.post('/live/events', this.record(eventId, board, run, kind, data));
  }
  private record(eventId: string, board: string, run: string, kind: string, data: unknown): Record<string, unknown> {
    return { source: this.source, eventId, host: this.host, board: `${this.projectId}/${board}`, run, kind, data };
  }
  async heartbeat(): Promise<void> { await this.event('heartbeat:' + randomUUID(), '_host', '_host', 'host.heartbeat', {}); }
  async processModels(): Promise<void> {
    if (this.modelBusy) return;
    this.modelBusy = true;
    try {
      const requests = await (await this.request('/live/models?source=' + encodeURIComponent(this.source))).json() as { id: string; source: string; path: string; boardSha: string }[];
      if (!Array.isArray(requests) || !requests.length) return;
      const request = requests[0];
      if (request.source !== this.source || !/^[0-9a-f-]{36}$/.test(request.id) || !/^[0-9a-f]{64}$/.test(request.boardSha)) throw new Error('invalid 3D request');
      try {
        const response = await this.request('/blobs/' + request.boardSha);
        const length = Number(response.headers.get('content-length') ?? 0);
        if (length > this.uploadLimit) throw new Error('board snapshot exceeds upload limit');
        if (!response.body) throw new Error('empty board snapshot');
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          total += part.value.length;
          if (total > this.uploadLimit) { await reader.cancel(); throw new Error('board snapshot exceeds upload limit'); }
          chunks.push(part.value);
        }
        const bytes = Buffer.concat(chunks, total);
        const model = await exportModel({ root: this.root, boardPath: request.path, boardSha: request.boardSha, bytes, maxBytes: this.uploadLimit });
        const hash = digest(model.bytes); await this.upload(hash, model.bytes);
        await this.post('/live/models/' + request.id, { source: this.source, modelSha: hash, error: model.warning });
      } catch (error) {
        await this.post('/live/models/' + request.id, { source: this.source, error: String(error instanceof Error ? error.message : error).slice(0, 1000) });
      }
    } finally { this.modelBusy = false; }
  }
  private boardOwner(gateId: string): string {
    try {
      const boards = real(path.join(this.root, 'hardware-design/boards'));
      const gate = path.join(boards, gateId, 'gate.json');
      const cfg = JSON.parse(fs.readFileSync(gate, 'utf8')) as { project?: unknown };
      if (typeof cfg.project !== 'string') return gateId;
      const pcb = path.resolve(path.dirname(gate), cfg.project + '.kicad_pcb');
      const resolved = real(pcb);
      if (!within(boards, resolved)) return gateId;
      return path.relative(boards, resolved).split(path.sep)[0] || gateId;
    } catch { return gateId; }
  }
  private boardLockKey(gateId: string): string | null {
    try {
      const boards = real(path.join(this.root, 'hardware-design/boards'));
      const gate = path.join(boards, gateId, 'gate.json');
      const cfg = JSON.parse(fs.readFileSync(gate, 'utf8')) as { project?: unknown };
      if (typeof cfg.project !== 'string') return null;
      const pcb = real(path.resolve(path.dirname(gate), cfg.project + '.kicad_pcb'));
      return within(boards, pcb) ? `${this.projectId}/${path.relative(this.root, pcb).split(path.sep).join('/')}` : null;
    } catch { return null; }
  }
  private async snapshot(p: string, board: string, run = 'saved', kind: 'board.snapshot' | 'candidate.snapshot' = 'board.snapshot'): Promise<void> {
    const st = fs.statSync(p);
    const key = path.relative(this.root, p), stamp = stampOf(st);
    if (this.state.stamps[key] === stamp) return;
    if (!st.size || st.size > this.uploadLimit) {
      await this.event('board-invalid:' + digest(`${key}\0${stamp}`), board, run, 'board.invalid',
        { path: key, error: st.size ? 'Board exceeds the coordinator snapshot limit' : 'Board file is empty' });
      this.state.stamps[key] = stamp; this.save(); return;
    }
    const bytes = stableRead(p, st, this.uploadLimit); if (!bytes) return;
    const hash = digest(bytes);
    try { await this.upload(hash, bytes); }
    catch (error) {
      if (!(error instanceof WorkerHttpError) || error.status !== 413) throw error;
      await this.event('board-too-large:' + digest(`${key}\0${stamp}`), board, run, 'board.invalid', { path: key, error: 'Snapshot exceeds the coordinator upload limit' });
      this.state.stamps[key] = stamp; this.save(); return;
    }
    const id = digest(`${key}\0${stamp}\0${hash}\0${this.state.counters[key] ?? 0}`);
    await this.event('board:' + id, board, run, kind, { sha256: hash, path: key, size: bytes.length, saved: run === 'saved', mtime: st.mtimeMs });
    this.state.stamps[key] = stamp; this.state.hashes[key] = hash; this.save();
  }
  private async preview(p: string, board: string, run: string, kind: 'route.preview' | 'placement.preview', schema: string): Promise<void> {
    const st = fs.statSync(p); if (!st.size || st.size > this.uploadLimit) return;
    const key = path.relative(this.root, p), stamp = stampOf(st);
    if (this.state.stamps[key] === stamp) return;
    const bytes = stableRead(p, st, this.uploadLimit); if (!bytes) return;
    const frame = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>; if (frame.schema !== schema) return;
    if (kind === 'placement.preview' && typeof frame.board_path === 'string' && typeof frame.board_sha256 === 'string') {
      try { const src = real(frame.board_path), stat = fs.statSync(src); if (within(this.root, src) && stat.size <= this.uploadLimit) {
        const base = stableRead(src, stat, this.uploadLimit); if (base && digest(base) === frame.board_sha256) await this.upload(frame.board_sha256, base);
      } } catch { /* keep the preview, but the viewer requires the matching source */ }
    }
    const hash = digest(bytes); await this.upload(hash, bytes);
    await this.event('preview:' + digest(`${key}\0${stamp}\0${hash}`), board, run, kind,
      { sha256: hash, passes: frame.passes ?? null, maxPasses: frame.max_passes ?? null, conflictNets: frame.conflict_nets ?? null,
        conflictPairs: frame.conflict_pairs ?? null, epoch: frame.epoch ?? null, epochs: frame.epochs ?? null,
        cost: frame.cost ?? null, elapsedS: frame.elapsed_s ?? null, baseSha256: frame.board_sha256 ?? null, path: key });
    this.state.stamps[key] = stamp; this.state.hashes[key] = hash; this.save();
  }
  private async placementReplay(outdir: string, cwd: string, board: string, run: string, observedBoard?: string): Promise<boolean> {
    if (!file(path.join(outdir, 'input-manifest.json'))) return true;
    let complete = true;
    const entries = fs.readdirSync(outdir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^step-\d+$/.test(entry.name)) continue;
      const step = path.join(outdir, entry.name), result = path.join(step, 'search/res.json');
      if (!file(result) || !file(path.join(step, 'prob.json'))) continue;
      try {
        const key = `placement-history:${run}:${path.relative(outdir, step)}`, stamp = stampOf(fs.statSync(result));
        if (this.state.stamps[key] === stamp) continue;
        if (this.state.stamps[key + ':input'] !== stamp) { this.state.counters[key] = 0; this.state.stamps[key + ':input'] = stamp; this.save(); }
        const replay = placementHistory(this.root, cwd, outdir, step, observedBoard), boardBytes = fs.readFileSync(replay.board);
        if (digest(boardBytes) !== replay.sha || boardBytes.length > this.uploadLimit) continue;
        const relative = path.relative(this.root, replay.board);
        const index = this.state.counters[key] ?? 0;
        if (index >= replay.frames.length) { this.state.stamps[key] = stamp; this.save(); continue; }
        await this.upload(replay.sha, boardBytes);
        await this.event('history-base:' + digest(`${run}\0${replay.sha}`), board, run, 'board.snapshot', { sha256: replay.sha, path: relative, saved: false });
        for (let i = index; i < Math.min(index + 5, replay.frames.length); i++) {
          const bytes = replay.frames[i]; if (bytes.length > this.uploadLimit) throw new Error('placement frame too large');
          const hash = digest(bytes), frame = JSON.parse(bytes.toString()) as { epoch: number; epochs: number; cost: number };
          await this.upload(hash, bytes);
          await this.event('history:' + digest(`${key}\0${i}\0${hash}`), board, run, 'placement.preview',
            { sha256: hash, baseSha256: replay.sha, epoch: frame.epoch, epochs: frame.epochs, cost: frame.cost, path: key, recorded: true });
          this.state.counters[key] = i + 1; this.save();
        }
        if ((this.state.counters[key] ?? 0) < replay.frames.length) { complete = false; break; }
        this.state.stamps[key] = stamp; this.save();
      } catch (error) {
        // A result may be mid-write or its source may no longer match: never fabricate a frame.
        if ((error instanceof WorkerHttpError && (error.status === 429 || error.status >= 500)) ||
            error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError')) complete = false;
        if (!['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '') && !(error instanceof SyntaxError)) console.error('pcb live placement replay:', error instanceof Error ? error.message : String(error));
      }
    }
    return complete;
  }
  private async lines(p: string, board: string, run: string, kind: string, plainStage?: string): Promise<void> {
    const key = path.relative(this.root, p), fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd); if (!stat.isFile()) return;
      const size = stat.size; let offset = this.state.offsets[key] ?? 0;
      if (offset > size) offset = 0;
      if (plainStage && !(key in this.state.offsets) && size > 128 * 1024) {
        offset = size - 128 * 1024;
        const bytes = Buffer.allocUnsafe(Math.min(64 * 1024, size - offset)), n = fs.readSync(fd, bytes, 0, bytes.length, offset);
        const newline = bytes.subarray(0, n).indexOf(10);
        if (newline < 0) return;
        offset += newline + 1;
      }
      const pending: Record<string, unknown>[] = [];
      while (pending.length < 20 && offset < size) {
        const start = offset, hash = createHash('sha256'), chunks: Buffer[] = [];
        let length = 0, complete = false, cursor = offset;
        while (cursor < size) {
          const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size - cursor));
          const n = fs.readSync(fd, buffer, 0, buffer.length, cursor); if (!n) break;
          const newline = buffer.subarray(0, n).indexOf(10), take = newline < 0 ? n : newline + 1;
          const chunk = buffer.subarray(0, take); hash.update(chunk); length += take; cursor += take;
          if (length <= MAX_LINE) chunks.push(Buffer.from(chunk));
          if (newline >= 0) { complete = true; break; }
        }
        if (!complete) break;
        const lineHash = hash.digest('hex'); let value: unknown;
        try {
          value = length > MAX_LINE ? { type: 'run.event_oversize', bytes: length, sha256: lineHash }
            : plainStage ? { type: 'tool.output', stage: plainStage, text: Buffer.concat(chunks).toString('utf8').trimEnd() }
              : JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
        catch { value = { type: 'run.event_invalid', bytes: length, sha256: lineHash }; }
        if (!isObject(value)) value = { type: 'run.event_invalid', bytes: length, sha256: lineHash };
        if (kind === 'external.stage' && isObject(value)) value = { type: 'stage.end', stage: value.stage, status: value.status, cause: value.cause, duration_s: value.wall_s };
        const eventKind = kind === 'external.stage' ? 'run.event' : kind === 'agent.update' && isObject(value) && value.state === 'message' ? 'agent.message' : kind;
        pending.push(this.record('run:' + digest(`${key}:${start}:${lineHash}`), board, run, eventKind, value));
        offset = cursor;
      }
      if (pending.length) { await this.post('/live/events/batch', pending); this.state.offsets[key] = offset; this.save(); }
    } finally { fs.closeSync(fd); }
  }
  private async run(folder: string, guardedRuns: Set<string>): Promise<void> {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'run.json'), 'utf8')) as Record<string, unknown>;
      if (typeof manifest.board !== 'string' || !manifest.board) return;
      const gateId = manifest.board, board = this.boardOwner(gateId), name = path.basename(folder), statePath = path.join(folder, 'state.json');
      if (file(statePath)) {
        const st = fs.statSync(statePath), state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
        let alive: boolean | null = null;
        if (typeof state.worker_pid === 'number' && Number.isSafeInteger(state.worker_pid) && state.worker_pid > 0) {
          try { process.kill(state.worker_pid, 0); alive = typeof state.updated_unix === 'number' && Date.now() / 1000 - state.updated_unix < 45; }
          catch (e) { alive = (e as NodeJS.ErrnoException).code === 'ESRCH' ? false : null; }
        }
        const coordinated = guardedRuns.has(name);
        const key = path.relative(this.root, statePath), stamp = `${stampOf(st)}:${alive}:${coordinated}:v2`;
        if (this.state.stamps[key] !== stamp) {
          const fields = ['status', 'elapsed_s', 'updated_unix', 'active_stages', 'active_stage_timing', 'last_activity_s', 'last_progress_s', 'cause', 'metrics', 'exit_code'];
          const summary = Object.fromEntries(fields.filter(k => k in state).map(k => [k, state[k]]));
          Object.assign(summary, { operation: manifest.operation ?? 'unknown', router: manifest.router ?? null, gate: gateId,
            timeoutS: manifest.timeout_s ?? null, supervisorAlive: alive, coordinated, boardKey: this.boardLockKey(gateId) });
          await this.event('state:' + digest(`${key}\0${stamp}`), board, name, 'run.state', summary);
          this.state.stamps[key] = stamp; this.save();
        }
      }
      const routeBase = path.join(folder, 'live-route-base.kicad_pcb'); if (file(routeBase)) await this.snapshot(routeBase, board, name);
      for (const [filename, kind, schema] of [
        ['live-route.json', 'route.preview', 'iot-lab.route-preview.v1'],
        ['live-place.json', 'placement.preview', 'iot-lab.placement-preview.v1']
      ] as const) { const p = path.join(folder, filename); if (file(p)) await this.preview(p, board, name, kind, schema); }
      const gate = path.join(folder, 'workspace/hardware-design/boards', gateId, 'gate.json');
      if (file(gate)) {
        const g = JSON.parse(fs.readFileSync(gate, 'utf8')) as { project?: unknown };
        if (typeof g.project === 'string') {
          const workspace = real(path.join(folder, 'workspace')), candidate = path.resolve(path.dirname(gate), g.project + '.kicad_pcb');
          const running = !file(path.join(folder, 'result.json'));
          if (running && file(candidate) && within(workspace, real(candidate))) await this.snapshot(real(candidate), board, name);
          // Existing placement pipelines write real intermediate boards under operation/work. Observe only the
          // newest same-named candidate; never treat it as a verified result or follow directory symlinks.
          const work = path.join(folder, 'operation/work'), expected = path.basename(candidate);
          let newest: { file: string; mtime: number } | null = null, visited = 0;
          const walk = (d: string): void => {
            if (!dir(d) || ++visited > 5000) return;
            for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
              const p = path.join(d, entry.name);
              if (entry.isDirectory()) walk(p);
              else if (entry.isFile() && entry.name === expected) {
                try { const st = fs.statSync(p); if (!newest || st.mtimeMs > newest.mtime) newest = { file: p, mtime: st.mtimeMs }; } catch { /* removed while scanning */ }
              }
            }
          };
          if (running) walk(work);
          if (running && newest) await this.snapshot((newest as { file: string }).file, board, name, 'candidate.snapshot');
          const histories: string[] = []; let directories = 0;
          const search = (d: string, depth: number): void => {
            if (!dir(d) || depth > 5 || ++directories > 5000) return;
            if (file(path.join(d, 'input-manifest.json'))) histories.push(d);
            for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory() && !/^step-\d+$/.test(e.name)) search(path.join(d, e.name), depth + 1);
          };
          search(work, 0);
          for (const history of histories) await this.placementReplay(history, workspace, board, name);
        }
      }
      for (const [nameOfFile, kind] of [['events.jsonl', 'run.event'], ['notes.jsonl', 'run.note']] as const) {
        const p = path.join(folder, nameOfFile); if (file(p)) await this.lines(p, board, name, kind);
      }
    } catch (error) { if (!['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
  async scanExternal(runs: ExternalRun[]): Promise<void> {
    const present = new Set(runs.map(r => r.runId));
    for (const [id, old] of this.external) if (!present.has(id)) {
      let stopped = false;
      try { process.kill(old.pid, 0); } catch (error) { stopped = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      if (stopped) {
        await this.event('external-stop:' + id, old.board, id, 'run.state', { status: 'stopped', operation: 'placement',
          cause: 'Process ended; its outcome has not been verified', supervisorAlive: false, coordinated: false, elapsed_s: old.elapsed, timeoutS: old.timeout });
        if (await this.placementReplay(old.outdir, this.root, old.board, id, old.boardFile)) {
          this.external.delete(id);
          this.state.externalRuns = Object.fromEntries(this.external); this.save();
        }
      }
    }
    for (const run of runs) {
      this.external.set(run.runId, run);
      const elapsed = Math.floor(run.elapsed / 15) * 15, stateKey = `external:${run.runId}`;
      const stamp = `${run.stage}:${elapsed}:v2`;
      if (this.state.stamps[stateKey] !== stamp) {
        await this.event('external-state:' + digest(`${stateKey}\0${stamp}`), run.board, run.runId, 'run.state',
          { status: 'running', operation: 'placement', active_stages: [run.stage], elapsed_s: elapsed,
            timeoutS: run.timeout, supervisorAlive: true, coordinated: false, boardKey: this.boardLockKey(run.board), cause: 'Direct toolchain process; outcome is not yet known' });
        this.state.stamps[stateKey] = stamp; this.state.externalRuns = Object.fromEntries(this.external); this.save();
      }
      const stageLog = path.join(run.outdir, 'stages.jsonl');
      if (file(stageLog)) await this.lines(stageLog, run.board, run.runId, 'external.stage');
      await this.placementReplay(run.outdir, this.root, run.board, run.runId, run.boardFile);
      let visited = 0;
      const candidates: { file: string; mtime: number }[] = [], logs: { file: string; mtime: number; stage: string }[] = [];
      const basename = path.basename(run.boardFile);
      const walk = (dirPath: string): void => {
        if (!dir(dirPath) || ++visited > 5000) return;
        for (const e of fs.readdirSync(dirPath, { withFileTypes: true })) {
          const p = path.join(dirPath, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.isFile() && (e.name === basename || ['search.log', 'route.log', 'route-0.log'].includes(e.name))) {
            try {
              const st = fs.statSync(p);
              if (e.name === basename) candidates.push({ file: p, mtime: st.mtimeMs });
              else logs.push({ file: p, mtime: st.mtimeMs, stage: e.name === 'search.log' ? 'placement' : 'routing' });
            } catch { /* file changed during inspection */ }
          }
        }
      };
      walk(run.outdir);
      candidates.sort((a, b) => b.mtime - a.mtime);
      if (candidates[0]) await this.snapshot(candidates[0].file, run.board, run.runId, 'candidate.snapshot');
      logs.sort((a, b) => b.mtime - a.mtime);
      for (const log of logs.slice(0, 3)) await this.lines(log.file, run.board, run.runId, 'run.event', log.stage);
    }
  }
  async scanActivity(): Promise<void> {
    const guards = path.join(this.root, '.gate/live-guards'), guardedRuns = new Set<string>();
    if (dir(guards)) for (const entry of fs.readdirSync(guards, { withFileTypes: true })) if (entry.isFile() && entry.name.endsWith('.json')) {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(guards, entry.name), 'utf8')) as { root?: string; runId?: string };
        if (record.root === this.root && typeof record.runId === 'string') guardedRuns.add(record.runId);
      } catch { /* incomplete receipt is not proof of coordination */ }
    }
    const runs = path.join(this.root, '.gate/cli');
    if (dir(runs)) {
      const entries = fs.readdirSync(runs, { withFileTypes: true }).filter(e => e.isDirectory() && e.name.startsWith('run-'));
      const changed = (name: string): number => { try { return fs.statSync(path.join(runs, name, 'state.json')).mtimeMs; } catch { return 0; } };
      entries.sort((a, b) => changed(b.name) - changed(a.name));
      for (const e of entries) await this.run(path.join(runs, e.name), guardedRuns);
    }
    const agents = path.join(this.root, '.gate/live-agent');
    if (dir(agents)) for (const e of fs.readdirSync(agents, { withFileTypes: true })) if (e.isDirectory()) {
      const p = path.join(agents, e.name, 'events.jsonl'); if (file(p)) await this.lines(p, e.name, '_agent', 'agent.update');
    }
    const previews = path.join(this.root, '.gate/live-previews');
    if (dir(previews)) for (const e of fs.readdirSync(previews, { withFileTypes: true })) if (e.isDirectory()) {
      const folder = path.join(previews, e.name), manifest = path.join(folder, 'run.json');
      if (!file(manifest)) continue;
      try {
        const run = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { board?: unknown; runId?: unknown };
        if (typeof run.board !== 'string' || typeof run.runId !== 'string') continue;
        const base = path.join(folder, 'live-route-base.kicad_pcb');
        const board = this.boardOwner(run.board);
        if (file(base)) await this.snapshot(base, board, run.runId);
        const route = path.join(folder, 'live-route.json');
        if (file(route)) await this.preview(route, board, run.runId, 'route.preview', 'iot-lab.route-preview.v1');
        const placement = path.join(folder, 'live-place.json');
        if (file(placement)) await this.preview(placement, board, run.runId, 'placement.preview', 'iot-lab.placement-preview.v1');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (dir(guards)) for (const entry of fs.readdirSync(guards, { withFileTypes: true })) {
      const receipt = path.join(guards, entry.name);
      if (!entry.isFile() || !entry.name.endsWith('.json') || this.recovering.has(receipt)) continue;
      try {
        const record = JSON.parse(fs.readFileSync(receipt, 'utf8')) as { root?: string; operation?: string; runId?: string; runDir?: string };
        if (record.root !== this.root || !record.runId || !record.runDir) continue;
        const result = JSON.parse(fs.readFileSync(path.join(record.runDir, 'result.json'), 'utf8')) as { cleanup?: { complete?: boolean } };
        if (result.cleanup?.complete !== true) continue;
        const guard = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pcb-live-guard.mts');
        this.recovering.add(receipt);
        const child = spawn(process.execPath, ['--no-warnings', '--experimental-strip-types', guard, '--guardian', receipt], { detached: true, stdio: 'ignore' });
        child.once('exit', () => this.recovering.delete(receipt)); child.once('error', () => this.recovering.delete(receipt)); child.unref();
      } catch { /* incomplete or unconfirmed work stays pinned */ }
    }
  }
  async scanBoards(): Promise<void> {
    const boards = path.join(this.root, 'hardware-design/boards'), seen = new Set<string>();
    let budget = 20; // let active runs get another scan while an initial inventory is uploading
    if (dir(boards)) for (const board of fs.readdirSync(boards, { withFileTypes: true })) if (board.isDirectory()) {
      const cad = path.join(boards, board.name, 'cad');
      const walk = async (d: string): Promise<void> => {
        if (!dir(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) await walk(p);
          else if (e.isFile() && e.name.endsWith('.kicad_pcb')) {
            const key = path.relative(this.root, p); seen.add(key);
            try {
              const st = fs.statSync(p), changed = this.state.stamps[key] !== stampOf(st);
              if (changed && budget > 0) { budget--; await this.snapshot(p, board.name); }
            }
            catch (error) { if (!['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
          }
        }
      };
      await walk(cad);
    }
    for (const key of Object.keys(this.state.hashes)) if (key.startsWith('hardware-design/boards/') && key.endsWith('.kicad_pcb') && !seen.has(key)) {
      const counter = (this.state.counters[key] ?? 0) + 1, board = key.split('/')[2];
      await this.event('removed:' + digest(`${key}\0${counter}`), board, 'saved', 'board.removed', { path: key });
      this.state.counters[key] = counter; delete this.state.stamps[key]; delete this.state.hashes[key]; this.save();
    }
  }
  async scan(): Promise<void> { await this.scanActivity(); await this.scanBoards(); }
}

async function main(): Promise<void> {
  const { values: v } = parseArgs({ options: { project: { type: 'string' }, 'project-id': { type: 'string' }, host: { type: 'string' },
    url: { type: 'string' }, 'token-file': { type: 'string' }, 'state-file': { type: 'string' }, interval: { type: 'string' },
    'discover-worktrees': { type: 'boolean' }, once: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (v.help) { console.log('pcb-live-worker --project DIR --project-id ID --url ORIGIN --token-file FILE --state-file FILE [--discover-worktrees]'); return; }
  if (!v.project || !v['project-id'] || v['project-id'].includes('/') || !v.url || !v['token-file'] || !v['state-file'])
    throw new Error('requires --project, --project-id, --url, --token-file and --state-file');
  const interval = Number(v.interval ?? '3'); if (!Number.isFinite(interval) || interval < 1) throw new Error('interval must be at least 1 second');
  const args: Args = { project: v.project, projectId: v['project-id'], host: v.host ?? os.hostname(), url: v.url,
    tokenFile: v['token-file'], stateFile: v['state-file'], interval, discover: !!v['discover-worktrees'], once: !!v.once };
  const shared = new Map<string, number>(); let workers = new Map<string, Worker>(), discoverAt = 0, epochAt = 0, retainAt = 0, heartbeatAt = 0, externalAt = 0;
  let sendingHeartbeat = false;
  let inventoryBusy = false;
  const inventory = async (): Promise<void> => {
    if (inventoryBusy) return;
    inventoryBusy = true;
    try {
      const queue = [...workers.values()].filter(worker => worker.ready);
      await Promise.all(Array.from({ length: Math.min(2, queue.length) }, async () => {
        while (queue.length) {
          const worker = queue.shift(); if (!worker) break;
          try { await worker.scanBoards(); }
          catch (error) { console.error('pcb live inventory:', error instanceof Error ? error.message : String(error)); }
        }
      }));
    } finally { inventoryBusy = false; }
  };
  const heartbeat = async (): Promise<void> => {
    if (sendingHeartbeat) return;
    sendingHeartbeat = true;
    try { for (const worker of workers.values()) await worker.heartbeat(); }
    catch (error) { console.error('pcb live heartbeat:', error instanceof Error ? error.message : String(error)); }
    finally { sendingHeartbeat = false; }
  };
  if (!args.once) setInterval(() => { void heartbeat(); }, 15000).unref();
  if (!args.once) setInterval(() => { void inventory(); }, 3000).unref();
  if (!args.once) setInterval(() => {
    for (const worker of workers.values()) void worker.processModels().catch(error => console.error('pcb live 3D:', error instanceof Error ? error.message : String(error)));
  }, 5000).unref();
  for (;;) {
    try {
      const now = Date.now();
      if (now >= discoverAt) {
        const roots = args.discover ? worktrees(args.project) : [real(args.project)], next = new Map<string, Worker>();
        for (const root of roots) {
          const suffix = digest(root).slice(0, 12), state = args.discover ? `${args.stateFile}.${suffix}` : args.stateFile;
          next.set(root, workers.get(root) ?? new Worker({ ...args, project: root, stateFile: state,
            host: args.discover ? `${args.host} (${path.basename(root)}, ${suffix.slice(0, 6)})` : args.host }, shared));
        }
        workers = next; discoverAt = now + 30000;
      }
      if (now >= epochAt) { for (const worker of workers.values()) await worker.syncEpoch(); epochAt = Date.now() + 15000; }
      if (!args.once) void inventory();
      if (now >= retainAt) { for (const worker of workers.values()) await worker.retain(); retainAt = Date.now() + 86400_000; }
      if (Date.now() >= heartbeatAt) { await heartbeat(); heartbeatAt = Date.now() + 15000; }
      if (Date.now() >= externalAt) {
        const external = discoverExternal([...workers.keys()]);
        if (external) for (const [root, worker] of workers) await worker.scanExternal(external.filter(run => run.root === root));
        externalAt = Date.now() + 6000;
      }
      for (const worker of workers.values()) await worker.scanActivity();
      if (args.once) for (const worker of workers.values()) await worker.scanBoards();
      for (const worker of workers.values()) void worker.processModels().catch(error => console.error('pcb live 3D:', error instanceof Error ? error.message : String(error)));
    } catch (error) {
      if (args.once) throw error;
      console.error('pcb live worker:', error instanceof Error ? error.message : String(error));
    }
    if (args.once) return;
    await sleep(args.interval * 1000);
  }
}
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) void main().catch(e => { console.error(e); process.exitCode = 1; });
