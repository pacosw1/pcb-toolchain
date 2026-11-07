// A route.json against the nets of its board. The schema stays in route-plan-schema.ts; this reads only the stage lists that name nets.
// Stage order is not checked. skip_nets are glob patterns (tools/router/core/src/plan/stage.rs), so they are not checked as names.
import { join } from 'node:path';
import { boardJson } from './board-json.ts';
import type { Board } from './board-types.ts';
import { nativeInputs } from './route-decision-evidence.ts';

export interface PlanNets { nets: ReadonlySet<string>; routable: ReadonlySet<string> }
/** Stage lists whose entries are exact net names. */
const NAMED = ['only_nets', 'plane_nets', 'unlock_nets'];
const SHOWN = 12;

/** The nets of a board, and those with two or more pads: a net with one pad has nothing to route. */
export function planNets(board: Board): PlanNets {
  const pads = new Map<string, number>();
  for (const part of board.footprints) for (const pad of part.pads) if (pad.net) pads.set(pad.net, (pads.get(pad.net) ?? 0) + 1);
  return { nets: new Set(Object.keys(board.nets).filter(Boolean)), routable: new Set([...pads].filter(([, count]) => count >= 2).map(([net]) => net)) };
}

/** The nets of the board a route starts from: the workspace of the parent run when it continues one, else the checkout. */
export function boardPlanNets(root: string, board: string, parent?: string): PlanNets {
  return planNets(boardJson(nativeInputs(parent ? join(parent, 'workspace') : root, board).native).board);
}

const names = (value: unknown): string[] => Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : [];

/** Every net problem of a plan: a stage net that is not on the board, and a routable net that no stage routes. Empty when none. */
export function routePlanNetErrors(plan: unknown, board: PlanNets): string[] {
  const stages = (plan as { stages?: unknown } | null)?.stages;
  if (!Array.isArray(stages) || !stages.length) return ['route plan has no list of stages, so net coverage cannot be checked'];
  const errors: string[] = [], named = new Set<string>();
  let catchAll = false;
  stages.forEach((stage: unknown, index) => {
    if (!stage || typeof stage !== 'object') { errors.push(`stages[${index}] must be an object`); return; }
    const raw = stage as Record<string, unknown>;
    for (const field of NAMED) for (const net of names(raw[field])) if (!board.nets.has(net)) errors.push(`stages[${index}].${field}: ${net} is not a net of this board`);
    // The router reads an empty only_nets as no only_nets.
    if (names(raw.only_nets).length) names(raw.only_nets).forEach(net => named.add(net)); else catchAll = true;
  });
  if (!catchAll) {
    const missing = [...board.routable].filter(net => !named.has(net)).sort();
    if (missing.length) errors.push(`no stage routes ${missing.length} net${missing.length === 1 ? '' : 's'} of this board: ${missing.slice(0, SHOWN).join(', ')}${missing.length > SHOWN ? ', ...' : ''}; name them in only_nets or add a stage with no only_nets`);
  }
  return errors;
}
