#!/usr/bin/env node
// Environment check for this repository. Run it on a new computer and before a gate run.
//   node tools/doctor.mjs          report only
//   node tools/doctor.mjs --fix    also install the KiCad global library tables when they are missing,
//                                  and set the git hooks path to tools/hooks (gate ratchet)
// Exit code 1 when a REQUIRED item fails. An OPTIONAL item only gives a warning.
// --fix makes no other change: it does not install software and does not move a tool repository.

import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {root, kicadCli, kicadPython, kicadShared, kicadConfig, KICAD_VERSION, pinnedRepos, modernPython, happyRunsLocally, happyRuntime} from './lib/env.mjs';
import {hookCheck} from './lib/doctor-checks.mjs';
import {homedir} from 'node:os';

const fix = process.argv.includes('--fix');
const gateOnly = process.argv.includes('--gate-only');
const probeTimeout = Number(process.env.DOCTOR_PROBE_TIMEOUT_MS ?? 10000);
if (!Number.isSafeInteger(probeTimeout) || probeTimeout <= 0) throw new Error('DOCTOR_PROBE_TIMEOUT_MS must be a positive execution budget');
const rows = [];
const add = (level, name, ok, detail) => rows.push({level, name, ok, detail});
const run = (cmd, args) => {
  console.log(`probe: ${cmd} ${args.join(' ')}`);
  try {
    return execFileSync(cmd, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: probeTimeout}).trim();
  } catch (e) {
    return null;
  }
};
const which = (cmd) => run('/usr/bin/which', [cmd]);

// KiCad
const version = existsSync(kicadCli) ? run(kicadCli, ['--version']) : null;
add('REQUIRED', 'kicad-cli', Boolean(version?.startsWith(`${KICAD_VERSION}.`)), version ? `${version} at ${kicadCli}` : `not found: ${kicadCli}`);
const pcbnew = existsSync(kicadPython) ? run(kicadPython, ['-c', 'import pcbnew; print(pcbnew.Version())']) : null;
add('REQUIRED', 'KiCad Python (pcbnew)', Boolean(pcbnew), pcbnew ?? `not found or no pcbnew: ${kicadPython}`);

// Global library tables. Without them ERC and DRC report "library not found" for each stock KiCad part.
for (const table of ['fp-lib-table', 'sym-lib-table']) {
  const target = join(kicadConfig, table);
  let ok = existsSync(target);
  let detail = target;
  if (!ok && fix) {
    mkdirSync(kicadConfig, {recursive: true});
    copyFileSync(join(kicadShared, 'template', table), target);
    ok = true;
    detail = `installed from the KiCad template: ${target}`;
  } else if (!ok) {
    detail = `missing: ${target} (run with --fix)`;
  }
  add('REQUIRED', `KiCad global ${table}`, ok, detail);
}

// Pinned tool repositories
for (const r of pinnedRepos) {
  if (gateOnly && r.needed !== 'gate') continue;
  const head = existsSync(r.dir) ? run('git', ['-C', r.dir, 'rev-parse', 'HEAD']) : null;
  const ok = Boolean(head?.startsWith(r.commit));
  const detail = !head ? `not found: ${r.dir} (set ${r.env})` : ok ? `${r.commit} at ${r.dir}` : `HEAD ${head.slice(0, 8)} is not the pin ${r.commit}: ${r.dir}`;
  add(r.needed === 'gate' ? 'REQUIRED' : 'OPTIONAL', `${r.name} (${r.needed})`, ok, detail);
}

// kicad-happy's Python runs in a daemon job, so this host needs none. A local run is the exception: REMOTE_NO_DAEMON=1, or not macOS.
if (happyRunsLocally()) {
  const modern = run(modernPython(), ['-c', 'import sys; assert sys.version_info >= (3, 10); print(sys.version.split()[0])']);
  add('OPTIONAL', 'Python 3.10 or later (local kicad-happy run)', Boolean(modern), modern ? `${modern} as ${modernPython()}` : 'not found: set PYTHON_MODERN');
} else {
  add('OPTIONAL', 'kicad-happy runtime (daemon job)', true, happyRuntime());
}

// Gate ratchet hook (tools/hooks/pre-commit)
let hooks = run('git', ['-C', root, 'config', '--get', 'core.hooksPath']);
if (!hookCheck(root,hooks).ok && fix) {
  run('git', ['-C', root, 'config', 'core.hooksPath', 'tools/hooks']);
  hooks = run('git', ['-C', root, 'config', '--get', 'core.hooksPath']);
}
const hook=hookCheck(root,hooks);
add('REQUIRED', 'git hooks path (gate ratchet)', hook.ok, hook.detail);

// Routing
if (!gateOnly) {
const fastroute=process.env.FASTROUTE_BIN ?? join(homedir(),'opt/fastroute/fastroute-0.1.7-macos-arm64/fastroute');
const routeVersion=existsSync(fastroute) ? run(fastroute,['--version']) : null;
add('REQUIRED','Fastroute 0.1.7 (primary router)',Boolean(routeVersion?.includes('0.1.7')),routeVersion ?? `not found: ${fastroute}`);
const cross=process.env.FREEROUTING_CROSSCHECK_JAR;
const crossVersion=cross && existsSync(cross) ? run('java',['-jar',cross,'--version']) : null;
add('OPTIONAL','Freerouting 2.4.1 (remote cross-check)',Boolean(crossVersion?.includes('2.4.1')),cross ? `${cross}: ${crossVersion ?? 'version could not be verified'}` : 'remote-only: iot-lab-route:10.0-fr241; not checked from this host');
const tracemaker=process.env.TRACEMAKER_BIN ?? join(homedir(),'opt/tracemaker/build/macos-metal/src/app/tracemaker');
const tmVersion=existsSync(tracemaker)?run(tracemaker,['--version']):null;
add('OPTIONAL','TraceMaker 0.9.0 (benchmark only)',Boolean(tmVersion?.includes('0.9.0')),tmVersion ? `${tmVersion} at ${tracemaker}` : `not found or version unavailable: ${tracemaker}`);

}
// Other tools from CLAUDE.md section 5
for (const [cmd, use] of [['node', 'checkers'], ['uv', 'easyeda2kicad'], ['docling', 'datasheet to Markdown'], ['ngspice', 'simulation'], ['git-lfs', 'not used yet']]) {
  if (gateOnly && cmd !== 'node') continue;
  const p = which(cmd);
  add(cmd === 'node' ? 'REQUIRED' : 'OPTIONAL', `${cmd} (${use})`, Boolean(p), p ?? 'not on PATH');
}

let failed = false;
for (const r of rows) {
  const mark = r.ok ? 'ok  ' : r.level === 'REQUIRED' ? 'FAIL' : 'warn';
  if (!r.ok && r.level === 'REQUIRED') failed = true;
  console.log(`${mark}  ${r.name}: ${r.detail}`);
}
console.log(failed ? 'doctor: a REQUIRED item failed' : 'doctor: all REQUIRED items pass');
process.exit(failed ? 1 : 0);
