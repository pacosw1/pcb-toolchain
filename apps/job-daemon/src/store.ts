import fs from 'node:fs';
import path from 'node:path';
import type { JobRecord } from './types.ts';

/**
 * The durable job record. jobs/<id>/ holds:
 *   job.json        the record, replaced atomically; the only state the daemon needs after a restart
 *   events.jsonl    append-only state log, read by the status stream
 *   input.tar.gz    the submitted files; each attempt unpacks a fresh copy, inside its container
 *   attempts/<n>/   root-owned; the job cannot reach this folder
 *     work/         mounted at /job, owned by the job; removed when the attempt ends
 *     out/          mounted at /job/out, so out itself is a mount point the job cannot replace with a symlink
 *
 * Everything in work/ and out/ is hostile: the daemon runs as root and the job writes there. The daemon never takes
 * a verdict from those files, and never walks or deletes them in this process. It reads one file, out/job.log,
 * through openNoFollow(), sizes them with du, and deletes them through Runtime.cleanAttempt.
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
  blobsDir = (): string => path.join(this.root, 'blobs');
  jobDir = (id: string): string => path.join(this.jobsDir(), id);
  inputTar = (id: string): string => path.join(this.jobDir(id), 'input.tar.gz');
  eventsFile = (id: string): string => path.join(this.jobDir(id), 'events.jsonl');
  attemptDir = (id: string, n: number): string => path.join(this.jobDir(id), 'attempts', String(n));
  workDir = (id: string, n: number): string => path.join(this.attemptDir(id, n), 'work');
  outDir = (id: string, n: number): string => path.join(this.attemptDir(id, n), 'out');
  logFile = (id: string, n: number): string => path.join(this.outDir(id, n), 'job.log');

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

  /** Call only after the cleaner has emptied every attempt: what is left is the daemon's own files. */
  async remove(id: string): Promise<void> {
    await fs.promises.rm(this.jobDir(id), { recursive: true, force: true });
  }
}

/**
 * Opens a file the job may have tampered with. O_NOFOLLOW refuses a symlink in the last component (the folders above
 * it are not the job's), O_NONBLOCK keeps a FIFO from blocking the open, and fstat checks the object that was opened,
 * not the name, so there is no window between the check and the read. Returns null when there is nothing to read.
 */
export function openNoFollow(file: string): number | null {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  let fd: number;
  try {
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch {
    return null;
  }
  if (fs.fstatSync(fd).isFile()) return fd;
  fs.closeSync(fd);
  return null;
}
