// CLOCK_MONOTONIC for the IOT_LEAN_DEADLINE protocol, which processes on one host share.
// Node cannot read that clock. process.hrtime is CLOCK_UPTIME_RAW on macOS and stops during sleep: on the Mac mini it was
// measured 5.63 s behind CLOCK_MONOTONIC, a gap that grows with each sleep. So a sample comes from `iotroute clock`, and
// hrtime only carries it for up to a second between samples. After a wake a deadline can fire up to that second late.
import { execFileSync } from 'node:child_process';
import { pyFloat } from './py-numbers.ts';

const RESYNC_NS = 1_000_000_000n;

export type Sampler = () => number;

export function createClock(sample: Sampler, hrtime: () => bigint = () => process.hrtime.bigint()): () => number {
  let base: { monotonic: number; at: bigint } | null = null;
  return () => {
    if (base === null || hrtime() - base.at >= RESYNC_NS) base = { monotonic: sample(), at: hrtime() };
    return base.monotonic + Number(hrtime() - base.at) / 1e9;
  };
}

const iotrouteClock: Sampler = () => pyFloat(execFileSync(process.env.IOTROUTE_BIN ?? 'iotroute', ['clock'], { encoding: 'utf8' }));

/** Seconds on the same-host kernel clock. Never serialize this to another host. */
export const now = createClock(iotrouteClock);
