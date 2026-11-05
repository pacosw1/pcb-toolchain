// The coordinator can relay a remote route after its originating client disconnects.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BlobStore } from './blobs.ts';
import { LiveEvents } from './live-events.ts';
import type { LiveEvent } from './live-events.ts';
import { JobManager } from './manager.ts';

const LIMIT = 20 * 1024 * 1024;
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
function stable(file: string): Buffer | null {
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch { return null; }
  try {
    const a = fs.fstatSync(fd); if (!a.isFile() || !a.size || a.size > LIMIT) return null;
    const buf = Buffer.allocUnsafe(a.size + 1); let n = 0;
    while (n < buf.length) { const read = fs.readSync(fd, buf, n, buf.length - n, n); if (!read) break; n += read; }
    const b = fs.fstatSync(fd);
    return n === a.size && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino ? buf.subarray(0, n) : null;
  } finally { fs.closeSync(fd); }
}

export class LiveJobBridge {
  private seen = new Map<string, string>();
  private mgr: JobManager; private live: LiveEvents; private blobs: BlobStore;
  constructor(mgr: JobManager, live: LiveEvents, blobs: BlobStore) { this.mgr = mgr; this.live = live; this.blobs = blobs; }
  private relayLog(binding: LiveEvent, id: string, attempt: number): boolean {
    let fd: number;
    try { fd = fs.openSync(this.mgr.store.logFile(id, attempt), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch { return true; }
    try {
      const stat = fs.fstatSync(fd); if (!stat.isFile()) return true;
      let offset = this.live.jobOffset(id, attempt); if (offset > stat.size) offset = 0;
      const bytes = Buffer.alloc(Math.min(65536, stat.size - offset));
      fs.readSync(fd, bytes, 0, bytes.length, offset);
      const events = []; let position = 0;
      while (events.length < 20) {
        const newline = bytes.indexOf(10, position); if (newline < 0) break;
        const line = bytes.subarray(position, newline), start = offset + position;
        const placement = (binding.data as { operation?: unknown })?.operation === 'placement';
        events.push({ source: binding.source, host: binding.host, board: binding.board, run: binding.run,
          eventId: `remote-log:${placement ? 'placement:' : ''}${id}:${attempt}:${start}:${sha(line)}`, kind: 'run.event',
          data: { type: 'tool.output', stage: placement ? 'placement' : 'routing',
            text: line.toString('utf8').slice(0, 48000), executor: 'coordinator' } });
        position = newline + 1;
      }
      if (events.length) { this.live.appendBatch(events); offset += position; this.live.setJobOffset(id, attempt, offset); }
      else if (bytes.length === 65536) {
        // An oversized line must not prevent later complete lines from being observed.
        offset += bytes.length; this.live.setJobOffset(id, attempt, offset);
      }
      return offset >= stat.size || (bytes.length < 65536 && position === 0);
    } finally { fs.closeSync(fd); }
  }
  scan(): void {
    for (const binding of this.live.jobBindings()) {
      const id = (binding.data as { jobId?: unknown })?.jobId;
      if (typeof id !== 'string') continue;
      const job = this.mgr.jobs.get(id); if (!job) continue;
      const attempt = job.attempts.at(-1);
      const terminal = ['passed', 'failed', 'cancelled'].includes(job.state);
      const operation = (binding.data as { operation?: unknown })?.operation === 'placement' ? 'placement' : 'route';
      const state = `${job.state}:${attempt?.n ?? 0}:${operation}${terminal ? '' : ':' + Math.floor(Date.now() / 15000)}`, key = `${binding.source}\0${binding.run}\0${id}`;
      if (terminal && this.seen.get(key + ':done') === state) continue;
      if (this.seen.get(key + ':state') !== state) {
        this.live.append({ source: binding.source, host: binding.host, board: binding.board, run: binding.run,
          eventId: `remote-state-v2:${id}:${state}`, kind: 'remote.state', data: { jobId: id, status: job.state, attempt: attempt?.n ?? 0, operation } });
        this.seen.set(key + ':state', state);
      }
      if (!attempt) { if (terminal) this.seen.set(key + ':done', state); continue; }
      const logDone = this.relayLog(binding, id, attempt.n);
      const folder = this.mgr.store.outDir(id, attempt.n);
      for (const kind of ['route', 'placement'] as const) {
        const stem = kind === 'route' ? 'route' : 'place', baseFile = path.join(folder, `live-${stem}-base.kicad_pcb`), frameFile = path.join(folder, `live-${stem}.json`);
        let stamp = '';
        try { const a = fs.lstatSync(baseFile), b = fs.lstatSync(frameFile); stamp = `${attempt.n}:${a.ino}:${a.size}:${a.mtimeMs}:${b.ino}:${b.size}:${b.mtimeMs}`; } catch { /* files have not appeared */ }
        if (stamp && this.seen.get(key + `:${kind}:stamp`) === stamp) continue;
        const base = stable(baseFile), frame = stable(frameFile); if (!base || !frame) continue;
        let data: Record<string, unknown>;
        try { data = JSON.parse(frame.toString('utf8')); } catch { continue; }
        const baseHash = sha(base), frameHash = sha(frame);
        if (!data || typeof data !== 'object' || data.schema !== `iot-lab.${kind}-preview.v1` || data.board_sha256 !== baseHash) continue;
        if (this.seen.get(key + `:${kind}:frame`) === frameHash) continue;
        this.blobs.putBytes(base); this.blobs.putBytes(frame);
        const route = kind === 'route';
        this.live.appendBatch([
          { source: binding.source, host: binding.host, board: binding.board, run: binding.run,
            eventId: `remote-${route ? '' : 'placement-'}base:${id}:${attempt.n}:${baseHash}`, kind: 'board.snapshot',
            data: { sha256: baseHash, path: `remote/${id}/${route ? 'base' : 'placement-base'}.kicad_pcb`, saved: false } },
          { source: binding.source, host: binding.host, board: binding.board, run: binding.run,
            eventId: `remote-${route ? '' : 'placement-'}frame:${id}:${attempt.n}:${frameHash}`, kind: `${kind}.preview`,
            data: route ? { sha256: frameHash, baseSha256: baseHash, path: `remote/${id}/route.json`, passes: data.passes ?? null,
              maxPasses: data.max_passes ?? null, conflictNets: data.conflict_nets ?? null, conflictPairs: data.conflict_pairs ?? null, executor: 'coordinator' }
              : { sha256: frameHash, baseSha256: baseHash, path: `remote/${id}/placement.json`, epoch: data.epoch ?? null,
                epochs: data.epochs ?? null, cost: data.cost ?? null, executor: 'coordinator' } }
        ]);
        this.seen.set(key + `:${kind}:frame`, frameHash); this.seen.set(key + `:${kind}:stamp`, stamp);
      }
      if (terminal && logDone) this.seen.set(key + ':done', state);
    }
  }
}
