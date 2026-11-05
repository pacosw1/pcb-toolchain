// What a routed compaction step hands to the schedule: the retained candidate, whether its geometry feedback is real, and
// whether its opens are only nets the route was told to skip. All of it is evidence for the next step, never a gate.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fnmatchCase } from '../lib/fnmatch.ts';
import { sha256File } from '../lib/json-file.ts';
import { joinPath } from '../lib/py-path.ts';
import type { Dict } from '../lib/py-values.ts';
import { RouteOutcome } from './compact.ts';

/** A router job without an UNROUTED line (transport error, timeout) never passes. */
export const NO_RESULT = 10 ** 6;

export function parseUnrouted(text: string): number {
  const counts = [...text.matchAll(/^UNROUTED (\d+)/gm)].map(match => Number(match[1]));
  return counts.at(-1) ?? NO_RESULT;
}

/** The last UNROUTED line of a fastroute job as named counts. */
export function reportedCounts(text: string): Counts | null {
  const last = [...text.matchAll(/^UNROUTED (\d+) GND_OPEN (\d+) ERRORS (\d+)/gm)].at(-1);
  return last ? { signal_open: Number(last[1]), ground_open: Number(last[2]), errors: Number(last[3]) } : null;
}

export interface Counts { signal_open: number; ground_open: number; errors: number }

export const routeCommand = (name: string, gndVias: boolean): string[] => [...(gndVias ? ['env', 'GNDVIAS=1'] : []), 'bash', 'tools/placer/fr_job.sh', name];

const EVIDENCE = ['input-manifest.json', 'outcome.json', 'drc.json'] as const;

interface ScopeConfig { skip_net: string; plane_nets: string; gnd_vias: boolean; route_planes: boolean }
interface DrcEvidence { violations: Dict[]; unconnected_items: Dict[]; schematic_parity: unknown[] }

const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

function configOf(value: Dict): ScopeConfig | null {
  const { skip_net: skip, plane_nets: planes, gnd_vias: vias, route_planes: routed } = value;
  const good = typeof skip === 'string' && typeof planes === 'string' && typeof vias === 'boolean' && typeof routed === 'boolean';
  return good ? value as unknown as ScopeConfig : null;
}

/** The nets the route left out by its own configuration. */
function skippedPatterns(config: ScopeConfig): { planes: string[]; skip: string[] } {
  const planes = config.plane_nets.split(',').filter(Boolean);
  if (config.gnd_vias && !planes.includes('GND')) planes.push('GND');
  const skip = config.skip_net.split(',').filter(Boolean);
  return config.route_planes
    ? { planes, skip: skip.filter(pattern => !planes.some(net => fnmatchCase(net, pattern))) }
    : { planes, skip: [...skip, ...planes] };
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

function cleanSignalReport(counts: number[], outcome: Dict, drc: DrcEvidence, reported: Counts | null | undefined): boolean {
  const numbers = ['signal_open', 'ground_open', 'errors'].every(name => Number.isInteger(outcome[name]));
  const lists = [drc.violations, drc.unconnected_items, drc.schematic_parity].every(Array.isArray);
  return counts.length > 0 && counts.every(count => count === 0) && outcome.status === 'complete' && numbers
    && outcome.signal_open === 0 && outcome.errors === 0 && lists
    && reported?.signal_open === outcome.signal_open && reported?.ground_open === outcome.ground_open && reported?.errors === outcome.errors
    && !drc.schematic_parity.length && !drc.violations.some(row => row.severity === 'error')
    && drc.unconnected_items.length > 0 && outcome.ground_open === drc.unconnected_items.length;
}

function evidenceIsCurrent(decision: Dict, folder: string): boolean {
  const known = decision.status === 'diagnosed' && decision.action === 'diagnose_selected_connections';
  const kinds = new Set(((decision.findings ?? []) as Dict[]).map(row => row.classification));
  if (!known || kinds.size !== 1 || !kinds.has('native_open')) return false;
  const artifacts = decision.artifacts as Record<string, string>;
  return EVIDENCE.every(name => name in artifacts && sha256File(joinPath(folder, 'route-0', name)) === artifacts[name]);
}

/** Source-bound accounting of skipped nets for a routing step, never a full gate. Null unless every open is such a net. */
export function skippedOpenScope(counts: number[], decision: Dict, folder: string, reported: Counts | null | undefined): Dict | null {
  try {
    if (!evidenceIsCurrent(decision, folder)) return null;
    const file = (name: string) => joinPath(folder, 'route-0', name);
    const manifest = read<Dict>(file('input-manifest.json'));
    const outcome = read<Dict>(file('outcome.json')), drc = read<DrcEvidence>(file('drc.json'));
    const config = configOf(manifest.configuration as Dict);
    if (manifest.board_sha256 !== decision.source_board_sha256 || !config || !cleanSignalReport(counts, outcome, drc, reported)) return null;
    const { planes, skip } = skippedPatterns(config);
    const nets = new Set<string>();
    for (const row of drc.unconnected_items) {
      const net = itemNet(row);
      if (!net || !(planes.includes(net) || skip.some(pattern => fnmatchCase(net, pattern)))) return null;
      nets.add(net);
    }
    return {
      scope: 'explicitly_skipped_or_plane_nets_only', status: 'routing_step_complete', excluded_native_opens: drc.unconnected_items.length,
      nets: [...nets].sort(), configuration: { skip_net: config.skip_net, plane_nets: config.plane_nets, gnd_vias: config.gnd_vias, route_planes: config.route_planes },
      qualified: false, native_verified: false, full_configured_gates_required: true,
    };
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  }
}

export interface Feedback { accepted?: unknown; sources?: Record<string, string>; source_board_sha256?: unknown; [key: string]: unknown }
export interface HandoffOptions { feedback?: Feedback | null; priorHints?: Record<string, number>; hints?: Record<string, number>; reportedCounts?: Counts | null }

/** The routed board of a diagnosed step, if its evidence still matches. */
function retainedCandidate(decision: Dict, folder: string): { candidate: Dict | null; decision: Dict } {
  const route = joinPath(folder, 'route-0');
  if (decision.status !== 'diagnosed') return { candidate: null, decision };
  try {
    const artifacts = decision.artifacts as Record<string, string> | undefined;
    if (!artifacts || !Object.keys(artifacts).length || Object.entries(artifacts).some(([name, digest]) => sha256File(joinPath(route, name)) !== digest)) {
      throw new Error('route evidence changed after diagnosis');
    }
    const routed = joinPath(route, 'routed.kicad_pcb');
    const digest = sha256File(routed);
    if (read<Dict>(joinPath(route, 'outcome.json')).board_sha256 !== digest) throw new Error('retained candidate changed after routing diagnosis');
    return { candidate: { path: resolve(routed), sha256: digest, qualified: false, full_configured_gates_required: true, preserve_for_next_step: true }, decision };
  } catch (error) {
    return { candidate: null, decision: { ...decision, status: 'unverified', action: 'inspect_evidence', reason: (error as Error).message } };
  }
}

function feedbackIsReal(feedback: Feedback | null | undefined, decision: Dict, changed: string[]): boolean {
  if (!feedback || feedback.accepted !== true || !feedback.sources || !Object.keys(feedback.sources).length) return false;
  if (feedback.source_board_sha256 !== decision.source_board_sha256 || !changed.length) return false;
  try {
    return Object.entries(feedback.sources).every(([path, digest]) => sha256File(path) === digest);
  } catch {
    return false;
  }
}

/** Keeps routed copper; never infers eligibility for an unconfigured repair. */
export function routeHandoff(counts: number[], given: Dict, folder: string, options: HandoffOptions = {}): RouteOutcome {
  const { feedback = null, priorHints = {}, hints = {}, reportedCounts: reported = null } = options;
  const { candidate, decision: checked } = retainedCandidate(given, folder);
  const changed = Object.keys(hints).filter(ref => (hints[ref] as number) > (priorHints[ref] ?? 0)).sort();
  const geometry = feedbackIsReal(feedback, checked, changed);
  const decision: Dict = {
    ...checked, geometry_feedback: { accepted: geometry, changed_refs: changed, evidence: feedback ? resolve(joinPath(folder, 'feedback.json')) : null },
    retained_candidate: candidate, qualified: false, full_configured_gates_required: true,
    repair_eligibility: 'Configured isolated workspace and source-bound native parity evidence required before apply_plan; this observation is not repair approval.',
  };
  const scope = candidate ? skippedOpenScope(counts, decision, folder, reported) : null;
  if (scope) decision.routing_step_scope = scope;
  const result = new RouteOutcome(counts, decision, { candidate, geometryFeedback: geometry, scopedSkippedOpens: Boolean(scope) });
  (result.decision.geometry_feedback as Dict).continue_search = !result.stop && !result.routingStepClean;
  if (result.stop) {
    result.decision.next_action = {
      kind: decision.action ?? 'inspect_evidence', evidence: decision.evidence ?? null, candidate,
      instruction: 'Inspect this retained candidate and diagnosis; use the configured repair workflow after its source/parity prerequisites pass.',
      qualified: false, full_configured_gates_required: true,
    };
  }
  return result;
}

/** Summary line of the chosen step: board, step, halo, measured length and vias, and why it was chosen. */
export function bestLine(run: { best: Dict; best_step: unknown; best_reason: unknown }): string {
  const best = run.best, measure = (best.measure ?? {}) as Dict;
  const shown = (value: unknown) => String(value ?? 'n/a');
  const fixed3 = (value: unknown) => Number(value).toFixed(3);
  return `BEST board ${String(best.board)} step ${String(run.best_step)} s ${fixed3(best.s)} k ${fixed3(best.k)} unrouted ${String(best.unrouted)} length ${shown(measure.length_mm)} mm vias ${shown(measure.vias)} box ${shown(best.box_sum)} mm2 routed ${shown(measure.routed)}: ${String(run.best_reason)}`;
}
