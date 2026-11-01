import {spawn, execFileSync} from 'node:child_process';
import {availableParallelism, freemem, platform, totalmem} from 'node:os';
import {readFileSync} from 'node:fs';

// Pool size of the commit hook: boards run at the same time, each board in its own gate process.
// Source: measured 2026-11-01 on the Mac mini (15 cores, 24 GB). One fresh board gate (BASE-PWR-B, the largest input
// set, no cache) peaked at 1.65 GB summed RSS of its process tree: kicad-cli DRC with zone refill, then up to six
// pcbnew/Python checkers. 2 GB per board keeps a margin. A board gate already runs its own checks concurrently,
// so give each board 2 cores.
export const BOARD_PEAK_BYTES = 2 * 1024 ** 3;
export const CORES_PER_BOARD = 2;

// Memory that the OS can give without swap. macOS: kern.memorystatus_level (percent free, the value memory_pressure
// shows). Linux: MemAvailable. Else os.freemem().
export function availableMemory() {
  try {
    if (platform() === 'darwin') {
      const level = Number(execFileSync('sysctl', ['-n', 'kern.memorystatus_level'], {encoding: 'utf8'}).trim());
      if (level > 0 && level <= 100) return totalmem() * level / 100;
    }
    if (platform() === 'linux') {
      const m = readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+) kB/);
      if (m) return Number(m[1]) * 1024;
    }
  } catch { /* use freemem */ }
  return freemem();
}

export function poolSize({boards, cpus = availableParallelism(), availableBytes = availableMemory(), override}) {
  if (override !== undefined && override !== '') {
    const n = Number(override);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`IOT_LAB_GATE_JOBS must be a positive integer, not "${override}"`);
    return {jobs: Math.max(1, Math.min(n, boards)), rule: `IOT_LAB_GATE_JOBS=${n}`};
  }
  const byCpu = Math.floor(cpus / CORES_PER_BOARD);
  const byMemory = Math.floor(availableBytes / BOARD_PEAK_BYTES);
  return {jobs: Math.max(1, Math.min(boards, byCpu, byMemory)),
    rule: `min(${boards} boards, ${cpus} cores / ${CORES_PER_BOARD}, ${(availableBytes / 1024 ** 3).toFixed(1)} GB available / ${BOARD_PEAK_BYTES / 1024 ** 3} GB)`};
}

// Run worker(item, index) for each item with at most `limit` at the same time. Results come back in item order.
// A worker result {ok:false} or a thrown error is a failure. After a failure, or when shouldStop() is true, no new
// item starts; items in progress finish. Items that did not start are 'skipped'.
export async function runPool(items, limit, worker, {shouldStop = () => false} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`pool limit must be a positive integer, not ${limit}`);
  const results = new Array(items.length);
  let next = 0, stopped = false;
  async function lane() {
    while (!stopped && next < items.length) {
      if (shouldStop()) { stopped = true; break; }
      const index = next++;
      try {
        const value = await worker(items[index], index);
        results[index] = {item: items[index], status: value?.ok === false ? 'failed' : 'ok', value};
      } catch (error) { results[index] = {item: items[index], status: 'failed', error}; }
      if (results[index].status === 'failed') stopped = true;
    }
  }
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, lane));
  for (let i = 0; i < items.length; i++) results[i] ??= {item: items[i], status: 'skipped'};
  return results;
}

// Child processes in their own process group, so that one signal stops a gate and all its kicad-cli/pcbnew children.
// A group that still has members after its gate process closed is killed at once (no orphans).
export class ProcessGroups {
  constructor() { this.running = new Set(); }
  run(cmd, args, options = {}) {
    const started = Date.now();
    return new Promise(resolve => {
      let output = '', settled = false;
      const child = spawn(cmd, args, {...options, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
      const done = (code, signal, error) => {
        if (settled) return; settled = true;
        this.running.delete(child);
        let orphans = false;
        if (child.pid) try { process.kill(-child.pid, 0); orphans = true; process.kill(-child.pid, 'SIGKILL'); } catch { /* group is empty */ }
        resolve({code, signal, output: output + (error ? `${error.message}\n` : ''), seconds: (Date.now() - started) / 1000, orphans});
      };
      if (child.pid) this.running.add(child);
      for (const stream of [child.stdout, child.stderr]) { stream?.setEncoding('utf8'); stream?.on('data', text => { output += text; }); }
      child.on('error', error => done(null, null, error));
      child.on('close', (code, signal) => done(code, signal));
    });
  }
  kill(signal) {
    for (const child of this.running) try { process.kill(-child.pid, signal); } catch { /* already gone */ }
  }
}
