// One place for the paths of the external tools. The checkers, tools/doctor.mjs and tools/gate.mjs import it.
// Each path has an environment override. first() returns the first candidate that exists, else the first one
// (so an error message names the expected place).

import {existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {kiCadPaths} from './env-paths.mjs';
import {projectRoot} from './project-root.mjs';

const home = homedir();
const first = (candidates) => candidates.find((p) => p && existsSync(p)) ?? candidates.find(Boolean);

// The project root: tools/lib/project-root.mjs (explicit argument > env IOT_LAB > cwd search > file-relative).
export {fileRoot, findProjectRoot, projectRoot} from './project-root.mjs';
export const root = projectRoot();
export const {kicadApp,kicadCli,kicadPython,kicadShared,kicadConfig} = kiCadPaths(process.platform,home,process.env);
export const KICAD_VERSION = '10.0';
// KICAD_CONFIG_HOME is the base path: KiCad appends its major/minor version.
// Fingerprint the same library tables that the CLI actually opens.

// Pinned tool repos (CLAUDE.md section 5). dir: env override, then ~/Documents/GitHub, then ~/code.
const repo = (name, envName) => process.env[envName] ?? first([join(home, 'Documents/GitHub', name), join(home, 'code', name)]);
export const pinnedRepos = [
  {name: 'kicad-happy', env: 'KICAD_HAPPY_DIR', commit: 'a6bba1a', dir: repo('kicad-happy', 'KICAD_HAPPY_DIR'), needed: 'gate'},
  {name: 'KiCadRoutingTools', env: 'KRT_DIR', commit: '46c90458', dir: repo('KiCadRoutingTools', 'KRT_DIR'), needed: 'advisory'},
  {name: 'KiCadRoutingPlacementTools', env: 'KRPT_DIR', commit: '409d53e', dir: repo('KiCadRoutingPlacementTools', 'KRPT_DIR'), needed: 'optional'},
];

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
