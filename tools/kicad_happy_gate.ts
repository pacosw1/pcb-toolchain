// Gate a board on a fixed set of kicad-happy rule IDs.
//
// kicad-happy (MIT, https://github.com/aklofas/kicad-happy) is a schematic / PCB / EMC analyzer in Python. Its scripts
// exit 0 even on internal errors, so this wrapper checks their JSON output itself and turns matching findings into a
// non-zero exit code.
//
// It runs three pinned kicad-happy scripts, in this order, through tools/lib/kicad-happy-phases.ts: on macOS in daemon jobs, whose
// results are kept by content, so no Python starts on the Mac. The wrapper reads their outputs here:
//   1. analyze_schematic.py  needed for UC-001 (VBUS decoupling), which is schematic-only and never appears in the PCB
//      or EMC output.
//   2. analyze_pcb.py --full needed for VP-001 (via in pad) and to feed return-path data to the EMC analyzer.
//   3. analyze_emc.py        needed for GP-001 (ground-plane coverage) and RP-001 (return-path via at a layer change).
// Findings from all three are merged, then filtered to the allowed rule IDs. Every other kicad-happy rule (KO-001,
// SU-001, VM-001, PM-002, CC-002, XT-001, ...) is ignored: those were evaluated and found false on our boards.
//
//   tools/kicad_happy_gate.ts BOARD_DIR_OR_PCB [--rules RP-001,DC-002,UC-001] [--min-severity warning]
//       [--exempt RULE:NET ...] [--exempt-file EXEMPT.json] [--ground NET ...] [--planes reference-planes.json]
//       [--result FILE]
//
// An exemption drops a finding when its rule matches and the finding names that net. The file is a JSON list of
// {"rule", "net" or "ref", "reason"}; a "ref" entry drops findings of the rule that name that component. The reason is
// required. An exemption that matches no finding is stale: it prints "STALE exempt ..." and gives exit 2, so exemptions
// cannot rot.
//
// Exit codes: 0 no matching findings, 1 one or more matching findings, 2 tool error (missing/unpinned clone, bad board
// path, analyzer crash, unreachable daemon, bad or stale exemption).
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { errorText, parseFlags, runMain, UsageError } from './lib/cli.ts';
import { creditOwnHoles, markGroundVias, plainJson, returnRadius, takeExemptTransitions, takeReturnStitched, type Tree } from './lib/kicad-happy-board.ts';
import { evaluate, loadExemptFile, parseExemptArgs, SEVERITY_ORDER, type Exemption, type Finding } from './lib/kicad-happy-findings.ts';
import { analyzeBoard, analyzeEmc, type Board, type Happy } from './lib/kicad-happy-phases.ts';
import { fixed, floatRepr, jsonDumps, jsonLoads, pyRepr, pyStr, readText } from './lib/py-compat.mjs';

const USAGE = 'usage: tools/kicad_happy_gate.ts BOARD_DIR_OR_PCB [--result FILE] [--rules A,B] [--min-severity LEVEL] '
  + '[--exempt RULE:NET] [--exempt-file FILE] [--ground NET] [--planes FILE]';
const PINNED_COMMIT = 'a6bba1a';
// VP-001 is left out: kicad-happy a6bba1a reads the KiCad 10 tenting format as untented. pcbtool viapads (with --allow
// for datasheet vias) is the via-in-pad gate. GP-001 (reference coverage < 95 / 80 / 50 %) is left out since D-124
// (2026-10-09): no standard or checker gives a coverage percentage (report
// hardware-design/reports/2026-10-09-design-rules-sources.md A2, NO SOURCE). The si_planes crossing and detour rules
// replace it. Run it by hand with --rules GP-001 if needed.
const DEFAULT_RULES = ['RP-001', 'DC-002', 'UC-001'];

interface Options {
  rules: string[];
  minSeverity: string | undefined;
  grounds: string[];
  planes: string | undefined;
  result: string | undefined;
  board: string;
  exempts: string[];
  exemptFile: string | undefined;
}

const resolveHappyDir = () => process.env.KICAD_HAPPY_DIR || join(homedir(), 'Documents/GitHub/kicad-happy');
const isDir = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;

/** An error message if the clone is missing or not pinned, else null. */
export function checkPinned(happyDir: string): string | null {
  if (!isDir(happyDir)) return `kicad-happy clone not found at ${happyDir}. Set KICAD_HAPPY_DIR or clone it there.`;
  // A git hook exports GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE: without this, the pre-commit hook reads the iot-lab HEAD
  // instead of the kicad-happy clone and the pin check fails closed.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const command = ['git', '-C', happyDir, 'rev-parse', 'HEAD'];
  const run = spawnSync(command[0]!, command.slice(1), { encoding: 'utf8', env });
  if (run.error) return `kicad-happy at ${happyDir} is not a git repository: ${errorText(run.error)}`;
  if (run.status !== 0) {
    return `kicad-happy at ${happyDir} is not a git repository: Command ${pyRepr(command)} returned non-zero exit status ${run.status}.`;
  }
  const head = run.stdout.trim();
  if (head.startsWith(PINNED_COMMIT)) return null;
  return `kicad-happy at ${happyDir} is at commit ${head.slice(0, 12)}, not the pinned commit ${PINNED_COMMIT}.`;
}

const withSuffix = (folder: string, suffix: string) => readdirSync(folder).filter(name => name.endsWith(suffix)).sort();

/** The board of a .kicad_pcb file or a board folder. sch is null when no single .kicad_sch sits beside the board. */
export function resolveBoard(boardDirOrPcb: string): Board {
  const path = resolve(boardDirOrPcb);
  let pcb: string;
  if (isFile(path) && path.endsWith('.kicad_pcb')) {
    pcb = path;
  } else if (isDir(path)) {
    const pcbs = withSuffix(path, '.kicad_pcb');
    if (pcbs.length !== 1) throw new Error(`Expected exactly one .kicad_pcb in ${path}, found ${pcbs.length}.`);
    pcb = join(path, pcbs[0]!);
  } else {
    throw new Error(`${boardDirOrPcb} is not a .kicad_pcb file or a directory.`);
  }
  const folder = dirname(pcb);
  const schematics = withSuffix(folder, '.kicad_sch');
  const root = `${pcb.slice(0, -'.kicad_pcb'.length)}.kicad_sch`;
  return { pcb, sch: isFile(root) ? root : schematics.length === 1 ? join(folder, schematics[0]!) : null };
}

/** The merged raw findings of the three analyzers. */
function runGate(happy: Happy, board: Board, grounds: string[], exemptRpNets: Set<string>, rpRadius: number | null): Finding[] {
  const analysis = analyzeBoard(happy, board);
  const findings = [...analysis.schematic?.report.findings ?? [], ...analysis.pcb.report.findings];
  const doc = analysis.pcb.tree as Tree;
  if (grounds.length) markGroundVias(doc, grounds);
  if (rpRadius) {
    const stitched = takeReturnStitched(doc, rpRadius, analysis.pads);
    console.error(`RP-001 return radius ${fixed(rpRadius, 2)} mm (stackup): ${stitched} transitions stitched`);
  }
  findings.push(...takeExemptTransitions(doc, exemptRpNets));
  for (const { net, old, pct } of creditOwnHoles(doc, analysis.samples, analysis.pads)) {
    console.error(`GP-001 own-hole antipad credit: ${net} ${pyStr(old ?? null)}% -> ${floatRepr(pct)}%`);
  }
  findings.push(...analyzeEmc(happy, analysis, jsonDumps(doc)).findings);
  return findings;
}

function parseArguments(argv: string[]): Options {
  const { values, positionals } = parseFlags(argv, {
    result: { type: 'string' },
    rules: { type: 'string' },
    'min-severity': { type: 'string' },
    exempt: { type: 'string', multiple: true },
    'exempt-file': { type: 'string' },
    ground: { type: 'string', multiple: true },
    planes: { type: 'string' },
  }, USAGE);
  const [board] = positionals;
  const minSeverity = values['min-severity'];
  if (positionals.length !== 1 || board === undefined) throw new UsageError(USAGE);
  if (minSeverity !== undefined && !SEVERITY_ORDER.includes(minSeverity)) throw new UsageError(USAGE);
  return {
    board,
    minSeverity,
    rules: (values.rules ?? DEFAULT_RULES.join(',')).split(',').map(rule => rule.trim()).filter(Boolean),
    grounds: values.ground ?? [],
    planes: values.planes,
    result: values.result,
    exempts: values.exempt ?? [],
    exemptFile: values['exempt-file'],
  };
}

function loadExemptions(options: Options): Exemption[] {
  const fromArguments = parseExemptArgs(options.exempts);
  if (!options.exemptFile) return fromArguments;
  return [...fromArguments, ...loadExemptFile(plainJson(jsonLoads(readText(options.exemptFile))))];
}

function main(argv: string[]): number {
  const options = parseArguments(argv);
  const fail = (error: unknown) => {
    console.error(`ERROR: ${errorText(error)}`);
    return 2;
  };
  let exemptions: Exemption[];
  let board: Board;
  const happyDir = resolveHappyDir();
  try {
    exemptions = loadExemptions(options);
    const unpinned = checkPinned(happyDir);
    if (unpinned) return fail(unpinned);
    board = resolveBoard(options.board);
  } catch (error) {
    return fail(error);
  }
  let findings: Finding[];
  try {
    const rpNets = new Set(exemptions.filter(exemption => exemption.rule === 'RP-001' && exemption.net).map(exemption => exemption.net!));
    const radius = options.planes ? returnRadius(board.pcb, options.planes) : null;
    if (options.planes && radius === null) return fail('--planes given but no return dielectric from the stackup / adjacent map');
    findings = runGate({ dir: happyDir, commit: PINNED_COMMIT }, board, options.grounds, rpNets, radius);
  } catch (error) {
    return fail(error);
  }
  const { lines, code, kept, stale } = evaluate(findings, options.rules, options.minSeverity, exemptions);
  if (options.result) {
    writeFileSync(options.result, jsonDumps({ schema_version: 1, completed: true, findings: kept.length, stale_exemptions: stale.length, exit: code }));
  }
  for (const line of lines) console.log(line);
  return code;
}

runMain(import.meta.url, main);
