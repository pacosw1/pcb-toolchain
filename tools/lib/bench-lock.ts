// One benchmark at a time per machine: a mkdir lock with the owner's pid, stale when that process is gone.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULT_LOCK = process.env.BENCH_LOCK ?? '/private/var/folders/xr/wdn1rhvs5rxcyb8wlqtks0v00000gn/T/opencode/bench.lock';

export interface Owner { pid: number; started: string; label: string; cwd: string }

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

export function readOwner(lock: string): Owner | null {
  try { return JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')) as Owner; } catch { return null; }
}

export const describeOwner = (owner: Owner | null): string => owner ? `pid ${owner.pid} (${owner.label}, cwd ${owner.cwd}, since ${owner.started})` : 'an unknown owner';

export interface LockOptions { lock?: string; label: string; wait?: boolean; pollMs?: number; onWait?: (owner: Owner | null) => void }

/** Take the lock, or throw naming the holder. With `wait`, poll until it frees. A lock whose owner pid is dead is taken over. */
export async function acquire(options: LockOptions): Promise<() => void> {
  const lock = options.lock ?? DEFAULT_LOCK;
  mkdirSync(dirname(lock), { recursive: true });
  let notified = '';
  for (;;) {
    try {
      mkdirSync(lock);
      const owner: Owner = { pid: process.pid, started: new Date().toISOString(), label: options.label, cwd: process.cwd() };
      const staging = join(lock, 'owner.json.tmp');
      writeFileSync(staging, JSON.stringify(owner));
      renameSync(staging, join(lock, 'owner.json'));
      let released = false;
      const release = (): void => { if (!released && readOwner(lock)?.pid === process.pid) { released = true; rmSync(lock, { recursive: true, force: true }); } };
      return release;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const owner = readOwner(lock);
    // A missing owner file means the holder is between mkdir and its write; give it a moment before calling it stale.
    if (owner && !alive(owner.pid)) { rmSync(lock, { recursive: true, force: true }); continue; }
    if (!options.wait) throw new Error(`bench lock ${lock} is held by ${describeOwner(owner)}; use --wait to queue`);
    const key = String(owner?.pid);
    if (key !== notified) { notified = key; options.onWait?.(owner); }
    await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 5000));
  }
}
