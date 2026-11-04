// Power-path current check, shared by the board audits.
// tools/pcbtool.ts paths finds the widest copper path (tracks, vias, zone islands, thermal spokes)
// between the power pads in <board>/current-paths.json and compares it with the design current (IPC-2221).

import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {TS_NODE} from './env.mjs';

const PCBTOOL = fileURLToPath(new URL('../pcbtool.ts', import.meta.url));

// check(name, ok, detail) records one result. A tool failure is a failed check (fail closed).
export function currentPathsCheck({pcb, spec, check}) {
  const name = 'power paths carry the design current (IPC-2221, dT 10 K, current-paths.json, pcbtool paths)';
  let out = '';
  let exit = 0;
  try {
    out = execFileSync(process.execPath, [...TS_NODE, PCBTOOL, 'paths', pcb, spec, '--limit', '2'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
  } catch (e) {
    out = String(e.stdout ?? '');
    exit = e.status ?? 1;
  }
  const summary = out.split('\n').find((line) => line.includes('power-path pairs below the design current'));
  if (!summary) {
    check(name, false, `pcbtool paths did not run (exit ${exit}): ${out.slice(0, 200)}`);
    return;
  }
  const low = out.split('\n').filter((line) => line.startsWith('LOW'));
  check(name, exit === 0 && low.length === 0, low.length ? low.slice(0, 8).join(' | ') : summary);
}
