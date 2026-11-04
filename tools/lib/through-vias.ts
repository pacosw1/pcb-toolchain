// The document holds no via type or layer span (pcbnew's PCB_VIA TopLayer, BottomLayer, GetViaType, IsOnLayer), so a check of
// connectivity takes every via as through. On a blind, buried or micro via that would join layers that are not joined and pass
// copper that is not there, so such a check stops instead. No board has one today (93 scanned, 2026-11-04).
import { readFileSync } from 'node:fs';
import { CommandFailure } from './pcbtool-cli.ts';

const SPAN_VIA = /\(via\s+(blind|buried|micro)\b|\(via\b[^()]*\(type\s+(blind|buried|micro)\b/;

export function spanViaKind(boardText: string): string | null {
  const match = boardText.match(SPAN_VIA);
  return match ? (match[1] ?? match[2])! : null;
}

export function requireThroughVias(pcb: string): void {
  const kind = spanViaKind(readFileSync(pcb, 'utf8'));
  if (kind) throw new CommandFailure(`${pcb}: has a ${kind} via; board JSON holds no via layer span, so copper paths cannot be measured`);
}
