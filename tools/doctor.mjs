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
import {root, kicadCli, kicadPython, kicadShared, kicadConfig, KICAD_VERSION, pinnedRepos, freeroutingJar, modernPython} from './lib/env.mjs';

const fix = process.argv.includes('--fix');
const rows = [];
const add = (level, name, ok, detail) => rows.push({level, name, ok, detail});
const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
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
  const head = existsSync(r.dir) ? run('git', ['-C', r.dir, 'rev-parse', 'HEAD']) : null;
  const ok = Boolean(head?.startsWith(r.commit));
  const detail = !head ? `not found: ${r.dir} (set ${r.env})` : ok ? `${r.commit} at ${r.dir}` : `HEAD ${head.slice(0, 8)} is not the pin ${r.commit}: ${r.dir}`;
  add(r.needed === 'gate' ? 'REQUIRED' : 'OPTIONAL', `${r.name} (${r.needed})`, ok, detail);
}

const modern = run(modernPython, ['-c', 'import sys; assert sys.version_info >= (3, 10); print(sys.version.split()[0])']);
add('REQUIRED', 'Python 3.10 or later (kicad-happy gate)', Boolean(modern), modern ? `${modern} as ${modernPython}` : 'not found: brew install python@3.12, or set PYTHON_MODERN');

// Gate ratchet hook (tools/hooks/pre-commit)
let hooks = run('git', ['-C', root, 'config', '--get', 'core.hooksPath']);
if (hooks !== 'tools/hooks' && fix) {
  run('git', ['-C', root, 'config', 'core.hooksPath', 'tools/hooks']);
  hooks = run('git', ['-C', root, 'config', '--get', 'core.hooksPath']);
}
add('REQUIRED', 'git hooks path (gate ratchet)', hooks === 'tools/hooks', hooks === 'tools/hooks' ? 'tools/hooks' : 'not set: run with --fix (git config core.hooksPath tools/hooks)');

// Routing
const java = run('java', ['-version']) !== null;
add('OPTIONAL', 'Java (Freerouting)', java, java ? which('java') : 'no Java runtime: brew install openjdk');
add('OPTIONAL', 'Freerouting 2.1.0 jar', existsSync(freeroutingJar), existsSync(freeroutingJar) ? freeroutingJar : `not found: ${freeroutingJar} (set FREEROUTING_JAR)`);

// Other tools from CLAUDE.md section 5
for (const [cmd, use] of [['node', 'checkers'], ['uv', 'easyeda2kicad'], ['docling', 'datasheet to Markdown'], ['ngspice', 'simulation'], ['git-lfs', 'not used yet']]) {
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
