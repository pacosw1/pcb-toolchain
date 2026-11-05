// The corridor and suggest searches take every via as through. On a blind, buried or micro via that would join layers that are not
// joined and pass copper that is not there, so they stop instead. No board has one today (93 scanned, 2026-11-04). The power paths
// read each via's span and need no stop.
import { readFileSync } from 'node:fs';
import { CommandFailure } from './pcbtool-cli.ts';

const SPAN_VIA = /\(via\s+(blind|buried|micro)\b|\(via\b[^()]*\(type\s+(blind|buried|micro)\b/;

export function spanViaKind(boardText: string): string | null {
  const match = boardText.match(SPAN_VIA);
  return match ? (match[1] ?? match[2])! : null;
}

export function requireThroughVias(pcb: string): void {
  const kind = spanViaKind(readFileSync(pcb, 'utf8'));
  if (kind) throw new CommandFailure(`${pcb}: has a ${kind} via, and this search takes every via as through`);
}
