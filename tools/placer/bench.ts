// Proof benchmarks, and the seed portfolio pick.
//
//   tools/placer/bench.ts collect PROB OUT TAG...              proxy cost of OUT/TAG-search/res.json cand0 (TAG base: the
//                                                              problem pose) against the UNROUTED lines of OUT/TAG-r*.log
//   tools/placer/bench.ts pick NAME:RES_JSON:ROUTE_LOG...      the portfolio pick winner, or NONE; the cost is cand0 of
//                                                              RES_JSON, the counts the last UNROUTED line of ROUTE_LOG
//
// A. Proxy correlation: proxy cost vs median Freerouting unrouted over many placements.
// B. Known-good recovery: original vs scrambled vs placer-from-scrambled on boards that route fully.
// The cost and the scramble are iotplace commands.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMain, UsageError } from '../lib/cli.ts';
import { iotplaceBin } from '../lib/iotplace-bin.ts';
import { parseTyped, readPyJson, readTyped } from '../lib/json-file.ts';
import { fixed, Float, globNames, jsonDumps, number, PyError, pyStr, sorted, truthy } from '../lib/py-compat.mjs';
import { joinPath, pathExists, textOf } from '../lib/py-path.ts';
import { deepCopy, minBy, type Pose, type Problem } from './compact.ts';

const USAGE = 'usage: tools/placer/bench.ts collect PROB OUT TAG... | pick NAME:RES_JSON:ROUTE_LOG...';
const ROUTE_COUNTS = /^UNROUTED (\d+) SUBSET \d+ ERRORS (\d+)( CAPPED)?/gm;
const UNROUTED = /^UNROUTED (\d+)/gm;

export type TableRow = [tag: string, cost: number, runs: number[]];
export interface PortfolioRun { name: string; cost: number; unrouted: number | null; errors: number | null }
/** The proxy cost of a pose of the problem file; null is the pose of the problem. */
export type ProxyCost = (prob: string, pose: Pose | null) => number;
/** A problem copy from `iotplace scramble`. */
export type Scramble = (pr: Problem, seed: number) => Problem;

interface SearchFile { candidates: { pose: Pose; cost: number }[] }

function ranks(values: number[]): number[] {
  const order = values.map((_, index) => index).sort((a, b) => values[a] - values[b]);
  const result = values.map(() => 0);
  for (let i = 0, j = 0; i < order.length; i = j + 1) {
    j = i;
    while (j + 1 < order.length && values[order[j + 1]] === values[order[i]]) j += 1;
    for (let k = i; k <= j; k++) result[order[k]] = (i + j) / 2 + 1;
  }
  return result;
}

const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

/** Pearson correlation of the ranks (ties get the average rank). No rows or no variance: ZeroDivisionError. */
export function spearman(xs: number[], ys: number[]): number {
  const [a, b] = [ranks(xs), ranks(ys)];
  const [ma, mb] = [mean(a), mean(b)];
  const covariance = a.reduce((sum, x, index) => sum + (x - ma) * (b[index] - mb), 0);
  const spread = (values: number[], middle: number) => Math.sqrt(values.reduce((sum, value) => sum + (value - middle) ** 2, 0));
  const scale = spread(a, ma) * spread(b, mb);
  if (!scale) throw new PyError('ZeroDivisionError', 'float division by zero');
  return covariance / scale;
}

/** The median as Python's %s prints it: an element, or the mean of the two middle ones as a float. */
function medianOf(sortedRuns: number[]): number {
  const half = Math.floor(sortedRuns.length / 2);
  return sortedRuns.length % 2 ? sortedRuns[half] : (sortedRuns[half - 1] + sortedRuns[half]) / 2;
}

/** Rows -> [markdown table, Spearman of proxy vs median]. A row without router results is shown but not in the correlation. */
export function table(rows: TableRow[]): [string, number] {
  const out = ['| Placement | Proxy cost | Unrouted min / median / max |', '|---|---|---|'];
  const [xs, ys]: [number[], number[]] = [[], []];
  for (const [tag, cost, runs] of rows) {
    if (!runs.length) {
      out.push(`| ${tag} | ${fixed(cost, 1)} | no result |`);
      continue;
    }
    const v = [...runs].sort((a, b) => a - b);
    const median = medianOf(v);
    out.push(`| ${tag} | ${fixed(cost, 1)} | ${v[0]} / ${v.length % 2 ? median : pyStr(new Float(median))} / ${v.at(-1)} |`);
    xs.push(cost);
    ys.push(median);
  }
  const rho = spearman(xs, ys);
  out.push('', `Spearman (proxy cost vs median unrouted, n = ${xs.length}): ${fixed(rho, 2)}`);
  return [out.join('\n'), rho];
}

/** Seed portfolio: the run with the fewest DRC errors (a hard fault), then the fewest unrouted, then the lower cost; null
 *  when no run has a route result. */
export function portfolioPick(runs: PortfolioRun[]): PortfolioRun | null {
  const ok = runs.filter(run => run.unrouted !== null);
  return ok.length ? minBy(ok, run => [run.errors as number, run.unrouted as number, run.cost]) : null;
}

function portfolioRun(entry: string): PortfolioRun {
  const parts = entry.split(':');
  if (parts.length !== 3) throw new PyError('ValueError', `not NAME:RES_JSON:ROUTE_LOG: ${entry}`);
  const [name, res, log] = parts;
  const last = pathExists(log) ? [...textOf(log).matchAll(ROUTE_COUNTS)].at(-1) : undefined;
  const cost = readPyJson<SearchFile>(res).candidates[0].cost;
  if (!last) return { name, cost, unrouted: null, errors: null };
  return { name, cost, unrouted: last[3] ? Infinity : Number(last[1]), errors: Number(last[2]) };   // a capped count is unknown-high
}

/** The name of the portfolio winner of NAME:RES_JSON:ROUTE_LOG entries. */
export const pick = (entries: string[]): string | null => portfolioPick(entries.map(portfolioRun))?.name ?? null;

/** `iotplace cost`: the cost with default params. */
export function proxyCost(prob: string, pose: Pose | null): number {
  const folder = mkdtempSync(join(tmpdir(), 'bench-pose-'));
  try {
    const file = join(folder, 'pose.json');
    if (pose !== null) writeFileSync(file, jsonDumps(pose));
    const output = execFileSync(iotplaceBin(), ['cost', prob, ...(pose === null ? [] : ['--pose', file])], { encoding: 'utf8' });
    return number(parseTyped<{ cost: unknown }>(output).cost);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

function routerRuns(out: string, tag: string): number[] {
  const logs = (sorted(globNames(out).filter(name => name.startsWith(`${tag}-r`) && name.endsWith('.log'))) as string[]);
  return logs.flatMap(name => {
    const last = [...textOf(joinPath(out, name)).matchAll(UNROUTED)].at(-1);
    return last ? [Number(last[1])] : [];
  });
}

/** The table of the tags of a bench folder. */
export function collect(prob: string, out: string, tags: string[], cost: ProxyCost = proxyCost): string {
  const rows = tags.map((tag): TableRow => {
    const pose = tag === 'base' ? null : readTyped<SearchFile>(joinPath(out, `${tag}-search`, 'res.json')).candidates[0].pose;
    return [tag, cost(prob, pose), routerRuns(out, tag)];
  });
  return table(rows)[0];
}

function iotplaceScramble(pr: Problem, seed: number): Problem {
  const folder = mkdtempSync(join(tmpdir(), 'bench-scatter-'));
  try {
    const [input, output] = [join(folder, 'prob.json'), join(folder, 'out.json')];
    writeFileSync(input, jsonDumps(pr));
    execFileSync(iotplaceBin(), ['scramble', input, '-o', output, '--seed', String(seed)], { stdio: 'pipe' });
    return readTyped<Problem>(output);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** Copy of the problem whose movable units start at seeded uniform places inside the board (a search start for parts
 *  staged outside the outline). Write the result against the original problem. */
export function scatter(pr: Problem, seed: number, scramble: Scramble = iotplaceScramble): Problem {
  const moved = scramble(pr, seed).units;
  const q = deepCopy(pr);
  q.units.forEach((unit, index) => {
    if (truthy(unit.fixed)) return;
    unit.x = moved[index].x;
    unit.y = moved[index].y;
  });
  return q;
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === 'pick') console.log(pick(rest) ?? 'NONE');
  else if (command === 'collect' && rest.length >= 3) console.log(collect(rest[0], rest[1], rest.slice(2)));
  else throw new UsageError(USAGE);
  return 0;
}

runMain(import.meta.url, main);
