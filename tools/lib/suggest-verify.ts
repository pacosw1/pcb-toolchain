// pcbtool suggest --verify: each proposed connect line is applied on a copy of the project and judged by DRC against an unchanged copy.
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { DrcFile } from './board-edit.ts';
import { drcRefill, inProjectCopy } from './drc-run.ts';
import { TS_NODE } from './env.mjs';
import { CommandFailure } from './pcbtool-cli.ts';

const NET = /\[([^\]]+)\]/;
const MAX_PARALLEL = 8;
const LINE_CHARS = 120;
const PCBTOOL = fileURLToPath(new URL('../pcbtool.ts', import.meta.url));

export interface Verdict { ok: boolean; reason: string }

const bump = (counts: Map<string, number>, name: string): void => { counts.set(name, (counts.get(name) ?? 0) + 1); };

/** Open connections per net and errors per type. An unconnected item counts once for each net it names. */
function drcCounts(drc: DrcFile): { open: Map<string, number>; errors: Map<string, number> } {
  const open = new Map<string, number>();
  const errors = new Map<string, number>();
  for (const { items } of drc.unconnected_items ?? []) {
    for (const net of new Set(items.flatMap(item => item.description.match(NET)?.[1] ?? []))) bump(open, net);
  }
  for (const violation of drc.violations ?? []) if (violation.severity === 'error') bump(errors, String(violation.type));
  return { open, errors };
}

/** A candidate passes with no new error of a type, fewer unconnected items on the net, and no more on any other. */
export function verifyVerdict(base: DrcFile, candidate: DrcFile, net: string): Verdict {
  const before = drcCounts(base);
  const after = drcCounts(candidate);
  const count = (counts: Map<string, number>, name: string): number => counts.get(name) ?? 0;
  for (const type of [...after.errors.keys()].sort()) {
    const added = count(after.errors, type) - count(before.errors, type);
    if (added > 0) return { ok: false, reason: `+${added} ${type}` };
  }
  if (count(after.open, net) >= count(before.open, net)) return { ok: false, reason: `${net} unconnected ${count(before.open, net)} -> ${count(after.open, net)}` };
  for (const other of [...after.open.keys()].sort()) {
    if (other !== net && count(after.open, other) > count(before.open, other)) return { ok: false, reason: `${other} unconnected ${count(before.open, other)} -> ${count(after.open, other)}` };
  }
  return { ok: true, reason: '' };
}

const run = promisify(execFile);

/** Applies one connect line to a board with this tool; a refused line is an error with its last line of output. */
export async function connectLine(board: string, line: string, planes: string): Promise<void> {
  try {
    await run(process.execPath, [...TS_NODE, PCBTOOL, 'connect', board, line, '--planes', resolve(planes)]);
  } catch (error) {
    const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string };
    const text = `${stdout}${stderr}`.trim().split(/\r?\n/).at(-1) || 'failed';
    throw new Error(`connect: ${Array.from(text).slice(0, LINE_CHARS).join('')}`);
  }
}

export interface VerifySteps {
  drc: (board: string) => DrcFile | Promise<DrcFile>;
  apply: (board: string, line: string) => void | Promise<void>;
}

type Outcome = { drc: DrcFile } | { failure: string };

async function inTurn<T, R>(items: T[], limit: number, each: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const at = next;
      next += 1;
      results[at] = await each(items[at]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * The verdict per connect line, up to 8 at once, on temporary copies. The board is not changed. Fail closed: a failed baseline DRC
 * stops the tool; a failed apply or candidate DRC rejects that candidate.
 */
export async function verifyCandidates(pcb: string, net: string, lines: string[], steps: VerifySteps): Promise<Verdict[]> {
  const outcome = (line: string | null): Promise<Outcome> => inProjectCopy(pcb, async (board): Promise<Outcome> => {
    try {
      if (line !== null) await steps.apply(board, line);
      return { drc: await steps.drc(board) };
    } catch (error) {
      return { failure: (error as Error).message || (error as Error).name };
    }
  });
  const [base, ...candidates] = await inTurn([null, ...lines], MAX_PARALLEL, outcome);
  if ('failure' in base!) throw new CommandFailure(`baseline DRC failed: ${base.failure}; no candidate is verified`);
  return candidates.map(candidate => ('drc' in candidate ? verifyVerdict(base!.drc, candidate.drc, net) : { ok: false, reason: candidate.failure }));
}

export const realSteps = (planes: string): VerifySteps => ({ drc: drcRefill, apply: (board, line) => connectLine(board, line, planes) });
