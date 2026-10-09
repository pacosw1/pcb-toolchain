// One place for the paths of the external tools. The checkers, tools/doctor.mjs and tools/gate.mjs import it.
// Each path has an environment override. first() returns the first candidate that exists, else the first one
// (so an error message names the expected place).

import {existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const home = homedir();
const first = (candidates) => candidates.find((p) => p && existsSync(p)) ?? candidates.find(Boolean);

export const root = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
export const kicadApp = process.env.KICAD_APP ?? '/Applications/KiCad/KiCad.app/Contents';
export const kicadCli = process.env.KICAD_CLI ?? `${kicadApp}/MacOS/kicad-cli`;
export const kicadPython = process.env.KICAD_PYTHON ?? `${kicadApp}/Frameworks/Python.framework/Versions/Current/bin/python3`;
export const kicadShared = `${kicadApp}/SharedSupport`;
export const KICAD_VERSION = '10.0';
export const kicadConfig = process.env.KICAD_CONFIG_HOME ?? join(home, 'Library/Preferences/kicad', KICAD_VERSION);

// Pinned tool repos (CLAUDE.md section 5). dir: env override, then ~/Documents/GitHub, then ~/code.
const repo = (name, envName) => first([process.env[envName], join(home, 'Documents/GitHub', name), join(home, 'code', name)]);
export const pinnedRepos = [
  {name: 'kicad-happy', env: 'KICAD_HAPPY_DIR', commit: 'a6bba1a', dir: repo('kicad-happy', 'KICAD_HAPPY_DIR'), needed: 'gate'},
  {name: 'KiCadRoutingTools', env: 'KRT_DIR', commit: '46c90458', dir: repo('KiCadRoutingTools', 'KRT_DIR'), needed: 'advisory'},
  {name: 'KiCadRoutingPlacementTools', env: 'KRPT_DIR', commit: '409d53e', dir: repo('KiCadRoutingPlacementTools', 'KRPT_DIR'), needed: 'optional'},
];

export const freeroutingJar = first([
  process.env.FREEROUTING_JAR,
  join(home, 'Documents/KiCad/9.0/3rdparty/plugins/app_freerouting_kicad-plugin/jar/freerouting-2.1.0.jar'),
  join(home, 'Documents/KiCad/10.0/3rdparty/plugins/app_freerouting_kicad-plugin/jar/freerouting-2.1.0.jar'),
  join(home, 'opt/freerouting/freerouting-2.1.0.jar'),
]);

// kicad-happy needs Python 3.10 or later. The macOS python3 and the KiCad Python are 3.9.
// modernPython: env PYTHON_MODERN, else the first python3.1x on PATH, else 'python3' (doctor.mjs then reports it).
function findModernPython() {
  if (process.env.PYTHON_MODERN) return process.env.PYTHON_MODERN;
  for (const name of ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3']) {
    try {
      const out = execFileSync(name, ['-c', 'import sys; print(sys.version_info >= (3, 10))'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
      if (out.trim() === 'True') return name;
    } catch {
      // not installed: try the next name
    }
  }
  return 'python3';
}
export const modernPython = findModernPython();
