import fs from 'node:fs';

export interface HostState {
  /** Busy share of all CPUs over the last window, 0-100. null until two samples exist. */
  cpuBusyPct: number | null;
  cpuCount: number;
  memAvailableGb: number;
  memTotalGb: number;
  diskFreeGb: number;
}

const GB = 1024 ** 3;
/** The guard's sampling period, so the two read the same number: `--interval 5s` of servterm-resource-guard. */
const CPU_WINDOW_MS = 5000;

interface CpuSample {
  busy: number;
  total: number;
}

/** The aggregate line of /proc/stat, summed as the guard's readCPU does: idle is idle + iowait. */
function parseCpuSample(text: string): CpuSample {
  const m = /^cpu\s+(.+)$/m.exec(text);
  if (!m) throw new Error('no aggregate cpu line in /proc/stat');
  const v = m[1].trim().split(/\s+/).slice(0, 10).map(Number);
  const total = v.reduce((a, b) => a + b, 0);
  return { busy: total - v[3] - v[4], total };
}

export function parseCpuCount(text: string): number {
  return text.match(/^cpu\d+\s/gm)?.length ?? 0;
}

/** Host CPU use over a fixed window. The host is read many times per tick, so a sample is taken once per window. */
export class CpuMeter {
  private last: CpuSample | null = null;
  private lastAt = 0;
  private busyPct: number | null = null;

  read(stat: string, now: number): number | null {
    if (this.last !== null && now - this.lastAt < CPU_WINDOW_MS) return this.busyPct;
    const s = parseCpuSample(stat);
    if (this.last !== null && s.total > this.last.total) {
      this.busyPct = (100 * (s.busy - this.last.busy)) / (s.total - this.last.total);
    }
    this.last = s;
    this.lastAt = now;
    return this.busyPct;
  }
}

export function parseMeminfoKb(text: string, key: string): number {
  const m = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text);
  if (!m) throw new Error(`no ${key} in /proc/meminfo`);
  return Number(m[1]);
}

/** The utilisation and memory that servterm-resource-guard reads to cut the CI quota. */
export function hostReader(dataDir: string): () => HostState {
  const meter = new CpuMeter();
  return () => {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const stat = fs.readFileSync('/proc/stat', 'utf8');
    const disk = fs.statfsSync(dataDir);
    return {
      cpuBusyPct: meter.read(stat, Date.now()),
      cpuCount: parseCpuCount(stat),
      memAvailableGb: (parseMeminfoKb(meminfo, 'MemAvailable') * 1024) / GB,
      memTotalGb: (parseMeminfoKb(meminfo, 'MemTotal') * 1024) / GB,
      diskFreeGb: (disk.bavail * disk.bsize) / GB,
    };
  };
}
