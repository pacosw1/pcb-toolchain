// One benchmark at a time per machine: an OS flock on a file (tools/lib/file-lock.ts). Liveness is the
// open file description, so a crash releases the lock at once: there is no ownerless window, no pid to
// reuse, and two waiters can never both take a dead owner's lock. The owner JSON is display metadata only.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { holdLock, LockBusyError } from './file-lock.ts';

export const DEFAULT_LOCK = process.env.BENCH_LOCK ?? join(tmpdir(), 'opencode', 'bench.lock');

export interface Owner { pid: number; started: string; label: string; cwd: string }

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** The owner of a lock path: a flock file holds the JSON directly; a legacy lock was a directory with owner.json. */
export function readOwner(lock: string): Owner | null {
  try {
    const file = statSync(lock).isDirectory() ? join(lock, 'owner.json') : lock;
    return JSON.parse(readFileSync(file, 'utf8')) as Owner;
  } catch { return null; }
}

export const describeOwner = (owner: Owner | null): string => owner ? `pid ${owner.pid} (${owner.label}, cwd ${owner.cwd}, since ${owner.started})` : 'an unknown owner';

export interface LockOptions { lock?: string; label: string; wait?: boolean; pollMs?: number; onWait?: (owner: Owner | null) => void }

/** A legacy lock is a directory with owner.json and no flock. Its pid is the only liveness it has; that is why it is migrated once. */
function legacy(lock: string): { present: boolean; owner: Owner | null } {
  try { if (!statSync(lock).isDirectory()) return { present: false, owner: null }; }
  catch { return { present: false, owner: null }; }
  return { present: true, owner: readOwner(lock) };
}

/** Take the lock, or throw naming the holder. With `wait`, poll until it frees. */
export async function acquire(options: LockOptions): Promise<() => Promise<void>> {
  const lock = options.lock ?? DEFAULT_LOCK;
  mkdirSync(dirname(lock), { recursive: true });
  const owner: Owner = { pid: process.pid, started: new Date().toISOString(), label: options.label, cwd: process.cwd() };
  let notified = '';
  const stuck = (current: Owner | null): Error => new Error(`bench lock ${lock} is held by ${describeOwner(current)}; use --wait to queue`);
  for (;;) {
    const old = legacy(lock);
    if (old.present) {
      if (old.owner && alive(old.owner.pid)) {
        if (!options.wait) throw stuck(old.owner);
        if (String(old.owner.pid) !== notified) { notified = String(old.owner.pid); options.onWait?.(old.owner); }
        await sleep(options.pollMs ?? 5000);
        continue;
      }
      rmSync(lock, { recursive: true, force: true });   // ownerless or dead: never a flock, so it cannot be a live holder of the new lock
    }
    try {
      const held = await holdLock(lock, { waitS: 0 });
      // Keep the flock's inode: write the owner in place, never rename over the lock file.
      writeFileSync(lock, JSON.stringify(owner));
      let released = false;
      return () => { if (released) return Promise.resolve(); released = true; return held.release(); };
    } catch (error) {
      if (!(error instanceof LockBusyError)) throw error;
    }
    const current = readOwner(lock);
    if (!options.wait) throw stuck(current);
    const key = String(current?.pid);
    if (key !== notified) { notified = key; options.onWait?.(current); }
    await sleep(options.pollMs ?? 5000);
  }
}
