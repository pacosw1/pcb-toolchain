// The Python half of the kicad-happy gate: two phases of one sh script, each kept by content. The wrapper corrects the
// analyze_pcb JSON between them, so editing an exemption reruns at most the second phase.
//
//   phase a  analyze_schematic, analyze_pcb --full --gp001-debug and the pad reader, on the board's design files
//   phase b  analyze_emc on the corrected pcb.json
//
// The script runs in a daemon job, because the job image has kicad-happy's Python and this Mac must not start one. It runs on
// this host only where env.mjs happyRunsLocally() says so: same script, same folder layout. An unreachable daemon is an error.
//
// Each step leaves <step>.code and <step>.stderr in out/. kicad-happy's scripts exit 0 on internal errors, so a phase counts only
// when every step and every report passes the checks here, and only then is it kept. Not shipped: .kicad-happy.json, which no
// project has, and datasheets, which only the DS rules, DP-002 and the derating checks read: none is a rule of a gate.
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { cacheFolder, cachedWhole, contentKey, runDaemonJob } from './daemon-job.ts';
import { happyRunsLocally, happyRuntime, modernPython, PINNED_IMAGE } from './env.mjs';
import { happyTar } from './happy-tar.mjs';
import { sha256File } from './json-file.ts';
import { plainJson, type Pad, type Sample } from './kicad-happy-board.ts';
import type { Finding } from './kicad-happy-findings.ts';
import { jsonLoads, readText, strip } from './py-compat.mjs';

const SCHEMATIC_SCRIPT = 'skills/kicad/scripts/analyze_schematic.py';
const PCB_SCRIPT = 'skills/kicad/scripts/analyze_pcb.py';
const EMC_SCRIPT = 'skills/emc/scripts/analyze_emc.py';
const STDERR_SHOWN = 500;
const DESIGN_TAR = 'design.tar';
// To tune. ENV-SENSE and PWR-24V-5V are the only boards measured: the analyzers are one thread. A wait as long as a route's
// (tools/router/route-dispatch.mjs QUEUE_WAIT_S: 90 % of the host's busy spells were over in 210 s).
const JOB_TIMEOUT_S = 600;
const JOB_CPUS = 1;
const JOB_MEM_GB = 4;
const JOB_QUEUE_WAIT_S = 300;

// The one call into kicad-happy's own code that is not one of its scripts: analyze_pcb leaves the pads out of its JSON.
// The pad geometry has to be the geometry of its analysis, so this asks its parser and does nothing else.
const LOAD_PADS = `import json, sys
sys.path.insert(0, sys.argv[1])
import sexp_parser
import analyze_pcb
pads = [p for f in analyze_pcb.extract_footprints(sexp_parser.parse_file(sys.argv[2])) for p in f.get("pads", [])]
json.dump(pads, open(sys.argv[3], "w"))
`;

// Runs in a folder with in/: sh -c PHASE_SCRIPT _ a BOARD.kicad_pcb SCHEMATIC, or _ b WITH_SCHEMATIC. SCHEMATIC is relative to
// the project, empty when there is none. Stops at the first step with an exit code; the checks below read what is there.
// --gp001-debug writes next to the board, and analyze_pcb never read the board's folder: board/ holds only what it reads.
export const PHASE_SCRIPT = `set -e
mkdir -p out .happy
tar -xzf in/kicad-happy-*.tar.gz -C .happy
py=\${PYTHON:-python3}
"$py" --version > out/python.txt
set +e
step() {
  name=$1
  shift
  "$@" > /dev/null 2> "out/$name.stderr"
  code=$?
  echo "$code" > "out/$name.code"
  [ "$code" -eq 0 ] || exit 0
}
if [ "$1" = a ]; then
  pcb=$2
  sch=$3
  stem=\${pcb%.kicad_pcb}
  mkdir design board
  tar -xf in/${DESIGN_TAR} -C design || exit 1
  for name in "$pcb" "$stem.kicad_pro" "$stem.kicad_dru"; do
    if [ -f "design/$name" ]; then cp "design/$name" board/ || exit 1; fi
  done
  set --
  if [ -n "$sch" ]; then
    step sch "$py" .happy/${SCHEMATIC_SCRIPT} "design/$sch" -o out/sch.json
    set -- --schematic out/sch.json
  fi
  step pcb "$py" .happy/${PCB_SCRIPT} "board/$pcb" --full --gp001-debug "$@" -o out/pcb.json
  step pads "$py" -c '${LOAD_PADS}' .happy/skills/kicad/scripts "design/$pcb" out/pads.json
  if [ -f board/gp001_debug.json ]; then cp board/gp001_debug.json out/ || exit 1; fi
else
  schematic=$2
  set --
  if [ "$schematic" = yes ]; then set -- --schematic in/sch.json; fi
  step emc "$py" .happy/${EMC_SCRIPT} --pcb in/pcb.json "$@" -o out/emc.json
fi
`;

export interface Board { pcb: string; sch: string | null }
interface Report { findings: Finding[] }
/** An analyzer's output: the tree goes back to kicad-happy, the report is read here. */
interface Analyzed { report: Report; tree: unknown }
export interface BoardAnalysis {
  schematic: Analyzed | null;
  /** The schematic's analysis as analyze_schematic wrote it, for phase b. */
  schematicJson: string | null;
  pcb: Analyzed;
  pads: Pad[];
  samples: Sample[];
}
/** The pinned clone: a phase ships it and the commit is in each key. */
export interface Happy { dir: string; commit: string }

const isDict = (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value);
/** Python's bool() of a JSON value: an empty list or dict counts as nothing. */
const present = (value: unknown) => (typeof value === 'object' && value !== null ? Object.keys(value).length > 0 : Boolean(value));

/** The analyzer's report, whose exit code says nothing: only a complete document counts. */
export function checkReport(script: string, doc: unknown): Report {
  const report = doc as { error?: unknown; errors?: unknown; findings?: unknown };
  const complete = isDict(report) && !present(report.error) && !present(report.errors)
    && Array.isArray(report.findings) && report.findings.every(isDict);
  if (!complete) throw new Error(`${script} produced an incomplete or error report`);
  return report as Report;
}

function step(out: string, name: string): { code: number; stderr: string } {
  const file = join(out, `${name}.code`);
  if (!existsSync(file)) throw new Error(`kicad-happy step ${name} did not run`);
  return { code: Number(readText(file)), stderr: strip(readText(join(out, `${name}.stderr`))) };
}

function analyzed(out: string, name: string, script: string): Analyzed {
  const { code, stderr } = step(out, name);
  const shown = stderr.slice(0, STDERR_SHOWN);
  if (code !== 0) throw new Error(`${script} failed (exit ${code}): ${shown}`);
  const output = join(out, `${name}.json`);
  if (!existsSync(output)) throw new Error(`${script} produced no output (exit ${code}): ${shown}`);
  const tree = jsonLoads(readText(output));
  return { report: checkReport(script, plainJson(tree)), tree };
}

function pads(out: string): Pad[] {
  const { code, stderr } = step(out, 'pads');
  if (code !== 0) throw new Error(`kicad-happy pad reader failed (exit ${code}): ${stderr.slice(-STDERR_SHOWN)}`);
  return plainJson(jsonLoads(readText(join(out, 'pads.json')))) as Pad[];
}

function debugSamples(out: string): Sample[] {
  const path = join(out, 'gp001_debug.json');
  if (!existsSync(path)) throw new Error('analyze_pcb.py --gp001-debug wrote no gp001_debug.json');
  return (plainJson(jsonLoads(readText(path))) as { samples?: Sample[] }).samples ?? [];
}

/** The runtime is a promise of the gate's provenance, so a run on anything else counts for nothing. */
function checkRuntime(out: string, runtime: string): void {
  const python = readText(join(out, 'python.txt')).trim();
  if (!runtime.endsWith(python)) throw new Error(`kicad-happy ran on ${python}, not on ${runtime}`);
}

const SHEET_FILE = /\(property "Sheetfile" "([^"]+)"/g;

/** Every schematic and project of the board's folder, its subfolders included, and the board's own files; relative, sorted. */
export function designFiles(board: Board): string[] {
  const folder = dirname(board.pcb);
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.name.startsWith('.')) return [];
    if (entry.isDirectory()) return walk(path);
    return /\.kicad_(sch|pro)$/.test(entry.name) ? [path] : [];
  });
  const own = ['.kicad_pcb', '.kicad_dru'].map(suffix => board.pcb.replace(/\.kicad_pcb$/, suffix)).filter(file => existsSync(file));
  const files = [...new Set([...own, ...walk(folder)])];
  for (const file of files.filter(name => name.endsWith('.kicad_sch'))) {
    for (const [, sheet] of readText(file).matchAll(SHEET_FILE)) {
      if (relative(folder, resolve(dirname(file), sheet!)).startsWith('..')) throw new Error(`${file}: sheet ${sheet} is outside the project folder`);
    }
  }
  return files.map(file => relative(folder, file)).sort();
}

function writeDesignTar(folder: string, files: string[], tar: string): void {
  const run = spawnSync('tar', ['--no-xattrs', '-cf', tar, '-C', folder, ...files], { encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' } });
  if (run.status !== 0) throw new Error(`tar of ${folder} failed: ${run.stderr}`);
}

function runInJob(inputs: string[], args: string[], fresh: string): void {
  runDaemonJob({ label: `kicad-happy phase ${args[0]} job`, inputs, image: PINNED_IMAGE, timeoutS: JOB_TIMEOUT_S, cpus: JOB_CPUS, memGb: JOB_MEM_GB,
    queueWaitS: JOB_QUEUE_WAIT_S, name: `kicad-happy-${args[0]}`, command: ['sh', '-c', PHASE_SCRIPT, '_', ...args] },
  out => cpSync(out, fresh, { recursive: true }));
}

function runHere(inputs: string[], args: string[], fresh: string): void {
  const work = mkdtempSync(join(tmpdir(), 'kicad-happy-phase-'));
  try {
    mkdirSync(join(work, 'in'));
    for (const file of inputs) copyFileSync(file, join(work, 'in', basename(file)));
    const run = spawnSync('sh', ['-c', PHASE_SCRIPT, '_', ...args], { cwd: work, encoding: 'utf8', env: { ...process.env, PYTHON: modernPython() } });
    if (run.status !== 0) throw new Error(`kicad-happy phase ${args[0]} ended with ${run.status}: ${run.stderr.slice(-STDERR_SHOWN)}`);
    cpSync(join(work, 'out'), fresh, { recursive: true });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The outputs of one phase, kept under the key of all it depends on. `read` is the check, of a kept phase too. */
function phase<T>(happy: Happy, inputs: (stage: string) => string[], args: string[], keyed: string[], read: (out: string) => T): T {
  const runtime = happyRuntime();
  const checked = (out: string) => {
    checkRuntime(out, runtime);
    return read(out);
  };
  const key = contentKey([PHASE_SCRIPT, happy.commit, runtime, ...args, ...keyed]);
  return cachedWhole(join(cacheFolder('kicad-happy'), key), checked, fresh => {
    const stage = mkdtempSync(join(tmpdir(), 'kicad-happy-stage-'));
    try {
      (happyRunsLocally() ? runHere : runInJob)([...inputs(stage), happyTar(happy.dir, happy.commit)], args, fresh);
      return checked(fresh);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });
}

/** Phase a. The key is the design's content, not its place: a copy of a board in a scratch folder hits. */
export function analyzeBoard(happy: Happy, board: Board): BoardAnalysis {
  const project = dirname(board.pcb);
  const files = designFiles(board);
  const tar = (stage: string) => {
    const file = join(stage, DESIGN_TAR);
    writeDesignTar(project, files, file);
    return [file];
  };
  const args = ['a', basename(board.pcb), board.sch ? relative(project, board.sch) : ''];
  return phase(happy, tar, args, files.map(file => `${file}=${sha256File(join(project, file))}`), out => ({
    schematic: board.sch ? analyzed(out, 'sch', SCHEMATIC_SCRIPT) : null,
    schematicJson: board.sch ? readFileSync(join(out, 'sch.json'), 'utf8') : null,
    pcb: analyzed(out, 'pcb', PCB_SCRIPT),
    pads: pads(out),
    samples: debugSamples(out),
  }));
}

/** Phase b, on the text of the corrected pcb.json. */
export function analyzeEmc(happy: Happy, { schematicJson: schematic }: BoardAnalysis, pcbJson: string): Report {
  const inputs = (stage: string) => {
    writeFileSync(join(stage, 'pcb.json'), pcbJson);
    if (schematic !== null) writeFileSync(join(stage, 'sch.json'), schematic);
    return ['pcb.json', ...schematic === null ? [] : ['sch.json']].map(name => join(stage, name));
  };
  const keyed = [contentKey([pcbJson]), schematic === null ? 'no schematic' : contentKey([schematic])];
  return phase(happy, inputs, ['b', schematic === null ? 'no' : 'yes'], keyed, out => analyzed(out, 'emc', EMC_SCRIPT).report);
}
