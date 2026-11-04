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
// Node arguments that run a TypeScript tool; Node 22 needs the flag, later versions accept it.
export const TS_NODE = ['--experimental-strip-types', '--no-warnings'];
// KICAD_CONFIG_HOME is the base path: KiCad appends its major/minor version.
// Fingerprint the same library tables that the CLI actually opens.

// Pinned tool repos (CLAUDE.md section 5). dir: env override, then ~/Documents/GitHub, then ~/code.
const repo = (name, envName) => process.env[envName] ?? first([join(home, 'Documents/GitHub', name), join(home, 'code', name)]);
export const pinnedRepos = [
  {name: 'kicad-happy', env: 'KICAD_HAPPY_DIR', commit: 'a6bba1a', dir: repo('kicad-happy', 'KICAD_HAPPY_DIR'), needed: 'gate'},
  {name: 'KiCadRoutingTools', env: 'KRT_DIR', commit: '46c90458', dir: repo('KiCadRoutingTools', 'KRT_DIR'), needed: 'advisory'},
  {name: 'KiCadRoutingPlacementTools', env: 'KRPT_DIR', commit: '409d53e', dir: repo('KiCadRoutingPlacementTools', 'KRPT_DIR'), needed: 'optional'},
];

// KiCad 10 and the pinned nightly in one image (tools/remote-route-nightly.Dockerfile): board reads and kicad-happy run in it.
export const PINNED_IMAGE = 'iot-lab-route:10.0-nightly-4fe1ca2060';
const PINNED_IMAGE_PYTHON = 'Python 3.13.5';

// On macOS kicad-happy runs in a daemon job and never here. Local runs are REMOTE_NO_DAEMON=1 and other hosts: CI and the native
// release image. tools/router/route-dispatch.mjs has the same rule. PCB_HOST_PLATFORM: what tests pass to cover another host.
export const happyRunsLocally = () => process.env.REMOTE_NO_DAEMON === '1' || (process.env.PCB_HOST_PLATFORM ?? process.platform) !== 'darwin';

// What runs kicad-happy, for the phase cache and the gate's provenance: a change of it invalidates both. tools/lib/kicad-happy-phases.ts
// compares it with what a run reports. In a job it is a fixed value, so the Mac starts no Python to ask.
let localRuntime;
export function happyRuntime() {
  if (!happyRunsLocally()) return `${PINNED_IMAGE} ${PINNED_IMAGE_PYTHON}`;
  localRuntime ??= `local ${execFileSync(modernPython(), ['--version'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim()}`;
  return localRuntime;
}

// A local run of kicad-happy needs Python 3.10 or later. The macOS python3 and the KiCad Python are 3.9.
// modernPython(): env PYTHON_MODERN, else the first python3.1x on PATH, else 'python3' (doctor.mjs then reports it). A call, not
// a value: importing this module must not start Python, and most tools that import it never need kicad-happy.
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
let modern;
export const modernPython = () => (modern ??= findModernPython());
