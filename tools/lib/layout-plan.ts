// The layout plan: a person approves the placement intents and the route plan of a board before `place` or `route` runs.
// hardware-design/boards/BOARD/layout-plan.json (schema iot-lab.layout-plan.v1) holds the intents, the route plan path, and the
// approval with the sha256 of the placement rules, of the route plan and of the sealed schematic files at approval time. Rules are data, this file is the check.
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCanonicalRoot, schematicSha256, verifySeal, withSealLock } from './cad-seal.ts';
import { registryExemption } from './design-exemption.ts';
import { atomicJson, readObject, sha256File } from './json-file.ts';
import { durableAppend } from './pcb-check-durable.ts';
import { placementRulesPath } from './placement-rules.ts';
import { isFile, isRelativeTo } from './py-path.ts';
import { routePlanErrors } from './route-plan-schema.ts';
import { boardPlanNets, routePlanNetErrors, type PlanNets } from './route-plan-nets.ts';

export const LAYOUT_PLAN_SCHEMA = 'iot-lab.layout-plan.v1';
const KEYS = ['schema', 'intents', 'route_plan', 'approval'];
const INTENT_KEYS = ['id', 'statement', 'rule_ids'];
const APPROVAL_KEYS = ['by', 'reason', 'rules_sha256', 'route_plan_sha256', 'schematic_sha256', 'image', 'image_sha256'];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// An SVG may start with a BOM, an XML declaration, comments and a doctype. The first element must be svg.
const SVG_START = /^﻿?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s/>]/;
const IMAGE_TYPES = ['png', 'svg'];
const FEATURES = new Set(Object.keys((readObject<{ features?: object }>(fileURLToPath(new URL('../route-features.json', import.meta.url))).features) ?? {}));

type Row = Record<string, unknown>;
export interface Approval { by: string; reason: string; rules_sha256: string; route_plan_sha256: string; schematic_sha256: string; image: string; image_sha256: string }
export interface LayoutStatus {
  board: string; state: 'approved' | 'exempt' | 'missing' | 'invalid' | 'unapproved' | 'stale'; path: string;
  problems: string[]; stale: string[]; approval: Approval | null; image: string | null; exempt_reason?: string;
}
export interface LayoutBlock { code: 'layout_plan_missing' | 'layout_plan_stale'; message: string }
/** The nets of the board of BOARD. A test passes a stand-in: the real one reads the board JSON through the daemon. */
export type NetSource = (root: string, board: string) => PlanNets;
export type LayoutEmit = (kind: string, data?: Row) => void;

export const layoutPlanPath = (root: string, board: string): string => join(root, 'hardware-design/boards', board, 'layout-plan.json');
const imageCopyPath = (root: string, board: string, extension: string): string => join(root, 'hardware-design/boards', board, `layout-plan.${extension}`);
const logPath = (root: string, board: string): string => join(root, '.gate/layout-plan', `${board}.jsonl`);
const isObject = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const approveCommand = (board: string): string => `tools/pcb layout ${board} --approve --by NAME --reason TEXT --image FILE`;

interface Inspection { problems: string[]; approval: Approval | null; rulesSha: string | null; routeSha: string | null; imageSha: string | null }

/** The sha256 of an image of the project, or null when the file is gone or outside the project. */
function imageHash(root: string, image: string): string | null {
  const path = resolve(root, image);
  return isRelativeTo(path, resolve(root)) && path !== resolve(root) && isFile(path) ? sha256File(path) : null;
}

/** The problems of the plan file, the approval it holds, and the hashes of the two approved inputs as they are now. A `boardNets` also checks the route plan against the nets of the board. */
function inspect(root: string, board: string, plan: Row, boardNets: NetSource | null = null): Inspection {
  const problems: string[] = [];
  const out: Inspection = { problems, approval: null, rulesSha: null, routeSha: null, imageSha: null };
  for (const key of Object.keys(plan)) if (!KEYS.includes(key)) problems.push(`unknown key ${key}`);
  if (plan.schema !== LAYOUT_PLAN_SCHEMA) problems.push(`schema must be ${LAYOUT_PLAN_SCHEMA}`);

  const rulesFile = placementRulesPath(root, board);
  let ruleIds: Set<string> | null = null;
  if (isFile(rulesFile)) {
    try {
      const rules = readObject(rulesFile).rules;
      ruleIds = new Set(Array.isArray(rules) ? rules.flatMap(rule => isObject(rule) && typeof rule.id === 'string' ? [rule.id] : []) : []);
      out.rulesSha = sha256File(rulesFile);
    } catch (error) { problems.push(`placement-constraints.json: ${(error as Error).message}`); }
  }
  if (!Array.isArray(plan.intents) || !plan.intents.length) problems.push('intents must be a non-empty list');
  else {
    const seen = new Set<string>();
    plan.intents.forEach((intent: unknown, index: number) => {
      if (!isObject(intent)) { problems.push(`intents[${index}] must be an object`); return; }
      const name = text(intent.id) ? intent.id : `intents[${index}]`;
      for (const key of Object.keys(intent)) if (!INTENT_KEYS.includes(key)) problems.push(`intent ${name}: unknown key ${key}`);
      if (!text(intent.id)) problems.push(`${name}: id must be a non-empty string`);
      else if (seen.has(intent.id)) problems.push(`duplicate intent id ${intent.id}`);
      else seen.add(intent.id);
      if (!text(intent.statement)) problems.push(`intent ${name}: statement must be a non-empty string`);
      if (!Array.isArray(intent.rule_ids) || !intent.rule_ids.length || intent.rule_ids.some(id => !text(id))) problems.push(`intent ${name}: rule_ids needs at least one rule id`);
      else if (ruleIds === null) { if (!isFile(rulesFile)) problems.push(`intent ${name}: ${relative(root, rulesFile).split(sep).join('/')} is missing`); }
      else for (const id of intent.rule_ids as string[]) if (!ruleIds.has(id)) problems.push(`intent ${name}: rule id ${id} is not in placement-constraints.json`);
    });
  }

  const given = plan.route_plan;
  if (!text(given)) problems.push('route_plan must be the path of the board route plan');
  else {
    const path = resolve(root, given);
    if (!isRelativeTo(path, resolve(root)) || path === resolve(root)) problems.push('route_plan must be a path inside the project');
    else if (!isFile(path)) problems.push(`route_plan ${given} is not a file`);
    else {
      out.routeSha = sha256File(path);
      try {
        const route = JSON.parse(readFileSync(path, 'utf8')) as unknown, errors = routePlanErrors(route, FEATURES);
        for (const error of errors) problems.push(`route plan: ${error}`);
        // The nets of the board are read only at approval. Later the schematic hash and the route plan hash bind the approval.
        if (!errors.length && boardNets) {
          try { for (const error of routePlanNetErrors(route, boardNets(root, board))) problems.push(`route plan: ${error}`); }
          catch (error) { problems.push(`route plan nets: ${(error as Error).message}`); }
        }
      } catch (error) { problems.push(`route plan: ${(error as Error).message}`); }
    }
  }

  const approval = plan.approval;
  if (approval !== null && approval !== undefined) {
    if (!isObject(approval) || Object.keys(approval).length !== APPROVAL_KEYS.length || APPROVAL_KEYS.some(key => !text(approval[key]))) problems.push('approval needs by, reason, rules_sha256, route_plan_sha256, schematic_sha256, image and image_sha256');
    else { out.approval = approval as unknown as Approval; out.imageSha = imageHash(root, out.approval.image); }
  }
  return out;
}

function readPlan(path: string): Row {
  try { return readObject(path); } catch (error) { throw new Error(`${path} is not a layout plan: ${(error as Error).message}`); }
}

/** Where the layout plan of BOARD stands. An unreadable plan or a malformed exemption is an error: it never reads as approved. */
export function layoutPlanStatus(root: string, board: string): LayoutStatus {
  const path = layoutPlanPath(root, board);
  const status = (state: LayoutStatus['state'], more: Partial<LayoutStatus> = {}): LayoutStatus => ({ board, state, path, problems: [], stale: [], approval: null, image: more.approval?.image ?? null, ...more });
  const exempt = registryExemption(root, board, 'layout_plan_exempt');
  if (exempt !== null) return status('exempt', { exempt_reason: exempt });
  if (!isFile(path)) return status('missing');
  let plan: Row;
  try { plan = readPlan(path); } catch (error) { return status('invalid', { problems: [(error as Error).message] }); }
  const found = inspect(root, board, plan);
  if (found.problems.length) return status('invalid', { problems: found.problems });
  if (!found.approval) return status('unapproved');
  const stale = [
    ...(found.approval.rules_sha256 === found.rulesSha ? [] : ['placement-constraints.json changed since the approval']),
    ...(found.approval.route_plan_sha256 === found.routeSha ? [] : ['the route plan changed since the approval']),
    ...(found.approval.schematic_sha256 === schematicSha256(root, board) ? [] : ['the schematic changed since the approval']),
    ...(found.imageSha === null ? ['the approved image is missing'] : found.approval.image_sha256 === found.imageSha ? [] : ['the approved image changed since the approval']),
  ];
  return status(stale.length ? 'stale' : 'approved', { stale, approval: found.approval });
}

/** null when the plan is approved or the board is exempt (an exempt board writes one event). Else the stop and the way to continue. */
export function layoutGate(root: string, board: string, emit: LayoutEmit): LayoutBlock | null {
  const status = layoutPlanStatus(root, board), file = relative(root, status.path).split(sep).join('/');
  if (status.state === 'exempt') { emit('layout_plan.exempt', { board, reason: status.exempt_reason }); return null; }
  if (status.state === 'approved') return null;
  const code = status.state === 'stale' ? 'layout_plan_stale' : 'layout_plan_missing';
  const message = status.state === 'missing' ? `${board} has no layout plan (${file}). Write it with the placement intents and the route plan. Then a person runs: ${approveCommand(board)}`
    : status.state === 'invalid' ? `The layout plan of ${board} is not valid (${file}):\n  ${status.problems.join('\n  ')}\nFix the file. Then check it with: tools/pcb layout ${board}`
    : status.state === 'unapproved' ? `The layout plan of ${board} is not approved. A person runs: ${approveCommand(board)}`
    : `The layout plan approval of ${board} is stale:\n  ${status.stale.join('\n  ')}\nA person reviews the change and runs: ${approveCommand(board)}`;
  return { code, message };
}

/** An event with no run folder (`pcb place`) goes to the local log .gate/layout-plan/BOARD.jsonl. */
export const layoutLog = (root: string, board: string): LayoutEmit => (kind, data = {}) => {
  mkdirSync(dirname(logPath(root, board)), { recursive: true });
  durableAppend(logPath(root, board), JSON.stringify({ time: new Date().toISOString(), type: kind, ...data }) + '\n');
};

/**
 * Keeps the image that a person saw as hardware-design/boards/BOARD/layout-plan.png or .svg and returns that path and its hash.
 * The run folders are not committed, so the approval must not point at one. The type comes from the content, not the name.
 * Fail closed: no file, a file that is neither PNG nor SVG, or a path outside the project stops before anything is written.
 */
function approvedImage(root: string, board: string, given: string): { image: string; sha256: string } {
  if (!isFile(given)) throw new Error(`image ${given} is not a file`);
  const base = realpathSync(root), path = realpathSync(given);
  if (!isRelativeTo(path, base) || path === base) throw new Error(`image must be inside the project: ${given}`);
  const data = readFileSync(path), extension = data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ? 'png' : SVG_START.test(data.toString('utf8')) ? 'svg' : null;
  if (!extension) throw new Error(`image ${given} is not a PNG or SVG file`);
  const copy = imageCopyPath(root, board, extension);
  if (!existsSync(copy) || realpathSync(copy) !== path) copyFileSync(path, copy);
  return { image: relative(root, copy).split(sep).join('/'), sha256: sha256File(copy) };
}

/** `tools/pcb layout BOARD --approve --by NAME --reason TEXT --image FILE`: records the person, the reason, the image that the person saw and the hashes of the inputs. */
export async function approveLayoutPlan(root: string, board: string, by: string, reason: string, imageFile: string, boardNets: NetSource = boardPlanNets): Promise<LayoutStatus> {
  if (!by?.trim()) throw new Error('--approve requires --by NAME');
  if (!reason?.trim()) throw new Error('--approve requires --reason TEXT');
  if (!imageFile?.trim()) throw new Error('--approve requires --image FILE');
  if (!isCanonicalRoot(root)) throw new Error(`${root} is a run workspace or candidate copy, not canonical; it is never approved`);
  const path = layoutPlanPath(root, board);
  withSealLock(root, board, () => {
    verifySeal(root, board);
    if (!isFile(path)) throw new Error(`${board} has no layout plan (${path})`);
    const plan = readPlan(path), found = inspect(root, board, plan, boardNets);
    if (found.problems.length) throw new Error(`The layout plan of ${board} is not valid:\n  ${found.problems.join('\n  ')}`);
    const seen = approvedImage(root, board, imageFile);
    const approval: Approval = { by: by.trim(), reason: reason.trim(), rules_sha256: found.rulesSha!, route_plan_sha256: found.routeSha!, schematic_sha256: schematicSha256(root, board), image: seen.image, image_sha256: seen.sha256 };
    atomicJson(path, { ...plan, approval });
    // One copy only: the copy of the other type belonged to an earlier approval.
    for (const extension of IMAGE_TYPES) if (join(root, seen.image) !== imageCopyPath(root, board, extension)) rmSync(imageCopyPath(root, board, extension), { force: true });
    layoutLog(root, board)('layout_plan.approved', { board, ...approval });
  });
  return layoutPlanStatus(root, board);
}
