// The supervisor's admitted request, rechecked by its owned child. This record is not a security token:
// filesystem writers can replace it. Native checks, reviewed prerequisites and adoption remain separate.
import { join } from 'node:path';
import { fingerprint } from './fingerprint.ts';
import { sha256File } from './json-file.ts';
import { sourceState, type SourceState } from './pcb-sources.ts';
import { resolvePath } from './py-path.ts';
import { placements, expandRoute } from './route-spec.ts';
import { validatePlaceSpec, validateRouteFile } from './explicit-spec.ts';

type Row = Record<string, unknown>;
interface Binding { path: string; sha256: string; content?: Row }
export interface ActionRequest {
  root: string; board: string; operation: string; timeout_s?: number; kind?: string; router?: string; spec?: Row;
  plan?: Binding; design_contract?: Binding; engineering_manifest?: Binding; from_run?: { folder: string; result_sha256: string };
}
export interface ActionScope { refs: string[]; nets: string[]; layers: string[]; item_ids: string[]; all_nets: boolean; all_layers: boolean }
export interface AdmittedAction {
  schema: 'iot-lab.candidate-action.v1'; root: string; board: string; operation: string;
  source_revision: string; parameters_sha256: string; prerequisite_stage: string; scope: ActionScope; action_id: string;
}
const SCHEMA = 'iot-lab.candidate-action.v1';
const GUARDED = new Set(['edit', 'route', 'repair']);
const sorted = (values: string[]): string[] => [...new Set(values)].sort();
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

export const routesCopper = (request: Pick<ActionRequest, 'operation' | 'kind'>): boolean =>
  request.operation === 'route' || request.operation === 'repair' || (request.operation === 'edit' && request.kind === 'route');
export function prerequisiteStage(request: Pick<ActionRequest, 'operation' | 'kind'>): string {
  if (request.operation === 'release') return 'routing';
  if (request.operation === 'build') return 'architecture';
  return routesCopper(request) ? 'placement' : 'schematic';
}
function parameters(request: ActionRequest): Row {
  return { timeout_s: request.timeout_s ?? null, kind: request.kind ?? null, router: request.router ?? null, spec: request.spec ?? null, plan: request.plan ?? null,
    design_contract: request.design_contract ?? null, engineering_manifest: request.engineering_manifest ?? null, from_run: request.from_run ?? null };
}
/** Scope is captured from the request the supervisor admitted, not inferred from the eventual edited board. */
export function requestedScope(request: ActionRequest): ActionScope {
  const scope: ActionScope = { refs: [], nets: [], layers: [], item_ids: [], all_nets: false, all_layers: false };
  if (request.operation === 'edit' && request.kind === 'place') {
    const spec = request.spec; validatePlaceSpec(spec); scope.refs = [...placements(spec).keys()];
  }
  else if ((request.operation === 'edit' && request.kind === 'route') || (request.operation === 'route' && (request.router ?? 'explicit') === 'explicit')) {
    const spec = request.spec; validateRouteFile(spec);
    scope.nets = [...(spec.clear ?? []), ...(spec.move_vias ?? []).map(v => v.net), ...spec.routes.map(r => r.net)];
    for (const route of spec.routes) {
      const expanded = expandRoute(route);
      scope.layers.push(route.layer, ...expanded.segments.map(s => s.layer));
      // pcbtool creates through vias; clear and via moves also affect copper beyond the route's track layers.
      if (expanded.vias.length) scope.all_layers = true;
    }
    if (spec.clear?.length || spec.move_vias?.length) scope.all_layers = true;
  } else if (request.operation === 'repair') {
    const choice = request.plan?.content?.choice as Row | undefined;
    if (!choice || typeof choice.net !== 'string') throw new Error('repair action requires a diagnosed net and choice');
    scope.nets = [choice.net];
    if (choice.strategy === 'straight_gap_bridge' && typeof choice.layer === 'string') {
      scope.layers = [choice.layer]; scope.item_ids = strings(choice.endpoint_ids);
    } else if (choice.strategy === 'via_shift_bridge' && typeof choice.via_id === 'string' && typeof choice.along_trace_id === 'string') {
      scope.item_ids = [choice.via_id, choice.along_trace_id]; scope.all_layers = true;
    } else throw new Error('unsupported repair action scope');
  } else if (request.operation === 'route' && request.router === 'iotroute') {
    scope.nets = [...strings(request.spec?.nets), ...strings(request.spec?.reuse_nets)]; scope.layers = strings(request.spec?.layers);
    scope.all_nets = !strings(request.spec?.nets).length; scope.all_layers = true; // native through vias span the stack
  } else if (request.operation === 'route' && request.router === 'route-json') {
    // Stage skip globs, width edits and pours can touch the whole board. The exact plan remains bound by parameters_sha256.
    scope.all_nets = true; scope.all_layers = true;
  } else throw new Error('unsupported candidate action');
  for (const key of ['refs', 'nets', 'layers', 'item_ids'] as const) scope[key] = sorted(scope[key]);
  return scope;
}
function exactKeys(value: unknown, keys: string[], label: string): asserts value is Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected an object`);
  const actual = Object.keys(value);
  if (actual.some(key => !keys.includes(key)) || keys.some(key => !actual.includes(key))) throw new Error(`${label}: missing or unknown fields`);
}
function checkScope(value: unknown): asserts value is ActionScope {
  exactKeys(value, ['refs', 'nets', 'layers', 'item_ids', 'all_nets', 'all_layers'], 'action scope');
  for (const key of ['refs', 'nets', 'layers', 'item_ids']) {
    if (!Array.isArray(value[key]) || (value[key] as unknown[]).some(v => typeof v !== 'string' || !v)) throw new Error(`action scope ${key}: expected names`);
  }
  if (typeof value.all_nets !== 'boolean' || typeof value.all_layers !== 'boolean') throw new Error('action scope flags must be booleans');
}
export function assertActionScope(needed: ActionScope, admitted: ActionScope): void {
  checkScope(admitted);
  for (const key of ['refs', 'nets', 'layers', 'item_ids'] as const) {
    const all = key === 'nets' ? admitted.all_nets : key === 'layers' ? admitted.all_layers : false;
    if (!all && needed[key].some(name => !admitted[key].includes(name))) throw new Error(`candidate action exceeds admitted ${key} scope`);
  }
  if ((needed.all_nets && !admitted.all_nets) || (needed.all_layers && !admitted.all_layers)) throw new Error('candidate action exceeds admitted copper scope');
}
export function admitAction(request: ActionRequest): AdmittedAction | undefined {
  if (!GUARDED.has(request.operation)) return undefined;
  const scope = requestedScope(request), root = resolvePath(request.root);
  const body = { schema: SCHEMA, root, board: request.board, operation: request.operation, source_revision: sourceState(root, request.board).sha256,
    parameters_sha256: fingerprint(parameters(request)), prerequisite_stage: prerequisiteStage(request), scope } as const;
  return { ...body, action_id: fingerprint(body) };
}
export function verifyAction(request: ActionRequest, value: unknown, snapshot?: SourceState): void {
  if (!GUARDED.has(request.operation)) {
    if (value !== undefined) throw new Error('candidate action identity mismatch');
    return;
  }
  exactKeys(value, ['schema', 'root', 'board', 'operation', 'source_revision', 'parameters_sha256', 'prerequisite_stage', 'scope', 'action_id'], 'candidate action');
  const action = value as unknown as AdmittedAction, { action_id, ...body } = action;
  if (action.schema !== SCHEMA || action.root !== resolvePath(request.root) || action.board !== request.board || action.operation !== request.operation) throw new Error('candidate action identity mismatch');
  if (action.prerequisite_stage !== prerequisiteStage(request)) throw new Error('candidate action is out of order: wrong prerequisite stage');
  assertActionScope(requestedScope(request), action.scope);
  if (fingerprint(body) !== action_id || fingerprint(parameters(request)) !== action.parameters_sha256) throw new Error('candidate action parameters changed after admission');
  for (const binding of [request.plan, request.design_contract, request.engineering_manifest]) {
    if (binding && sha256File(binding.path) !== binding.sha256) throw new Error('candidate action reviewed input changed after admission');
  }
  if (request.from_run && sha256File(join(request.from_run.folder, 'result.json')) !== request.from_run.result_sha256) throw new Error('candidate action parent revision is stale');
  const current = sourceState(request.root, request.board);
  if (current.sha256 !== action.source_revision) throw new Error('candidate action source revision is stale');
  if (snapshot && Object.entries(current.files).some(([name, hash]) => snapshot.files[name] !== hash)) throw new Error('candidate snapshot differs from admitted source revision');
}
