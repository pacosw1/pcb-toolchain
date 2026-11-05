// Observe existing local toolchain processes without controlling them or reading unrelated process data.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface ProcessRow { pid: number; ppid: number; uid: number; elapsed: number; started: string; args: string }
export interface ExternalRun { pid: number; started: string; root: string; board: string; outdir: string;
  boardFile: string; elapsed: number; timeout: number; stage: string; runId: string }

export function parseElapsed(value: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value);
  if (!match) return null;
  return Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3]) * 60 + Number(match[4]);
}
export function parseProcessTable(text: string): ProcessRow[] {
  return text.split('\n').flatMap(line => {
    // ps lstart is five whitespace-separated fields on macOS and Linux.
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/.exec(line);
    if (!m) return [];
    const elapsed = parseElapsed(m[4]); if (elapsed === null) return [];
    return [{ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), elapsed, started: m[5], args: m[6] }];
  });
}
function option(args: string, name: string): string | null {
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\s)--${safe}(?:=|\\s+)(.*?)(?=\\s+--[A-Za-z]|$)`).exec(args);
  return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : null;
}
function processCwd(pid: number): string | null {
  try {
    if (process.platform === 'linux') return fs.realpathSync(`/proc/${pid}/cwd`);
    if (process.platform === 'darwin') {
      const out = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
      const cwd = out.split('\n').find(line => line.startsWith('n'))?.slice(1);
      return cwd ? fs.realpathSync(cwd) : null;
    }
  } catch { /* process exited or is not observable */ }
  return null;
}
export function discoverExternal(roots: string[], table?: ProcessRow[], cwdOf = processCwd): ExternalRun[] | null {
  if (!table) {
    try { table = parseProcessTable(execFileSync('ps', ['-axo', 'pid=,ppid=,uid=,etime=,lstart=,args='], { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 })); }
    catch { return null; }
  }
  const rows = table, result: ExternalRun[] = [], uid = process.getuid?.();
  for (const row of rows) {
    if (uid !== undefined && row.uid !== uid || !/(?:^|\s)(?:\S*\/)?tools\/placer\/compact_cli\.py(?:\s|$)/.test(row.args)) continue;
    const dirArg = option(row.args, 'board-dir'), outputArg = option(row.args, 'outdir');
    const match = dirArg?.match(/(?:^|\/)hardware-design\/boards\/([A-Z0-9][A-Z0-9-]*)(?:\/|$)/);
    if (!match || !outputArg) continue;
    const cwd = cwdOf(row.pid); if (!cwd || cwd.includes(`${path.sep}.gate${path.sep}cli${path.sep}`)) continue;
    const root = [...roots].sort((a, b) => b.length - a.length).find(r => cwd === r || cwd.startsWith(r + path.sep));
    if (!root) continue;
    try {
      const outdir = fs.realpathSync(path.resolve(cwd, outputArg)), stat = fs.statSync(outdir);
      if (!stat.isDirectory() || uid !== undefined && stat.uid !== uid) continue;
      // The positional board immediately follows the problem file. Only this narrow tool signature is accepted.
      const afterScript = row.args.split(/(?:^|\s)(?:\S*\/)?tools\/placer\/compact_cli\.py\s+/)[1];
      const positional = afterScript?.split(/\s+--[A-Za-z]/, 1)[0].trim().split(/\s+/) ?? [];
      const boardFile = positional.length === 2 ? path.resolve(cwd, positional[1]) : '';
      if (!boardFile.endsWith('.kicad_pcb')) continue;
      const budget = Number(option(row.args, 'budget') ?? 2700);
      const descendants = new Set([row.pid]);
      for (let i = 0; i < 10; i++) { const before = descendants.size; for (const r of rows) if (descendants.has(r.ppid)) descendants.add(r.pid); if (before === descendants.size) break; }
      const children = rows.filter(r => r.pid !== row.pid && descendants.has(r.pid));
      const stage = children.some(r => /(?:\/|\b)(iotroute|router\/run\.py)(?:\s|$)/.test(r.args)) ? 'routing'
        : children.some(r => /placer\/cli\.py\s+run(?:\s|$)/.test(r.args)) ? 'placement' : 'working';
      const tag = createHash('sha256').update(`${row.pid}\0${row.started}`).digest('hex').slice(0, 12);
      result.push({ pid: row.pid, started: row.started, root, board: match[1], outdir, boardFile,
        elapsed: row.elapsed, timeout: Number.isFinite(budget) && budget > 0 ? budget : 2700, stage, runId: `external-${row.pid}-${tag}` });
    } catch { /* an exiting process or unavailable path is not an observation */ }
  }
  return result;
}
