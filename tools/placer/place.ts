// Block placement on a board: the problem, the search and the candidate boards.
//
//   place.ts read  BOARD -o prob.json [flags of `iotplace read`] [--engineering-manifest M --engineering-board ID --engineering-root DIR]
//   place.ts run   prob.json -o result.json [--workers 16 --epochs 20 --steps 20000 --seed 1 --top 3] [--param w_ov=20 ...]
//   place.ts write BOARD prob.json result.json --outdir DIR [--initial]
//         DIR/candK/ = a copy of the board folder with candidate K placed (DIR/initial/ with --initial).
//   place.ts drc   DIR/candK/NAME.kicad_pcb ...
//         kicad-cli pcb drc --schematic-parity --refill-zones; prints errors, parity, unconnected and error types.
//   place.ts pinswap BOARD PINMAP.json -o proposal.json [flags of `iotplace pinswap`]
//   place.ts scramble prob.json -o out.json [--seed 1] [--sigma MM]
//
// The repo board is only read. Candidates are proposals: the board gates and a router decide.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { runMain, UsageError } from '../lib/cli.ts';
import { reviewedContract, type ReviewServices } from '../lib/engineering-constraints.ts';
import { kicadCli } from '../lib/env.mjs';
import { iotplaceBin } from '../lib/iotplace-bin.ts';
import { parseTyped, readTyped } from '../lib/json-file.ts';
import { defaultCpu, reserve } from '../lib/lean-resources.ts';
import { runStage } from '../lib/lean-stage.ts';
import { jsonDumps, number } from '../lib/py-compat.mjs';
import { projectRoot } from '../lib/project-root.mjs';
import { readProblem, withBoardDocument, writeBoard } from './board-io.ts';
import type { Num, Pose } from './compact-geometry.ts';
import { checkProblem, prepareProblem, reviewServices, rigidGroups, type ReviewedProblem, type Screen } from './engineering-problem.ts';
import { parseOptions } from './options.ts';

const USAGE = 'usage: place.ts read|run|write|drc|pinswap|scramble ...';
const FROZEN = '--engineering-frozen-model-sha256';

/** Removes `--name V` or `--name=V` from argv and gives V. */
function take(argv: string[], name: string): string | undefined {
  const at = argv.findIndex(word => word === name || word.startsWith(`${name}=`));
  if (at < 0) return undefined;
  const [word] = argv.splice(at, 1) as [string];
  return word === name ? argv.splice(at, 1)[0] : word.slice(name.length + 1);
}

function cmdRead(given: string[]): number {
  const argv = [...given];
  const manifest = take(argv, '--engineering-manifest') ?? process.env.PCB_ENGINEERING_MANIFEST;
  const board = take(argv, '--engineering-board') ?? process.env.PCB_ENGINEERING_BOARD;
  const root = take(argv, '--engineering-root') ?? process.env.PCB_ENGINEERING_ROOT ?? projectRoot();
  const output = take(argv, '-o');
  const [source] = argv.splice(0, 1);
  if (!source || source.startsWith('-') || !output) throw new UsageError('usage: place.ts read BOARD -o prob.json [flags]');
  const groups: string[] = [];
  if (manifest) {
    if (!board) throw new Error('--engineering-board is required with a reviewed manifest');
    const contract = reviewedContract(root, board, manifest, reviewServices);
    const rows = rigidGroups(contract).map(refs => refs.join(','));
    if (rows.length) groups.push('--rigid-group', ...rows);
  }
  process.stdout.write(readProblem(source, output, [...argv, ...groups]));
  if (manifest) writeFileSync(output, jsonDumps(prepareProblem(root, board as string, manifest, readTyped<ReviewedProblem>(output))));
  return 0;
}

interface Candidate { pose: Pose; illegal: string[]; mains: unknown[]; cost: Num; worker: Num; engineering?: Screen }
interface Result { candidates: Candidate[]; engineering_source_verification?: string }

/** Final candidate order: legal first, then no mains path faults, then the lower cost. */
const finalOrder = (a: Candidate, b: Candidate): number => a.illegal.length - b.illegal.length || a.mains.length - b.mains.length
  || number(a.cost) - number(b.cost) || number(a.worker) - number(b.worker);

async function search(prob: string, output: string, workers: number, flags: readonly string[]): Promise<number> {
  const command = [iotplaceBin(), 'run', prob, '-o', output, '--workers', String(workers), ...flags];
  return reserve(workers, { events: `${output}.admission.jsonl`, label: 'placement' }, async ({ env }) => {
    const { returncode } = await runStage(command, { stage: 'placement', env, stdout: 'inherit', stderr: 'inherit' });
    return returncode;
  });
}

export interface RunServices { review: ReviewServices; search: typeof search }

export async function cmdRun(argv: string[], { review, search: start }: RunServices = { review: reviewServices, search }): Promise<number> {
  const a = parseOptions(argv, {
    '-o': 'text', '--workers': 'int', '--epochs': 'int', '--steps': 'int', '--seed': 'int', '--top': 'int', '--param': 'words', [FROZEN]: 'text',
  }, 'usage: place.ts run prob.json -o result.json [--workers N ...]');
  const [prob] = a.positionals, output = a.text('-o');
  if (!prob || !output) throw new UsageError('usage: place.ts run prob.json -o result.json');
  const flags = ['--epochs', String(a.int('--epochs') ?? 20), '--steps', String(a.int('--steps') ?? 20000), '--seed', String(a.int('--seed') ?? 1),
    '--top', String(a.int('--top') ?? 3), ...(a.words('--param').length ? ['--param', ...a.words('--param')] : [])];
  const workers = a.int('--workers') ?? defaultCpu();
  const payload = readFileSync(prob);
  const problem = parseTyped<ReviewedProblem>(payload.toString('utf8'));
  const frozen = a.text(FROZEN);
  if (!problem.engineering && !frozen) return start(prob, output, workers, flags);
  const digest = createHash('sha256').update(payload).digest('hex');
  if ((frozen && digest !== frozen) || !problem.engineering) throw new Error('transferred engineering model fingerprint differs from verified producer input');
  const verifySources = !frozen;
  checkProblem(problem, null, { verifySources, services: review });   // Invalid coverage fails before admission.
  const code = await start(prob, output, workers, [...flags, FROZEN, digest]);
  if (!existsSync(output)) return code;
  const result = readTyped<Result>(output);
  for (const candidate of result.candidates) {
    const checked = checkProblem(problem, candidate.pose, { verifySources, services: review });
    candidate.engineering = checked;
    candidate.illegal.push(...checked.blockers.map(blocker => `engineering:${String(blocker.id)}`));
  }
  result.candidates.sort(finalOrder);
  result.engineering_source_verification = frozen ? 'frozen_model_only; producer must recheck original sources before writing' : 'current_source_inputs_verified';
  writeFileSync(output, jsonDumps(result));
  if (result.candidates[0]?.illegal.length !== 0) {
    console.log('NO LEGAL CANDIDATE');
    return 3;
  }
  return 0;
}

const NOT_COPIED = (name: string): boolean => name.endsWith('.kicad_prl') || name.endsWith('-backups') || name === 'fp-info-cache';

export function cmdWrite(argv: string[], review: ReviewServices = reviewServices): number {
  const a = parseOptions(argv, { '--outdir': 'text', '--initial': 'switch' }, 'usage: place.ts write BOARD prob.json result.json --outdir DIR [--initial]');
  const [board, prob, result] = a.positionals, outdir = a.text('--outdir');
  if (!board || !prob || !result || !outdir) throw new UsageError('usage: place.ts write BOARD prob.json result.json --outdir DIR [--initial]');
  const problem = readTyped<ReviewedProblem>(prob);
  const jobs: [string, Pose][] = readTyped<Result>(result).candidates.map((candidate, k) => [`cand${k}`, candidate.pose]);
  if (a.has('--initial')) jobs.unshift(['initial', problem.units.map(unit => [unit.x, unit.y, 0])]);
  // A rejected reviewed pose must leave what is already in the output folder.
  if (problem.engineering) {
    if (realpathSync(board) !== realpathSync(problem.board_file)) throw new Error('reviewed placement writer source differs from its native model');
    for (const [, pose] of jobs) {
      const checked = checkProblem(problem, pose, { services: review });
      if (checked.status !== 'passed') throw new Error(`reviewed placement rejected before writing: ${jsonDumps(checked.blockers)}`);
    }
  }
  const source = dirname(resolve(board));
  for (const [name, pose] of jobs) {
    const folder = join(outdir, name);
    rmSync(folder, { recursive: true, force: true });
    cpSync(source, folder, { recursive: true, filter: path => !NOT_COPIED(basename(path)) });
    const output = join(folder, basename(board));
    rmSync(output);
    console.log(name, output, JSON.stringify(writeBoard(board, problem, pose, output)));
  }
  return 0;
}

interface DrcReport { violations?: { severity?: string; type: string }[]; schematic_parity?: unknown[]; unconnected_items?: unknown[] }

function drcSummary(board: string) {
  const output = `${board.slice(0, -extname(board).length)}-drc.json`;
  spawnSync(kicadCli, ['pcb', 'drc', '--schematic-parity', '--refill-zones', '--format', 'json', '-o', output, board], { stdio: 'ignore' });
  const report = JSON.parse(readFileSync(output, 'utf8')) as DrcReport;
  const errors = (report.violations ?? []).filter(row => row.severity === 'error');
  const types: Record<string, number> = {};
  for (const row of errors) types[row.type] = (types[row.type] ?? 0) + 1;
  return { errors: errors.length, parity: report.schematic_parity?.length ?? 0, unconnected: report.unconnected_items?.length ?? 0, error_types: types };
}

function cmdDrc(boards: string[]): number {
  if (!boards.length) throw new UsageError('usage: place.ts drc BOARD ...');
  for (const board of boards) console.log(board, JSON.stringify(drcSummary(board)));
  return 0;
}

function cmdPinswap(argv: string[]): number {
  const [board] = argv;
  if (!board || board.startsWith('-')) throw new UsageError('usage: place.ts pinswap BOARD PINMAP.json -o proposal.json');
  withBoardDocument(board, document => execFileSync(iotplaceBin(), ['pinswap', board, `--board-json=${document}`, ...argv.slice(1)], { stdio: 'inherit' }));
  return 0;
}

function cmdScramble(argv: string[]): number {
  execFileSync(iotplaceBin(), ['scramble', ...argv], { stdio: 'inherit' });
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'read': return cmdRead(rest);
    case 'run': return cmdRun(rest);
    case 'write': return cmdWrite(rest);
    case 'drc': return cmdDrc(rest);
    case 'pinswap': return cmdPinswap(rest);
    case 'scramble': return cmdScramble(rest);
    default: throw new UsageError(USAGE);
  }
}

runMain(import.meta.url, main);
