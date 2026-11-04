// flock files shared with the Python tools. Node has no flock and the lock belongs to an open file description, so
// a live `iotroute lock hold` process is the holder. It lives as long as this process keeps its stdin open.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { iotrouteBin } from './iotroute-bin.ts';

const EXIT_BUSY = 75;
const HELD_LINE = 'held\n';

/** The lock stayed taken for the whole wait. */
export class LockBusyError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`lock busy: ${path}`);
    this.path = path;
  }
}

export interface HeldLock {
  /** Resolves when the lock is free again. Safe to call more than once. */
  release(): Promise<void>;
}

export interface HoldOptions {
  /** Seconds to keep retrying; 0, the default, is one non-blocking attempt. */
  waitS?: number;
}

const exited = (helper: ChildProcess): Promise<void> => new Promise(resolve => {
  if (helper.exitCode !== null || helper.signalCode !== null) resolve();
  else helper.once('exit', () => resolve());
});

function waitUntilHeld(helper: ChildProcess, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    helper.stdout?.setEncoding('utf8').on('data', (text: string) => {
      output += text;
      if (output === HELD_LINE) resolve();
    });
    helper.stderr?.setEncoding('utf8').on('data', (text: string) => { errors += text; });
    helper.once('error', reject);
    helper.once('close', code => {
      if (code === EXIT_BUSY) reject(new LockBusyError(path));
      else reject(new Error(`lock helper failed for ${path} (exit ${code}): ${errors.trim()}`));
    });
  });
}

/** A forgotten handle must not keep this process alive; its exit closes stdin and so frees the lock. */
function detachFromEventLoop(helper: ChildProcess): void {
  helper.unref();
  for (const stream of [helper.stdin, helper.stdout, helper.stderr]) {
    (stream as unknown as { unref?: () => void } | null)?.unref?.();
  }
}

/** Takes LOCK_EX on `path`, creating the file and its folder. Rejects with LockBusyError when it stays taken. */
export async function holdLock(path: string, options: HoldOptions = {}): Promise<HeldLock> {
  const waitS = options.waitS ?? 0;
  if (!Number.isFinite(waitS) || waitS < 0) throw new RangeError(`lock wait must be finite and nonnegative: ${waitS}`);
  const helper = spawn(iotrouteBin(), ['lock', 'hold', path, '--wait-s', String(waitS)], { stdio: ['pipe', 'pipe', 'pipe'] });
  await waitUntilHeld(helper, path);
  detachFromEventLoop(helper);
  return {
    release: () => {
      helper.ref();   // the wait below must hold the loop open: on Node 22 it otherwise ends with this await pending
      helper.stdin?.end();
      return exited(helper);
    },
  };
}

/**
 * True when another open file description holds `path`, a holder of this process included. A missing file is free.
 * For tickets a held inode is a live owner and a free one a dead owner. The probe takes the lock for an instant,
 * like lean_resources.live_claims, so a concurrent non-blocking taker can see it busy.
 */
export function lockHeld(path: string): boolean {
  const probe = spawnSync(iotrouteBin(), ['lock', 'held', path], { encoding: 'utf8' });
  if (probe.error) throw probe.error;
  if (probe.status === 0) return true;
  if (probe.status === 1) return false;
  throw new Error(`lock probe failed for ${path} (exit ${probe.status}): ${probe.stderr.trim()}`);
}

async function holdOr(path: string, waitS: number, busy: () => Error): Promise<HeldLock> {
  try {
    return await holdLock(path, { waitS });
  } catch (error) {
    throw error instanceof LockBusyError ? busy() : error;
  }
}

/** lean_workflow.job_slot: one heavy cooperating pipeline, never waited for. */
export const holdJobSlot = (path: string): Promise<HeldLock> =>
  holdOr(path, 0, () => new Error('another cooperating BASE-B pipeline is active; retry after it finishes'));

/** lean_resources.guard: the ledger lock of `root`, retried for `waitS` seconds (5 by default). */
export const holdResourceGuard = (root: string, waitS = 5): Promise<HeldLock> =>
  holdOr(join(root, 'guard'), waitS, () => new Error('resource ledger busy; admission deadline reached'));
