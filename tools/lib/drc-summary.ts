// The compact DRC summary pcbtool prints after a change, from kicad-cli's JSON report.
import type { DrcFile } from './board-edit.ts';
import { pyRepr } from './py-compat.mjs';

const NET = /\[([^\]]+)\]/;
const MAX_ERRORS = 25;
const LINE_CHARS = 200;

export interface DrcSummary {
  errors: number;
  warnings: number;
  /** Type to count, in the order the report names them. */
  warningTypes: Map<string, number>;
  unconnected: number;
  parity: number;
  errorLines: string[];
  /** Net to open connections. */
  unrouted: Map<string, number>;
}

const counted = (names: string[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
};

export function summarizeDrc(drc: DrcFile): DrcSummary {
  const violations = drc.violations ?? [];
  const errors = violations.filter(item => item.severity === 'error');
  const open = drc.unconnected_items ?? [];
  return {
    errors: errors.length,
    warnings: violations.length - errors.length,
    warningTypes: counted(violations.filter(item => item.severity !== 'error').map(item => String(item.type))),
    unconnected: open.length,
    parity: drc.schematic_parity?.length ?? 0,
    errorLines: errors.map(item => `${item.type}: ${(item.items ?? []).map(one => one.description).join(' | ')}`),
    unrouted: counted(open.map(item => item.items[0]?.description.match(NET)?.[1] ?? '?')),
  };
}

const cut = (line: string): string => Array.from(line).slice(0, LINE_CHARS).join('');

/** The lines of the summary. */
export function drcLines(summary: DrcSummary, limit = MAX_ERRORS): string[] {
  const lines = [`DRC: ${summary.errors} errors, ${summary.warnings} warnings ${pyRepr(summary.warningTypes)}, `
    + `${summary.unconnected} unconnected, ${summary.parity} parity`];
  lines.push(...summary.errorLines.slice(0, limit).map(line => `  E ${cut(line)}`));
  if (summary.unrouted.size) {
    const worst = [...summary.unrouted].sort((a, b) => b[1] - a[1]);
    lines.push(`  unrouted: ${worst.map(([net, count]) => `${net} ${count}`).join(', ')}`);
  }
  return lines;
}
