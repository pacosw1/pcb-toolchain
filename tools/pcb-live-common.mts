// Shared configuration and authenticated coordinator calls for the TypeScript CLI guard.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { coordinatorUrl } from './pcb-live-worker.mts';

export interface LiveConfig { url: string; tokenFile: string; projects?: Record<string, string>; cliPath?: string }
export interface Lease { board: string; owner: string; generation: number; token: string; expiresAt: number }
export interface Revision { sha256: string; generation: number; revision: number }
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const home = (s: string): string => s.startsWith('~/') ? path.join(os.homedir(), s.slice(2)) : s;
export function configFile(): string { return home(process.env.PCB_LIVE_CONFIG ?? '~/.config/pcb-live/config.json'); }
export function loadConfig(): LiveConfig | null {
  const file = configFile(); if (!fs.existsSync(file)) return null;
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as LiveConfig;
  if (typeof cfg.url !== 'string' || typeof cfg.tokenFile !== 'string' || (cfg.projects !== undefined && (!cfg.projects || typeof cfg.projects !== 'object' || Array.isArray(cfg.projects))))
    throw new Error('invalid PCB live configuration');
  return { ...cfg, url: coordinatorUrl(cfg.url), tokenFile: home(cfg.tokenFile) };
}
export function projectId(root: string, config: LiveConfig | null): string | null {
  root = fs.realpathSync(root);
  const markerPath = path.join(root, '.pcb-live.json');
  const hasMarker = fs.existsSync(markerPath);
  const marker = hasMarker ? (JSON.parse(fs.readFileSync(markerPath, 'utf8')) as { projectId?: unknown }).projectId : undefined;
  if (hasMarker && (typeof marker !== 'string' || !marker || marker.includes('/'))) throw new Error('invalid PCB live project marker');
  let registered: unknown;
  if (config?.projects) {
    try {
      const common = execFileSync('git', ['-C', root, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      registered = config.projects[fs.realpathSync(path.resolve(root, common))];
    } catch { /* project without a Git common directory */ }
  }
  if (marker !== undefined && registered !== undefined && marker !== registered) throw new Error('project marker conflicts with registered project ID');
  const id = marker ?? registered;
  if (id === undefined) return null;
  if (typeof id !== 'string' || !id || id.includes('/')) throw new Error('invalid PCB live project ID');
  if (!config) throw new Error('live coordination is registered but its configuration is missing');
  return id;
}
export function boardPath(root: string, board: string): string {
  if (!/^[A-Z0-9][A-Z0-9-]*$/.test(board)) throw new Error('invalid board ID');
  root = fs.realpathSync(root);
  const boards = fs.realpathSync(path.join(root, 'hardware-design/boards'));
  const gate = path.join(boards, board, 'gate.json');
  const config = JSON.parse(fs.readFileSync(gate, 'utf8')) as { project?: unknown };
  if (typeof config.project !== 'string' || !config.project) throw new Error('gate has no project');
  const project = path.resolve(path.dirname(gate), config.project);
  const parsed = path.parse(project), pcb = fs.realpathSync(path.join(parsed.dir, parsed.name + '.kicad_pcb'));
  if (!pcb.startsWith(boards + path.sep)) throw new Error('board escapes the board registry');
  return pcb;
}
export class Coordinator {
  private readonly url: string; private readonly token: string;
  constructor(cfg: LiveConfig) {
    this.url = cfg.url; this.token = fs.readFileSync(cfg.tokenFile, 'utf8').trim();
    if (this.token.length < 32) throw new Error('coordinator token is too short');
  }
  async request<T>(method: string, endpoint: string, value?: unknown): Promise<T> {
    const response = await fetch(this.url + endpoint, { method, headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: value === undefined ? undefined : JSON.stringify(value), redirect: 'error', signal: AbortSignal.timeout(15000) });
    const result = await response.json() as T & { error?: string };
    if (!response.ok) throw new HttpError(response.status, result.error ?? `coordinator HTTP ${response.status}`);
    return result;
  }
  acquire(board: string, owner: string): Promise<Lease> { return this.request('POST', '/board-leases/acquire', { board, owner, ttlMs: 30000 }); }
  begin(lease: Lease): Promise<unknown> { return this.request('POST', '/board-leases/commit-begin', { lease }); }
  end(lease: Lease): Promise<unknown> { return this.request('POST', '/board-leases/commit-end', { lease }); }
  release(lease: Lease): Promise<unknown> { return this.request('POST', '/board-leases/release', { lease }); }
  status(board: string): Promise<{ generation: number; commitGeneration: number | null } | null> {
    return this.request('GET', '/board-leases/status?board=' + encodeURIComponent(board));
  }
  metadata(board: string): Promise<Revision | null> { return this.request('GET', '/board-revisions?board=' + encodeURIComponent(board)); }
  publish(lease: Lease, expected: number | null, content: Buffer): Promise<Revision> {
    return this.request('POST', '/board-revisions', { lease, expected, content: content.toString('base64') });
  }
}
