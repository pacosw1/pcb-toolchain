// What a build, edit, route, repair or release run fixes at admission: its spec, its router, and the reviewed inputs it binds.
import { join } from 'node:path';
import { validateExplicitSpec } from './explicit-spec.ts';
import { readObject } from './json-file.ts';
import { boardConfig, routePolicyArgs, sha } from './pcb-workflow.ts';
import { isFile, resolvePath } from './py-path.ts';
import { placeChoice } from './place-record.ts';
import { boardPlanNets, routePlanNetErrors } from './route-plan-nets.ts';

export const CANDIDATE = new Set(['build', 'edit', 'route', 'repair']);
export const OPERATIONS = new Set([...CANDIDATE, 'release']);
export const ROUTERS = ['explicit', 'route-json', 'iotroute'];
const ROUTE_SCHEMA = 'iot-lab.route.v1';

export interface CandidateRequest { spec?: string; kind?: string; origin?: string; router?: string; plan?: string; engineeringManifest?: string; designContract?: string }
interface Previous { engineering_manifest?: { path: string }; design_contract?: { path: string } }

function bind(name: string, given: string): Record<string, unknown> {
  const path = resolvePath(given), content = readObject<Record<string, unknown>>(path, `${name} requires a JSON object`);
  return { path, sha256: sha(path), content };
}

function specFor(root: string, operation: string, board: string, router: string, given?: string): string | undefined {
  if (operation !== 'route' || given || router === 'iotroute') return given;
  if (router !== 'route-json') throw new Error(`route --router ${router} requires --spec`);
  return join(boardConfig(root, board).folder, 'route.json');
}

/** The manifest fields of this candidate. A continued run keeps the reviewed inputs of its parent. */
export function candidateFields(root: string, operation: string, board: string, request: CandidateRequest, parent?: string, boardNets = boardPlanNets): Record<string, unknown> {
  const previous = parent ? readObject<Previous>(join(parent, 'run.json')) : undefined;
  const reviewed = (folder: string): string | undefined => { const path = join(root, 'hardware-design/registry', folder, `${board}.json`); return isFile(path) ? path : undefined; };
  const candidate = CANDIDATE.has(operation);
  const engineering = !candidate ? undefined : request.engineeringManifest ?? previous?.engineering_manifest?.path ?? reviewed('part-reviews');
  const contract = request.designContract ?? (candidate ? previous?.design_contract?.path : undefined) ?? reviewed('design-contracts');
  const router = request.router ?? 'explicit', specPath = specFor(root, operation, board, router, request.spec);
  const fields: Record<string, unknown> = {};
  if (specPath) {
    const spec = readObject<Record<string, unknown>>(resolvePath(specPath), 'candidate spec must be a JSON object');
    if (operation === 'route' && router === 'route-json' && spec.schema !== ROUTE_SCHEMA) throw new Error(`route --router route-json requires a ${ROUTE_SCHEMA} spec`);
    if (operation === 'route' && router === 'iotroute') routePolicyArgs(spec, 'candidate');
    Object.assign(fields, { spec, spec_sha256: sha(resolvePath(specPath)) });
  }
  validateExplicitSpec(operation, request.kind, router, fields.spec);
  if (operation === 'route' && router === 'route-json') {
    const errors = routePlanNetErrors(fields.spec, boardNets(root, board, parent));
    if (errors.length) throw new Error(`route plan does not fit the nets of ${board}: ${errors.join('; ')}`);
  }
  if (operation === 'edit' && request.kind === 'place') fields.place_choice = placeChoice(root, board, resolvePath(specPath!), request.origin);
  if (operation === 'route') fields.router = router;
  if (request.kind) fields.kind = request.kind;
  if (request.plan) fields.plan = bind('plan', request.plan);
  if (engineering) fields.engineering_manifest = bind('engineering_manifest', engineering);
  if (contract) fields.design_contract = bind('design_contract', contract);
  return fields;
}
