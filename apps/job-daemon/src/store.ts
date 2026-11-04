import fs from 'node:fs';
import path from 'node:path';
import type { JobRecord } from './types.ts';

/**
 * The durable job record. jobs/<id>/ holds:
 *   job.json        the record, replaced atomically; the only state the daemon needs after a restart
 *   events.jsonl    append-only state log, read by the status stream
 *   input.tar.gz    the submitted files; each attempt extracts a fresh copy
 *   attempts/<n>/   the job folder of attempt n; after the attempt only out/ and .exit-code stay
 */
export class Store {
  root: string;

  constructor(dataDir: string) {
    this.root = dataDir;
    fs.mkdirSync(this.jobsDir(), { recursive: true });
    fs.rmSync(this.incomingDir(), { recursive: true, force: true }); // uploads cut off by a restart
    fs.mkdirSync(this.incomingDir(), { recursive: true });
  }

  jobsDir = (): string => path.join(this.root, 'jobs');
  incomingDir = (): string => path.join(this.root, 'incoming');
  jobDir = (id: string): string => path.join(this.jobsDir(), id);
  inputTar = (id: string): string => path.join(this.jobDir(id), 'input.tar.gz');
  eventsFile = (id: string): string => path.join(this.jobDir(id), 'events.jsonl');
  attemptDir = (id: string, n: number): string => path.join(this.jobDir(id), 'attempts', String(n));
  logFile = (id: string, n: number): string => path.join(this.attemptDir(id, n), 'out', 'job.log');
  markerFile = (id: string, n: number): string => path.join(this.attemptDir(id, n), '.exit-code');

  /** Atomic and fsynced: after a crash job.json is the old record or the new one, never a torn one. */
  save(job: JobRecord): void {
    const dir = this.jobDir(job.id);
    const tmp = path.join(dir, 'job.json.tmp');
    const fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, JSON.stringify(job, null, 2) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, path.join(dir, 'job.json'));
    const dfd = fs.openSync(dir, 'r');
    fs.fsyncSync(dfd);
    fs.closeSync(dfd);
  }

  appendEvent(id: string, event: Record<string, unknown>): void {
    fs.appendFileSync(this.eventsFile(id), JSON.stringify(event) + '\n');
  }

  /** A folder without a job.json is a submit that never finished: the job was never accepted, so it is removed. */
  loadAll(): JobRecord[] {
    const jobs: JobRecord[] = [];
    for (const id of fs.readdirSync(this.jobsDir())) {
      const file = path.join(this.jobDir(id), 'job.json');
      if (!fs.existsSync(file)) {
        fs.rmSync(this.jobDir(id), { recursive: true, force: true });
        continue;
      }
      jobs.push(JSON.parse(fs.readFileSync(file, 'utf8')) as JobRecord);
    }
    return jobs.sort((a, b) => a.seq - b.seq);
  }

  readMarker(id: string, n: number): number | null {
    try {
      const v = Number.parseInt(fs.readFileSync(this.markerFile(id, n), 'utf8').trim(), 10);
      return Number.isNaN(v) ? null : v;
    } catch {
      return null;
    }
  }

  /** Keeps out/ and the marker of a finished attempt; the rest is a copy of the input. */
  trimAttempt(id: string, n: number): void {
    const dir = this.attemptDir(id, n);
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (name !== 'out' && name !== '.exit-code') fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  }

  remove(id: string): void {
    fs.rmSync(this.jobDir(id), { recursive: true, force: true });
  }
}
