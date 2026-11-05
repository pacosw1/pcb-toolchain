// What a compaction step hands to the schedule when it did not pass: a stop, a step whose opens are only plane nets, or plain counts
// for the halo schedule. All of it is evidence for the next step, never a gate.
import { readFileSync } from 'node:fs';
import { sha256File } from '../lib/json-file.ts';
import { fixed, number, pyStr } from '../lib/py-compat.mjs';
import { joinPath } from '../lib/py-path.ts';
import type { Dict } from '../lib/py-values.ts';
import { Measured, RouteOutcome, type OutcomeOptions, type RouteResult } from './compact.ts';

/** A router job without a result never passes. */
export const NO_RESULT = 10 ** 6;

const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

/** The next action of a stopped step; never infers eligibility for an unconfigured repair. */
export function routeHandoff(counts: number[], given: Dict, options: OutcomeOptions = {}): RouteOutcome {
  const decision: Dict = {
    ...given, retained_candidate: null, qualified: false, full_configured_gates_required: true,
    repair_eligibility: 'Configured isolated workspace and source-bound native parity evidence required before apply_plan; this observation is not repair approval.',
  };
  const result = new RouteOutcome(counts, decision, options);
  if (result.stop) {
    result.decision.next_action = {
      kind: decision.action ?? 'inspect_evidence', evidence: decision.evidence ?? null, candidate: null,
      instruction: 'Inspect this diagnosis; use the configured repair workflow after its source/parity prerequisites pass.',
      qualified: false, full_configured_gates_required: true,
    };
  }
  return result;
}

/** The net of an unconnected DRC item, when each endpoint names exactly the same one. */
function itemNet(row: Dict): string | null {
  const items = row.items;
  if (!Array.isArray(items) || items.length < 2) return null;
  const nets = (items as Dict[]).map(item => {
    const text = item.description ?? '';
    if (typeof text !== 'string' || text.split('[').length !== 2 || text.split(']').length !== 2) return null;
    const name = /\[([^[\]]+)\]/.exec(text)?.[1];
    return name && name === name.trim() ? name : null;
  });
  const [net] = nets;
  return net && nets.every(name => name === net) ? net : null;
}

interface RunDrc { violations: Dict[]; unconnected_items: Dict[]; schematic_parity: unknown[] }

function cleanButOpen(run: Dict, drc: RunDrc): boolean {
  const lists = [drc.violations, drc.unconnected_items, drc.schematic_parity].every(Array.isArray);
  return lists && run.status === 'FAIL' && run.drc_errors === 0 && run.parity === 0 && !drc.schematic_parity.length && !drc.violations.some(row => row.severity === 'error')
    && drc.unconnected_items.length > 0 && run.unconnected === drc.unconnected_items.length;
}

function evidenceIsCurrent(decision: Dict, work: string): boolean {
  const kinds = new Set(((decision.findings ?? []) as Dict[]).map(row => row.classification));
  const known = decision.status === 'diagnosed' && decision.action === 'diagnose_selected_connections' && kinds.size === 1 && kinds.has('native_open');
  const artifacts = (decision.artifacts ?? {}) as Record<string, string>;
  return known && ['result.json', 'drc.json'].every(name => name in artifacts && sha256File(joinPath(work, name)) === artifacts[name]);
}

/** Accounting of a step whose only opens are nets the model keeps out of routing, for the routing step alone, never a full gate.
 *  Null unless every open is such a net. `work` is the step's OUT.iotroute. */
export function skippedOpenScope(decision: Dict, work: string): Dict | null {
  try {
    if (!evidenceIsCurrent(decision, work)) return null;
    const run = read<Dict>(joinPath(work, 'result.json')), drc = read<RunDrc>(joinPath(work, 'drc.json'));
    const modelFile = joinPath(work, 'model.json'), model = read<{ nets: Record<string, Dict> }>(modelFile);
    if (((run.stages as Dict).model as Dict).sha256 !== sha256File(modelFile) || !cleanButOpen(run, drc)) return null;
    const nets = new Set<string>();
    for (const row of drc.unconnected_items) {
      const net = itemNet(row);
      if (!net || model.nets[net]?.plane !== true) return null;
      nets.add(net);
    }
    return {
      scope: 'plane_nets_only', status: 'routing_step_complete', excluded_native_opens: drc.unconnected_items.length, nets: [...nets].sort(),
      qualified: false, native_verified: false, full_configured_gates_required: true,
    };
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  }
}

/** A result the halo schedule cannot change: a run that gave no verdict, among them a refused admission, or a netlist that disagrees. */
export function terminalDecision(decision: Dict): boolean {
  const evidence = 'result.json' in ((decision.artifacts ?? {}) as Dict);
  return decision.action === 'resolve_schematic_parity' || (decision.status === 'unverified' && evidence);
}

/** What a step that did not pass gives the schedule. Anything else stays plain counts: a failed step bisects the halo. */
export function stepOutcome(measured: Measured, decision: Dict, work: string): RouteResult {
  const scope = skippedOpenScope(decision, work);
  if (scope) return routeHandoff([0], { ...decision, routing_step_scope: scope }, { scopedSkippedOpens: true, measure: measured.measure });
  return terminalDecision(decision) ? routeHandoff(measured.counts, decision) : measured;
}

/** Summary line of the chosen step: board, step, halo, measured length and vias, and why it was chosen. */
export function bestLine(run: { best: Dict; best_step: unknown; best_reason: unknown }): string {
  const best = run.best, measure = (best.measure ?? {}) as Dict;
  const shown = (value: unknown) => (value === null || value === undefined ? 'n/a' : pyStr(value));
  const fixed3 = (value: unknown) => fixed(number(value as number), 3);
  return `BEST board ${String(best.board)} step ${String(run.best_step)} s ${fixed3(best.s)} k ${fixed3(best.k)} unrouted ${String(best.unrouted)} length ${shown(measure.length_mm)} mm vias ${shown(measure.vias)} box ${shown(best.box_sum)} mm2 routed ${shown(measure.routed)}: ${String(run.best_reason)}`;
}
