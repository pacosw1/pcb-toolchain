import fs from 'node:fs';

export interface HostState {
  cpuPsiSome10: number;
  memAvailableGb: number;
  memTotalGb: number;
  diskFreeGb: number;
}

const GB = 1024 ** 3;

export function parsePsiSome10(text: string): number {
  const m = /^some avg10=([\d.]+)/m.exec(text);
  if (!m) throw new Error('no "some avg10" in the PSI file');
  return Number(m[1]);
}

export function parseMeminfoKb(text: string, key: string): number {
  const m = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text);
  if (!m) throw new Error(`no ${key} in /proc/meminfo`);
  return Number(m[1]);
}

/** The same signals servterm-resource-guard reads to cut the CI quota. */
export function readHost(dataDir: string): HostState {
  const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
  const disk = fs.statfsSync(dataDir);
  return {
    cpuPsiSome10: parsePsiSome10(fs.readFileSync('/proc/pressure/cpu', 'utf8')),
    memAvailableGb: (parseMeminfoKb(meminfo, 'MemAvailable') * 1024) / GB,
    memTotalGb: (parseMeminfoKb(meminfo, 'MemTotal') * 1024) / GB,
    diskFreeGb: (disk.bavail * disk.bsize) / GB,
  };
}
