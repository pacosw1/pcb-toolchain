// Failure-driven placement repair: the in-house router is the judge (idea: TraceMaker src/place/routable.cpp at c6fcb7b,
// tools/pcb_search/README.md "Repair locally"). README "Failure-driven repair" has the method and the results.
//
//   repair.ts prepare SRC.kicad_pcb PLACE.kicad_pcb --board BOARD [--keep lock-nets|locked]
//   repair.ts run BOARD PLACE.kicad_pcb ROUTED.kicad_pcb --outdir DIR [--mode reuse|local|full] [--max-routes 8] [--per-round 4]
//         [--iters 80] [--seed 1] [--no-rotate] [--no-decap-slide] [--rank term|hot] [--read ARG ...]
//
// prepare: the placement board. A copy of SRC with only the lock-net copper (diff pairs + DRU via_count 0 nets, as iotroute run
// --lock-from), locked, and all footprints unlocked. --keep locked also keeps every other locked track and via of SRC (the hand
// geometry: crystals and the locked GND stubs of fixed pads).
//
// run: ROUTED is an iotroute run result of PLACE, with ROUTED.iotroute/drc.json. A round: the KiCad DRC failures of the route, the
// moves `iotplace repair-proposals` ranks for them, each move written and routed (reuse: the moved placement with --reuse ROUTED;
// local: on a copy of ROUTED with the copper near the failures ripped; full: a whole route). A move is accepted only when its
// measured key is strictly lower, and the next round starts from it. Stop: score 0, no proposal, a round without improvement,
// --max-routes, or only failures that no move can repair (a DRC item on a pad of a fixed unit that the router reports walled in by
// fixed input copper). DIR/repair.json holds every attempt and the verdict. The result is a scratch candidate only.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BoardEdit, formEnd, formsByUuid, saveBoardInPlace } from '../lib/board-edit.ts';
import { boardJson } from '../lib/board-json.ts';
import { type BoardDocument, type Pt, type RoutedCopper, toMm } from '../lib/board-types.ts';
import { parseFlags, runMain, UsageError } from '../lib/cli.ts';
import { iotplaceBin } from '../lib/iotplace-bin.ts';
import { iotrouteBin } from '../lib/iotroute-bin.ts';
import { readJson, readPyJson, readTyped } from '../lib/json-file.ts';
import { snapshot } from '../lib/pcb-sources.ts';
import { Float, jsonDumps, number } from '../lib/py-compat.mjs';
import { hypot } from '../lib/py-math.ts';
import { isDirectory, isFile } from '../lib/py-path.ts';
import { type Dict, isDict, need } from '../lib/py-values.ts';
import { readProblem, writeBoard } from './board-io.ts';
import type { Pose, Problem } from './compact-geometry.ts';
import type { ReviewedProblem } from './engineering-problem.ts';
import { type Gate, GateWorkspace, gatePart, type Metrics, NO_RESULT, routeStep } from './iotroute-step.ts';

export { NO_RESULT };

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SIDECARS = ['.kicad_pro', '.kicad_dru', '.kicad_sch'];
const TABLES = ['fp-lib-table', 'sym-lib-table'];
/** The legalizer grid the proposals search: legal_step and legal_radius of tools/placer/core/src/params.rs. */
const LEGAL_STEP = 0.25;
const LEGAL_RADIUS = 5.0;
/** The --decap-tie of a read that names none (tools/placer/core/src/read). */
const DEFAULT_TIE = 3.0;

const PAD_ITEM = /^Pad (\S+) \[([^\]]*)\] of (\S+) on/;
const NET_ITEM = /\[([^\]]*)\]/;
const WALLED = /^pour: (\S+)\.(\S+) on (\S+): .*fixed copper alone walls it in \(input\)/;

export type Point = [number, number];
export interface FailureItem { point: Point | null; ref: string | null; pad: string | null; net: string | null; text: string }
export interface Failure { kind: 'drc' | 'unconnected' | 'parity'; type: string; items: FailureItem[] }

/** Lexicographic: (DRC part, gate part, length, vias). Lower is better. */
export type Key = number[];

export interface Proposal {
  problem: 'main' | 'loose'; kind?: 'escape'; unit: number; name: string; x: number; y: number; r: number;
  term: number; term0: number; dcost: number; disp: number; dhot?: number;
}
/** What `iotplace repair-proposals` answers. */
export interface Round { candidates: string[]; escape: Proposal[]; proposals: Proposal[] }

// ---------- failures ----------

function parseItem(item: Dict): FailureItem {
  const text = (item.description ?? '') as string;
  const pos = (item.pos || {}) as Dict;
  const point: Point | null = 'x' in pos && 'y' in pos ? [number(pos.x), number(pos.y)] : null;
  const pad = PAD_ITEM.exec(text);
  const net = pad ? pad[2]! : NET_ITEM.exec(text)?.[1] ?? null;
  return { point: text.startsWith('Zone ') ? null : point, ref: pad?.[3] ?? null, pad: pad?.[1] ?? null, net, text };
}

/** KiCad DRC report to failures: 'drc' (severity error), 'unconnected' or 'parity'. */
export function parseFailures(drc: Dict): Failure[] {
  const rows = (name: string) => (drc[name] ?? []) as Dict[];
  const items = (row: Dict) => ((row.items ?? []) as Dict[]).map(parseItem);
  return [
    ...rows('violations').filter(v => v.severity === 'error').map(v => ({ kind: 'drc' as const, type: (v.type ?? '?') as string, items: items(v) })),
    ...rows('unconnected_items').map(v => ({ kind: 'unconnected' as const, type: 'unconnected', items: items(v) })),
    ...rows('schematic_parity').map(v => ({ kind: 'parity' as const, type: (v.type ?? '?') as string, items: items(v) })),
  ];
}

const padKey = (ref: string, pad: string): string => `${ref}\0${pad}`;

/** The pads that the router (route.json notes of a full route) reports as walled in by the fixed input copper alone: no move of
 *  another unit can open them. Each is padKey(ref, pad). */
export function walledPads(notes: readonly string[] | null | undefined): Set<string> {
  const hits = (notes ?? []).map(note => WALLED.exec(note)).filter(hit => hit !== null);
  return new Set(hits.map(hit => padKey(hit[1]!, hit[2]!)));
}

/** Reference to unit index. */
const refUnits = (pr: Problem): Map<string, number> => new Map(pr.units.flatMap((u, i) => (u.refs ?? []).map(ref => [ref, i] as [string, number])));

/** [failures a move may repair, failures of a walled pad of a fixed unit]. */
export function splitWalled(fails: readonly Failure[], walled: ReadonlySet<string>, pr: Problem): [Failure[], Failure[]] {
  const byRef = refUnits(pr);
  const inputFault = (f: Failure): boolean => {
    const pads = f.items.filter(it => it.ref).map(it => [it.ref as string, it.pad as string] as const);
    return f.kind === 'drc' && pads.length > 0 && pads.every(([ref, pad]) => walled.has(padKey(ref, pad)))
      && pads.every(([ref]) => !byRef.has(ref) || pr.units[byRef.get(ref)!]!.fixed);
  };
  return [fails.filter(f => !inputFault(f)), fails.filter(inputFault)];
}

export const failurePoints = (fails: readonly Failure[]): Point[] => fails.flatMap(f => f.items.flatMap(it => (it.point === null ? [] : [it.point])));

/** Nets of the unconnected items: local mode rips their copper. */
export const failureNets = (fails: readonly Failure[]): string[] =>
  [...new Set(fails.filter(f => f.kind === 'unconnected').flatMap(f => f.items.flatMap(it => (it.net ? [it.net] : []))))].sort();

/** --decap-tie of the read arguments. */
export function readTie(readArgs: readonly string[]): number {
  for (const [k, arg] of readArgs.entries()) {
    if (arg === '--decap-tie') return Number(readArgs[k + 1]);
    if (arg.startsWith('--decap-tie=')) return Number(arg.slice('--decap-tie='.length));
  }
  return DEFAULT_TIE;
}

// ---------- score ----------

/** The key of a route step's score.json. */
export function scoreKey(summary: Dict): Key {
  const rec = (summary.run || {}) as Dict;
  if (rec.status !== 'PASS' && rec.status !== 'FAIL') return [NO_RESULT, NO_RESULT, Infinity, Infinity];
  const drc = number(need(rec, 'drc_errors')) + number(need(rec, 'unconnected')) + number(need(rec, 'parity'));
  let gate = NO_RESULT;
  const metrics = summary.gate_metrics as Metrics | null | undefined;
  if (drc === 0 && metrics !== null && metrics !== undefined) {
    const [total, complete] = gatePart(metrics);
    gate = complete ? total : NO_RESULT;
  }
  return [drc, gate, number(rec.track_length_mm ?? 0) || Infinity, Math.trunc(number(rec.vias ?? 0))];
}

export function better(a: readonly number[], b: readonly number[]): boolean {
  const k = a.findIndex((value, at) => value !== b[at]);
  return k >= 0 && a[k]! < b[k]!;
}

export const passed = (key: readonly number[]): boolean => key[0] === 0 && key[1] === 0;

// ---------- board files ----------

const sheetsOf = (root: string, base: string): string[] =>
  execFileSync(iotrouteBin(), ['sheets', root, base], { encoding: 'utf8' }).split('\n').filter(Boolean);

/** Project files of src next to dst, named after dst. Called after every save: a save can rewrite the .kicad_pro. */
export function copySidecars(srcPcb: string, dstPcb: string, sheets: typeof sheetsOf = sheetsOf): void {
  const [src, dst] = [resolve(srcPcb), resolve(dstPcb)];
  const [from, to, srcName, dstName] = [dirname(src), dirname(dst), parse(src).name, parse(dst).name];
  for (const extension of SIDECARS) {
    if (isFile(join(from, srcName + extension))) copyFileSync(join(from, srcName + extension), join(to, dstName + extension));
  }
  for (const table of TABLES) {
    if (isFile(join(from, table))) copyFileSync(join(from, table), join(to, table));
  }
  // sub-sheets of a hierarchical schematic (FW-IO blocks/X.kicad_sch): without them the parity check of the copy reads a partial
  // netlist (FW-IO compaction step 0: 55 extra_footprint items on a board with parity 0)
  const root = join(from, `${srcName}.kicad_sch`);
  if (isFile(root) && from !== to) {
    for (const sheet of sheets(root, from)) {
      mkdirSync(dirname(join(to, sheet)), { recursive: true });
      copyFileSync(join(from, sheet), join(to, sheet));
    }
  }
}

const endsOf = (item: RoutedCopper): Pt[] => ('Track' in item ? [item.Track.start, item.Track.end] : [item.Via.at]);
const detail = (item: RoutedCopper) => ('Track' in item ? item.Track : item.Via);

/** Ids of the unlocked copper clusters (tracks and vias of one net that share an end point) with an end within `radius` of a point
 *  or on one of `nets`. */
export function rippedCopper(copper: readonly RoutedCopper[], points: readonly Point[], radius: number, nets: ReadonlySet<string>): string[] {
  const free = copper.filter(item => !detail(item).locked);
  const parent = free.map((_, k) => k);
  const find = (k: number): number => {
    let at = k;
    while (parent[at] !== at) at = parent[at]!;
    return at;
  };
  const seen = new Map<string, number>();
  free.forEach((item, k) => endsOf(item).forEach(end => {
    const key = `${detail(item).net}\0${end.x},${end.y}`;
    const other = seen.get(key);
    if (other === undefined) seen.set(key, k);
    else parent[find(k)] = find(other);
  }));
  const near = (end: Pt) => points.some(([x, y]) => hypot(toMm(end.x) - x, toMm(end.y) - y) <= radius);
  const hit = new Set(free.flatMap((item, k) => (nets.has(detail(item).net) || endsOf(item).some(near) ? [find(k)] : [])));
  return free.filter((_, k) => hit.has(find(k))).map(item => detail(item).id);
}

/** Deletes those clusters from the board, saved in place with fresh fills; gives the number of items removed. */
export function ripRegion(pcb: string, points: readonly Point[], radius: number, nets: ReadonlySet<string>, read: (pcb: string) => BoardDocument = boardJson, save = saveBoardInPlace): number {
  const gone = rippedCopper(read(pcb).board.copper, points, radius, nets);
  if (gone.length > 0) {
    const edit = new BoardEdit(readFileSync(pcb, 'utf8'));
    gone.forEach(id => edit.remove(id));
    save(pcb, edit.text());
  }
  return gone.length;
}

const QUOTED = /"(?:[^"\\]|\\.)*"/y;

/** A footprint form without its own (locked yes). What it holds keeps its lock: a locked pad is another flag. */
export function unlockedFootprint(form: string): string {
  for (let at = 1; at < form.length - 1;) {
    if (form[at] === '"') {
      QUOTED.lastIndex = at;
      QUOTED.exec(form);
      at = QUOTED.lastIndex;
    } else if (form[at] === '(') {
      const end = formEnd(form, at);
      if (/^\(locked\s+yes\s*\)$/.test(form.slice(at, end))) return form.slice(0, at).trimEnd() + form.slice(end);
      at = end;
    } else {
      at += 1;
    }
  }
  return form;
}

export interface PrepareEffects {
  /** `iotroute lock-input`: writes `out` and gives its JSON record. */
  lockInput(board: string, src: string, out: string): Dict;
  read(pcb: string): BoardDocument;
  save(pcb: string, text: string): unknown;
  sidecars(src: string, out: string): void;
}

const lockInput = (board: string, src: string, out: string): Dict =>
  JSON.parse(execFileSync(iotrouteBin(), ['lock-input', board, src, out, '--tools', join(REPO, 'tools')], { encoding: 'utf8' })) as Dict;

/** The placement board (see the head of this file), sidecars copied. */
export function prepare(src: string, out: string, board: string, keep: 'lock-nets' | 'locked' = 'lock-nets', effects: Partial<PrepareEffects> = {}): Dict {
  if (keep !== 'lock-nets' && keep !== 'locked') throw new Error('keep must be lock-nets or locked');
  const { lockInput: lock = lockInput, read = boardJson, save = saveBoardInPlace, sidecars = copySidecars } = effects;
  mkdirSync(dirname(resolve(out)), { recursive: true });
  const info = lock(board, src, out);
  const nets = new Set(info.nets as string[]);
  const text = readFileSync(out, 'utf8');
  const edit = new BoardEdit(text);
  let changed = false;
  if (keep === 'locked') {
    const source = new BoardEdit(readFileSync(src, 'utf8'));
    const held = read(src).board.copper.filter(item => detail(item).locked && !nets.has(detail(item).net));
    held.forEach(item => edit.add(`\t${source.textOf(detail(item).id)}\n`));
    info.kept_locked = held.length;
    changed = held.length > 0;
  }
  for (const [uuid, form] of formsByUuid(text)) {
    if (form.kind !== 'footprint') continue;
    const before = text.slice(form.start, form.end);
    const after = unlockedFootprint(before);
    if (after !== before) {
      edit.replace(uuid, after);
      changed = true;
    }
  }
  sidecars(src, out);   // the save reads the project next to the board
  if (changed) save(out, edit.text());
  return info;
}

// ---------- the loop ----------

type Summary = Dict;
export type RouteFn = (path: string, d: string, board: string, gate: Gate, iters: number, extra?: readonly string[]) => Promise<[Summary, string]> | [Summary, string];
export type ReadFn = (place: string, out: string, readArgs: readonly string[]) => Problem;
export type WriteFn = (src: string, problem: Problem, pose: Pose, out: string, sidecarSrc: string) => unknown;
export type RipFn = (pcb: string, points: Point[], radius: number, nets: Set<string>) => number;

/** One round's question. `base` starts the names of the evidence files; the problems are the files the reads wrote. */
export interface ProposeInput {
  base: string; problem: string; loose: string | null; fails: Failure[]; tie: number; rotate: boolean; escape: boolean;
  /** The route's congestion map: rank 'hot'. */
  congestion: string | null;
}
export type ProposeFn = (input: ProposeInput) => Round;

export interface RunOptions {
  mode?: 'reuse' | 'local' | 'full'; maxRoutes?: number; perRound?: number; iters?: number; seed?: number; rotate?: boolean;
  readArgs?: readonly string[]; gate?: Gate; log?: (line: string) => void; startSummary?: Summary | null;
  decaps?: boolean; escapeMoves?: boolean; rankMode?: 'term' | 'hot';
  routeFn?: RouteFn; readFn?: ReadFn; writeFn?: WriteFn; ripFn?: RipFn; proposeFn?: ProposeFn;
}

export interface Candidate { place: string; routed: string; key: Key; moves: Proposal[] }
export interface Attempt { round: number; index: number; move: Proposal; ripped: number; key: Key; routed: string; place: string; accepted: boolean }
export interface RepairRecord {
  schema: string; board: string; mode: string; seed: number; rotate: boolean; rank: string; legal_step: number; legal_radius: number;
  start: Candidate; attempts: Attempt[]; rounds: Dict[]; qualified: false; input_faults?: Failure[];
  stop?: string; best?: Candidate; passed?: boolean;
}

async function route(path: string, d: string, board: string, gate: Gate, iters: number, extra: readonly string[] = []): Promise<[Summary, string]> {
  mkdirSync(d, { recursive: true });
  await routeStep(path, d, board, gate, iters, extra);
  return [readTyped<Summary>(join(d, 'route-0/score.json')), join(d, 'route-0', basename(path))];
}

function readFromBoard(place: string, out: string, readArgs: readonly string[]): Problem {
  readProblem(place, out, readArgs);
  return readJson<Problem>(out);
}

function writePose(src: string, problem: Problem, pose: Pose, out: string, sidecarSrc: string): void {
  mkdirSync(dirname(out), { recursive: true });
  writeBoard(src, problem as ReviewedProblem, pose, out);
  copySidecars(sidecarSrc, out);
}

function proposeMoves(input: ProposeInput): Round {
  const [failures, out] = [`${input.base}-failures.json`, `${input.base}-proposals.json`];
  writeFileSync(failures, JSON.stringify(input.fails));
  const flags = [
    ...(input.loose === null ? [] : ['--loose', input.loose]), '--tie', String(input.tie),
    ...(input.rotate ? [] : ['--no-rotate']), ...(input.escape ? [] : ['--no-escape']),
    ...(input.congestion === null ? [] : ['--rank', 'hot', '--congestion', input.congestion]),
  ];
  execFileSync(iotplaceBin(), ['repair-proposals', input.problem, '--failures', failures, '-o', out, ...flags], { stdio: 'pipe' });
  return readJson<Round>(out);
}

/** json.dump writes an infinite key entry as Infinity. */
function withInfinity(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? value : new Float(value);
  if (Array.isArray(value)) return value.map(withInfinity);
  return isDict(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withInfinity(item)])) : value;
}

const keyText = (key: Key): string => `[${key.join(', ')}]`;
const initialPose = (pr: Problem): Pose => pr.units.map(u => [u.x, u.y, 0]);

function moveText(c: Proposal): string {
  const tag = c.problem === 'loose' ? ' (decap slide)' : c.kind === 'escape' ? ' (escape)' : '';
  return `${c.name}${tag} -> (${c.x.toFixed(2)}, ${c.y.toFixed(2)}, ${c.r})`;
}

/** The start's score: its score.json, else the run record, with the gate when the DRC part is 0. */
async function startScore(routed: string, outdir: string, gate: Gate): Promise<Summary> {
  const saved = join(dirname(routed), 'score.json');
  if (isFile(saved)) return readTyped<Summary>(saved);
  const summary: Summary = { run: readTyped(`${routed}.iotroute/result.json`), gate_metrics: null };
  if (scoreKey(summary)[0] === 0) summary.gate_metrics = await gate.run(routed, join(outdir, 'start-gate'), join(outdir, 'start-gate.log'));
  return summary;
}

/** The repair loop. Effects are injectable for tests and for the compaction driver. Gives the record of DIR/repair.json. */
export async function run(board: string, place: string, routed: string, outdirPath: string, options: RunOptions = {}): Promise<RepairRecord> {
  const { mode = 'reuse', maxRoutes = 8, perRound = 4, iters = 80, seed = 1, rotate = true, readArgs = [], log = console.log, decaps = true, escapeMoves = true, rankMode = 'term' } = options;
  const { routeFn = route, readFn = readFromBoard, writeFn = writePose, ripFn = ripRegion, proposeFn = proposeMoves } = options;
  const outdir = resolve(outdirPath);   // the gate runs in its snapshot folder: evidence paths must be absolute
  mkdirSync(outdir, { recursive: true });
  if (rankMode === 'hot') process.env.IOTROUTE_CONGESTION = '1';   // the next rounds rank on the map of the repair's own routes
  const gate = options.gate ?? new GateWorkspace(outdir, board, snapshot);
  const start = resolve(routed);
  let state: Candidate = { place: resolve(place), routed: start, key: [], moves: [] };
  state.key = scoreKey(options.startSummary ?? await startScore(start, outdir, gate));
  const notes = `${start}.iotroute/route.json`;
  const walled = walledPads(isFile(notes) ? readPyJson<Dict>(notes).notes as string[] | undefined : null);
  const rec: RepairRecord = {
    schema: 'iot-lab.placer-repair.v1', board, mode, seed, rotate, rank: rankMode, legal_step: LEGAL_STEP, legal_radius: LEGAL_RADIUS,
    start: { ...state }, attempts: [], rounds: [], qualified: false,
  };
  const save = (stop: string): RepairRecord => {
    Object.assign(rec, { stop, best: { ...state }, passed: passed(state.key) });
    writeFileSync(join(outdir, 'repair.json'), jsonDumps(withInfinity(rec), 1));
    return rec;
  };
  let routes = 0;
  log(`REPAIR start key ${keyText(state.key)}`);
  for (let rnd = 0; ; rnd += 1) {
    if (passed(state.key)) return save('score 0: DRC 0/0/0 and gate at target');
    const located = parseFailures(readPyJson<Dict>(`${state.routed}.iotroute/drc.json`));
    if (located.length === 0) return save(`no located failure (DRC part 0, gate part ${state.key[1]}): the gate findings have no location`);
    if (routes >= maxRoutes) return save(`route cap ${maxRoutes} reached`);
    const problemFile = join(outdir, `round-${rnd}-prob.json`);
    const pr = readFn(state.place, problemFile, readArgs);
    const [fails, inputFaults] = splitWalled(located, walled, pr);
    if (inputFaults.length > 0) rec.input_faults ??= inputFaults;
    if (fails.length === 0) {
      const named = inputFaults.map(f => `${f.type} ${f.items.filter(it => it.ref).map(it => `${it.ref}.${it.pad}`).join(',')}`);
      return save(`the remaining failures are walled in by fixed input copper (router note on the full start route; the pad unit is fixed): ${named.join('; ')}`);
    }
    const tie = readTie(readArgs);
    const problems: Record<Proposal['problem'], Problem | undefined> = { main: pr, loose: undefined };
    let loose: string | null = null;
    if (decaps && (pr.decaps as unknown[] | undefined)?.length && tie > 0) {
      loose = join(outdir, `round-${rnd}-loose.json`);
      problems.loose = readFn(state.place, loose, [...readArgs, '--decap-tie', '0']);
    }
    const congestion = rankMode === 'hot' ? `${state.routed}.iotroute/congestion.json` : null;
    const round = proposeFn({ base: join(outdir, `round-${rnd}`), problem: problemFile, loose, fails, tie, rotate, escape: escapeMoves, congestion });
    const props = round.proposals;
    rec.rounds.push({
      round: rnd, failures: fails, candidates: round.candidates, proposals: props.length,
      escape: round.escape.slice(0, perRound).map(({ name, x, y, r, term, term0 }) => ({ name, x, y, r, term, term0 })),
    });
    log(`REPAIR round ${rnd} failures ${fails.length} candidates ${round.candidates.join(',')} proposals ${props.length}`);
    if (props.length === 0) return save(`round ${rnd}: no legal move of a candidate unit decreases the failure term`);
    let accepted: Attempt | null = null;
    for (const [index, move] of props.slice(0, perRound).entries()) {
      if (routes >= maxRoutes) break;
      const d = join(outdir, `r${rnd}-p${index}`);
      const q = problems[move.problem] as Problem;
      const trial = initialPose(q);
      trial[move.unit] = [move.x, move.y, move.r];
      const newPlace = join(d, 'place', basename(place));
      await writeFn(state.place, q, trial, newPlace, state.place);
      let routeIn = newPlace, ripped = 0;
      if (mode === 'local') {
        routeIn = join(d, 'in', basename(place));
        await writeFn(state.routed, q, trial, routeIn, state.place);
        ripped = ripFn(routeIn, failurePoints(fails), LEGAL_RADIUS, new Set(failureNets(fails)));
        copySidecars(state.place, routeIn);
      }
      // reuse: a partial re-route from the present candidate's route, with no full-route fallback: a proposal that the reuse route
      // does not repair is rejected like any other
      const extra = mode === 'reuse' ? ['--reuse', state.routed, '--reuse-fallback', 'none'] : [];
      const [summary, out] = await routeFn(routeIn, d, board, gate, iters, extra);
      routes += 1;
      const key = scoreKey(summary);
      const attempt: Attempt = { round: rnd, index, move, ripped, key, routed: out, place: newPlace, accepted: better(key, state.key) };
      rec.attempts.push(attempt);
      log(`REPAIR r${rnd} p${index} ${moveText(move)} key ${keyText(key)} ${attempt.accepted ? 'ACCEPT' : 'reject'}`);
      if (attempt.accepted) {
        accepted = attempt;
        break;
      }
    }
    if (accepted === null) {
      const tried = rec.attempts.filter(a => a.round === rnd).length;
      return save(`round ${rnd}: no routed proposal is strictly better than key ${keyText(state.key)} (${tried} routed)`);
    }
    state = { place: accepted.place, routed: accepted.routed, key: accepted.key, moves: [...state.moves, accepted.move] };
  }
}

// ---------- the command ----------

const USAGE = `usage: repair.ts prepare SRC OUT --board BOARD [--keep lock-nets|locked]
       repair.ts run BOARD PLACE ROUTED --outdir DIR [--mode reuse|local|full] [--max-routes N] [--per-round N] [--iters N] [--seed N]
             [--no-rotate] [--no-decap-slide] [--rank term|hot] [--read ARG ...]`;

/** The value of a flag with choices; the first choice is the default. */
function oneOf<const T extends string>(value: string | undefined, choices: readonly [T, ...T[]]): T {
  if (value === undefined) return choices[0];
  if (!(choices as readonly string[]).includes(value)) throw new UsageError(USAGE);
  return value as T;
}

function wholeNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^-?\d+$/.test(value)) throw new UsageError(USAGE);
  return Number(value);
}

/** --read takes the words up to the next flag, or the value of --read=X; the last --read counts. */
export function splitRead(argv: readonly string[]): { rest: string[]; read: string[] } {
  const rest: string[] = [];
  let read: string[] = [];
  for (let k = 0; k < argv.length; k += 1) {
    const arg = argv[k]!;
    if (arg === '--read') {
      read = [];
      while (k + 1 < argv.length && !argv[k + 1]!.startsWith('-')) read.push(argv[++k]!);
    } else if (arg.startsWith('--read=')) {
      read = [arg.slice('--read='.length)];
    } else {
      rest.push(arg);
    }
  }
  return { rest, read };
}

function prepareCommand(argv: string[]): number {
  const { values, positionals } = parseFlags(argv, { board: { type: 'string' }, keep: { type: 'string' } }, USAGE);
  const [src, out] = positionals;
  if (!src || !out || positionals.length !== 2 || !values.board) throw new UsageError(USAGE);
  console.log(jsonDumps({ ...prepare(src, out, values.board, oneOf(values.keep, ['lock-nets', 'locked'])), nets: null }));
  return 0;
}

async function runCommand(argv: string[]): Promise<number> {
  const { rest, read } = splitRead(argv);
  const text = { type: 'string' } as const, flag = { type: 'boolean' } as const;
  const { values, positionals } = parseFlags(rest, {
    outdir: text, mode: text, 'max-routes': text, 'per-round': text, iters: text, seed: text, rank: text, 'no-rotate': flag, 'no-decap-slide': flag,
  }, USAGE);
  const [board, place, routed] = positionals;
  if (!board || !place || !routed || positionals.length !== 3 || !values.outdir) throw new UsageError(USAGE);
  if (isDirectory(values.outdir) && readdirSync(values.outdir).length > 0) throw new UsageError('outdir must be new or empty', 1);
  const rec = await run(board, place, routed, values.outdir, {
    mode: oneOf(values.mode, ['reuse', 'local', 'full']), maxRoutes: wholeNumber(values['max-routes'], 8), perRound: wholeNumber(values['per-round'], 4),
    iters: wholeNumber(values.iters, 80), seed: wholeNumber(values.seed, 1), rotate: !values['no-rotate'], readArgs: read,
    decaps: !values['no-decap-slide'], rankMode: oneOf(values.rank, ['term', 'hot']),
  });
  console.log(`REPAIR ${rec.passed ? 'PASS' : 'FAIL'} key ${keyText((rec.best as Candidate).key)} moves ${(rec.best as Candidate).moves.length} stop: ${rec.stop}`);
  return rec.passed ? 0 : 1;
}

function main(argv: string[]): number | Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'prepare') return prepareCommand(rest);
  if (command === 'run') return runCommand(rest);
  throw new UsageError(USAGE);
}

runMain(import.meta.url, main);
