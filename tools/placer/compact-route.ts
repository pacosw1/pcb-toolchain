// What a compaction step that did not route hands to the schedule. All of it is evidence for the next step, never a gate.
import { fixed, number, pyStr } from '../lib/py-compat.mjs';
import type { Dict } from '../lib/py-values.ts';
import { RouteOutcome } from './compact.ts';

/** A router job without a result never passes. */
export const NO_RESULT = 10 ** 6;

/** The next action of a stopped step; never infers eligibility for an unconfigured repair. */
export function routeHandoff(counts: number[], given: Dict): RouteOutcome {
  const decision: Dict = {
    ...given, retained_candidate: null, qualified: false, full_configured_gates_required: true,
    repair_eligibility: 'Configured isolated workspace and source-bound native parity evidence required before apply_plan; this observation is not repair approval.',
  };
  const result = new RouteOutcome(counts, decision);
  if (result.stop) {
    result.decision.next_action = {
      kind: decision.action ?? 'inspect_evidence', evidence: decision.evidence ?? null, candidate: null,
      instruction: 'Inspect this diagnosis; use the configured repair workflow after its source/parity prerequisites pass.',
      qualified: false, full_configured_gates_required: true,
    };
  }
  return result;
}

/** Summary line of the chosen step: board, step, halo, measured length and vias, and why it was chosen. */
export function bestLine(run: { best: Dict; best_step: unknown; best_reason: unknown }): string {
  const best = run.best, measure = (best.measure ?? {}) as Dict;
  const shown = (value: unknown) => (value === null || value === undefined ? 'n/a' : pyStr(value));
  const fixed3 = (value: unknown) => fixed(number(value as number), 3);
  return `BEST board ${String(best.board)} step ${String(run.best_step)} s ${fixed3(best.s)} k ${fixed3(best.k)} unrouted ${String(best.unrouted)} length ${shown(measure.length_mm)} mm vias ${shown(measure.vias)} box ${shown(best.box_sum)} mm2 routed ${shown(measure.routed)}: ${String(run.best_reason)}`;
}
