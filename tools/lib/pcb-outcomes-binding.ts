// Fail closed if an outcome producer or any evidence it reports changes during a run.
import { lstatSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { sha256File, readObject } from './json-file.ts';
import { parentCandidate } from './pcb-candidate.ts';

type Row = Record<string, unknown>;
interface Reference { folder: string; result_sha256: string }
export interface Requested { files: Record<string, string>; absent: string[] }
/** The observation operations: their backend writes operation/report.json and this module judges it. */
export const OBSERVATIONS = new Set(['outcomes', 'schematic', 'design', 'parts', 'routing', 'placement', 'ml']);
export function producer(root: string, node: string): Record<string, string> {
  if (process.env.NODE_OPTIONS || process.env.NODE_PATH) throw new Error('unreviewed Node startup override');
  const tools = join(root, 'tools'), files = [node];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !['node_modules', 'target', '.git', '.gate', '__pycache__'].includes(entry.name)) walk(path);
      else if (entry.isFile() && /\.(?:ts|mjs|js|cjs|json)$/.test(entry.name)) files.push(path);
    }
  };
  walk(tools);
  return Object.fromEntries(files.sort().map(path => [path, sha256File(path)]));
}
export function outcome(folder: string, root: string, study: string, code: number, binding: Record<string, string>): Row {
  if (JSON.stringify(producer(root, process.execPath)) !== JSON.stringify(binding)) throw new Error('outcome producer changed during observation');
  const report = readObject<Row>(join(folder, 'operation/report.json'));
  if (report.schema !== 'iot-lab.placement-outcome-comparison.v1' || report.study_id !== study || report.qualified !== false
      || !['passed', 'blocked', 'stale'].includes(String(report.status)) || (code === 0) !== (report.status === 'passed'))
    throw new Error('outcome report type, identity, or verdict disagrees');
  const inputs: Record<string, string> = { ...binding };
  for (const name of ['inputs', 'tool_inputs']) {
    const entries = report[name] ?? {};
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('invalid outcome inputs');
    for (const [path, digest] of Object.entries(entries)) {
      const absolute = resolve(root, path);
      if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest) || !statSync(absolute).isFile() || sha256File(absolute) !== digest)
        throw new Error('outcome input changed: ' + path);
      if (inputs[absolute] && inputs[absolute] !== digest) throw new Error('outcome producer input disagrees: ' + path);
      inputs[absolute] = digest;
    }
  }
  return { status: code === 0 ? 'passed' : code === 2 ? 'error' : 'failed', exit_code: code === 0 ? 0 : code === 2 ? 2 : 1,
    cause: code === 0 ? 'outcomes completed' : 'outcomes blocked; inspect report.json', scope: 'placement_outcomes', operation: 'outcomes',
    tool_exit: code, report: join(folder, 'operation/report.json'), report_sha256: sha256File(join(folder, 'operation/report.json')), engineering_status: report.status,
    engineering_inputs: inputs, engineering_producer_inputs: binding, qualified: false, release_approved: false };
}

export function schematic(folder: string, root: string, board: string, code: number, binding: Record<string, string>): Row {
  if (JSON.stringify(producer(root, process.execPath)) !== JSON.stringify(binding)) throw new Error('schematic producer changed during observation');
  const path = join(folder, 'operation/report.json'), report = readObject<Row>(path);
  if (report.schema !== 'iot-lab.schematic-contract-result.v1' || report.board !== board || report.qualified !== false
      || !['passed', 'blocked', 'stale'].includes(String(report.status)) || (code === 0) !== (report.status === 'passed'))
    throw new Error('schematic report type, identity, or verdict disagrees');
  const inputs: Record<string, string> = { ...binding };
  for (const name of ['inputs', 'native_inputs', 'tool_inputs']) {
    const entries = report[name] ?? {};
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('invalid schematic inputs');
    for (const [file, digest] of Object.entries(entries)) {
      const absolute = resolve(root, file);
      if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest) || !statSync(absolute).isFile() || sha256File(absolute) !== digest)
        throw new Error('schematic input changed: ' + file);
      if (inputs[absolute] && inputs[absolute] !== digest) throw new Error('schematic producer input disagrees: ' + file);
      inputs[absolute] = digest;
    }
  }
  const absent = report.absent_inputs ?? [];
  if (!Array.isArray(absent) || absent.some(name => {
    if (typeof name !== 'string') return true;
    const path = resolve(root, name), rel = relative(root, path);
    return rel === '..' || rel.startsWith('../') || isAbsolute(rel) || !!lstatSync(path, { throwIfNoEntry: false });
  }))
    throw new Error('schematic absent input appeared');
  return { status: code === 0 ? 'passed' : code === 2 ? 'error' : 'failed', exit_code: code === 0 ? 0 : code === 2 ? 2 : 1,
    cause: code === 0 ? 'schematic completed' : 'schematic blocked; inspect report.json', scope: 'schematic_function', operation: 'schematic',
    tool_exit: code, report: path, report_sha256: sha256File(path), engineering_status: report.status,
    engineering_inputs: inputs, engineering_absent_inputs: absent, engineering_producer_inputs: binding, qualified: false, release_approved: false };
}

export function design(folder: string, root: string, id: string, stage: string, contract: { path: string; sha256: string }, code: number, binding: Record<string, string>): Row {
  if (JSON.stringify(producer(root, process.execPath)) !== JSON.stringify(binding)) throw new Error('design producer changed during observation');
  if (sha256File(contract.path) !== contract.sha256) throw new Error('design contract changed after admission');
  const path = join(folder, 'operation/report.json'), report = readObject<Row>(path);
  if (report.schema !== 'iot-lab.design-assessment.v1' || report.design_id !== id || report.through !== stage || report.qualified !== false
      || !['passed', 'blocked', 'stale'].includes(String(report.status)) || (code === 0) !== (report.status === 'passed'))
    throw new Error('design report type, identity, stage, or verdict disagrees');
  const inputs: Record<string, string> = { ...binding, [contract.path]: contract.sha256 };
  for (const name of ['inputs', 'tool_inputs']) {
    const entries = report[name] ?? {};
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('invalid design inputs');
    for (const [file, digest] of Object.entries(entries)) {
      const absolute = resolve(root, file);
      if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest) || !statSync(absolute).isFile() || sha256File(absolute) !== digest)
        throw new Error('design input changed: ' + file);
      if (inputs[absolute] && inputs[absolute] !== digest) throw new Error('design input disagrees: ' + file);
      inputs[absolute] = digest;
    }
  }
  const absent = report.absent_inputs ?? [];
  if (!Array.isArray(absent) || absent.some(name => {
    if (typeof name !== 'string') return true;
    const path = resolve(root, name), rel = relative(root, path);
    return rel === '..' || rel.startsWith('../') || isAbsolute(rel) || !!lstatSync(path, { throwIfNoEntry: false });
  })) throw new Error('design absent input appeared or escaped checkout');
  return { status: code === 0 ? 'passed' : code === 2 ? 'error' : 'failed', exit_code: code === 0 ? 0 : code === 2 ? 2 : 1,
    cause: code === 0 ? 'design completed' : 'design blocked; inspect report.json', scope: 'design_assessment', operation: 'design',
    tool_exit: code, report: path, report_sha256: sha256File(path), engineering_status: report.status,
    engineering_inputs: inputs, engineering_absent_inputs: absent, engineering_producer_inputs: binding, qualified: false, release_approved: false };
}

export function parts(folder: string, root: string, board: string, args: string[], reference: { folder: string; result_sha256: string } | undefined, code: number, binding: Record<string, string>): Row {
  if (JSON.stringify(producer(root, process.execPath)) !== JSON.stringify(binding)) throw new Error('parts producer changed during observation');
  const backendRoot = reference ? join(reference.folder, 'workspace') : root;
  const dependencies = reference ? parentCandidate(root, board, reference).dependencies : {};
  const path = join(folder, 'operation/report.json'), report = readObject<Row>(path);
  const success = ['passed', 'inspected', 'observed'].includes(String(report.status));
  if (report.schema !== 'iot-lab.part-evidence.v1' || report.qualified !== false || (code === 0) !== success)
    throw new Error('parts report type or verdict disagrees');
  if (report.board && args[0] !== 'inspect' && report.board !== board) throw new Error('parts report belongs to another board');
  const inputs: Record<string, string> = { ...binding, ...dependencies };
  for (const name of ['inputs', 'native_inputs', 'tool_inputs', 'source_inputs', 'evidence_sha256', 'implementation_sha256']) {
    const entries = report[name] ?? {};
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('invalid parts inputs');
    for (const [file, digest] of Object.entries(entries)) {
      const absolute = resolve(name === 'implementation_sha256' ? join(backendRoot, 'tools') : backendRoot, file);
      if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest) || !statSync(absolute).isFile() || sha256File(absolute) !== digest)
        throw new Error('parts input changed: ' + file);
      if (inputs[absolute] && inputs[absolute] !== digest) throw new Error('parts input disagrees: ' + file);
      inputs[absolute] = digest;
    }
  }
  const absent = report.absent_inputs ?? [];
  if (!Array.isArray(absent) || absent.some(name => {
    if (typeof name !== 'string') return true;
    const file = resolve(backendRoot, name), rel = relative(backendRoot, file);
    return rel === '..' || rel.startsWith('../') || isAbsolute(rel) || !!lstatSync(file, { throwIfNoEntry: false });
  })) throw new Error('parts absent input appeared or escaped checkout');
  return { status: code === 0 ? 'passed' : code === 2 ? 'error' : 'failed', exit_code: code === 0 ? 0 : code === 2 ? 2 : 1,
    cause: code === 0 ? 'parts completed' : 'parts blocked; inspect report.json', scope: 'part_evidence', operation: 'parts', tool_exit: code,
    report: path, report_sha256: sha256File(path), engineering_status: report.status, engineering_inputs: inputs,
    engineering_absent_inputs: absent, engineering_producer_inputs: binding, qualified: false, release_approved: false };
}

export function routing(folder: string, root: string, board: string, reference: { folder: string; result_sha256: string } | undefined, code: number, binding: Record<string, string>): Row {
  if (JSON.stringify(producer(root, process.execPath)) !== JSON.stringify(binding)) throw new Error('routing producer changed during observation');
  const backendRoot = reference ? join(reference.folder, 'workspace') : root;
  const dependencies = reference ? parentCandidate(root, board, reference).dependencies : {};
  const path = join(folder, 'operation/report.json'), report = readObject<Row>(path);
  if (!['iot-lab.route-decision.v1', 'iot-lab.route-move.v1'].includes(String(report.schema)) || report.qualified !== false
      || (code === 0 && (!['repairable', 'decision', 'accepted', 'proposal', 'ask_user'].includes(String(report.status)) || report.board !== board))
      || (code !== 0 && !['blocked', 'rejected'].includes(String(report.status)))) throw new Error('routing report type, identity, or verdict disagrees');
  const inputs: Record<string, string> = { ...binding, ...dependencies };
  for (const name of ['inputs', 'native_inputs', 'source_inputs', 'evidence_sha256', 'implementation_sha256']) {
    const entries = report[name] ?? {};
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('invalid routing inputs');
    for (const [file, digest] of Object.entries(entries)) {
      const absolute = resolve(name === 'implementation_sha256' ? join(backendRoot, 'tools') : backendRoot, file);
      if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest) || !statSync(absolute).isFile() || sha256File(absolute) !== digest)
        throw new Error('routing input changed: ' + file);
      if (inputs[absolute] && inputs[absolute] !== digest) throw new Error('routing input disagrees: ' + file);
      inputs[absolute] = digest;
    }
  }
  return { status: code === 0 ? 'passed' : code === 2 ? 'error' : 'failed', exit_code: code === 0 ? 0 : code === 2 ? 2 : 1,
    cause: code === 0 ? 'routing completed' : 'routing blocked; inspect report.json', scope: 'routing_decision', operation: 'routing', tool_exit: code,
    report: path, report_sha256: sha256File(path), engineering_status: report.status, engineering_inputs: inputs,
    engineering_absent_inputs: [], engineering_producer_inputs: binding, qualified: false, release_approved: false };
}

export function placementRequested(root: string, args: string[]): Requested {
  const files: Record<string, string> = {}, absent: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i]!.split(/=(.*)/s, 2);
    if (!['--manifest', '--candidate', '--escape-evidence'].includes(flag!)) continue;
    const value = inline ?? args[++i];
    if (!value) throw new Error('placement input path missing');
    const path = resolve(root, value), stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) absent.push(path); else if (!statSync(path).isFile()) throw new Error('placement input is not a file: ' + path); else files[path] = sha256File(path);
  }
  return { files, absent };
}
export function placement(folder: string, root: string, board: string, args: string[], reference: { folder: string; result_sha256: string } | undefined,
  code: number, binding: Record<string, string>, requested: Requested): Row {
  if (JSON.stringify(producer(root, process.execPath)) !== JSON.stringify(binding)) throw new Error('placement producer changed during observation');
  if (JSON.stringify(placementRequested(root, args)) !== JSON.stringify(requested)) throw new Error('placement requested inputs changed during observation');
  const backendRoot = reference ? join(reference.folder, 'workspace') : root;
  const dependencies = reference ? parentCandidate(root, board, reference).dependencies : {};
  const path = join(folder, 'operation/report.json'), report = readObject<Row>(path);
  if (report.schema !== 'iot-lab.engineering-placement-check.v1' || report.board !== board || report.qualified !== false
      || !['passed', 'blocked', 'stale'].includes(String(report.status)) || (code === 0) !== (report.status === 'passed')) throw new Error('placement report type, identity, or verdict disagrees');
  const inputs: Record<string, string> = { ...binding, ...dependencies, ...requested.files };
  for (const name of ['inputs', 'native_inputs', 'tool_inputs', 'source_inputs', 'evidence_sha256']) {
    const entries = report[name] ?? {};
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('invalid placement inputs');
    for (const [file, digest] of Object.entries(entries)) {
      const absolute = resolve(backendRoot, file);
      if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest) || !statSync(absolute).isFile() || sha256File(absolute) !== digest) throw new Error('placement input changed: ' + file);
      if (inputs[absolute] && inputs[absolute] !== digest) throw new Error('placement input disagrees: ' + file);
      inputs[absolute] = digest;
    }
  }
  if (report.native && report.candidate_sha256) {
    const native = resolve(root, String(report.native)), digest = report.candidate_sha256;
    if (typeof digest !== 'string' || sha256File(native) !== digest) throw new Error('placement candidate changed');
    inputs[native] = digest;
  }
  return { status: code === 0 ? 'passed' : code === 2 ? 'error' : 'failed', exit_code: code === 0 ? 0 : code === 2 ? 2 : 1,
    cause: code === 0 ? 'placement completed' : 'placement blocked; inspect report.json', scope: 'placement_constraints', operation: 'placement', tool_exit: code,
    report: path, report_sha256: sha256File(path), engineering_status: report.status, engineering_inputs: inputs,
    engineering_absent_inputs: requested.absent, engineering_requested_inputs: requested, engineering_producer_inputs: binding, qualified: false, release_approved: false };
}

/** The inputs an ML action declares before it runs. An absent one stays recorded, so it cannot appear unnoticed. */
export async function mlRequested(root: string, args: string[]): Promise<Requested> {
  const { dependencies } = await import('../pcb_ml.ts');
  const files: Record<string, string> = {}, absent: string[] = [];
  for (const [path, digest] of Object.entries(await dependencies(root, args))) {
    if (digest === null) absent.push(path);
    else {
      if (!statSync(path).isFile() || sha256File(path) !== digest) throw new Error('ML input changed before backend execution: ' + path);
      files[path] = digest;
    }
  }
  return { files, absent };
}

export function ml(folder: string, root: string, args: string[], code: number, binding: Record<string, string>, requested: Requested): Row {
  if (JSON.stringify(producer(root, process.execPath)) !== JSON.stringify(binding)) throw new Error('ML producer changed during observation');
  const output = join(folder, 'operation'), path = join(output, 'report.json'), report = readObject<Row>(path);
  if (report.schema !== 'iot-lab.pcb-ml-result.v1' || !['passed', 'blocked', 'failed'].includes(String(report.status))
      || report.qualified !== false || (code === 0) !== (report.status === 'passed')) throw new Error('ML report type or verdict disagrees');
  if (report.action !== args[0] || report.id !== args[1]) throw new Error('ML assessment belongs to another action or ID');
  if (report.adopt_model !== false || ![0, 1, 2].includes(code)) throw new Error('ML assessment must remain non-adopting with a valid exit');
  if (report.status === 'passed' && requested.absent.length) throw new Error('ML assessment passed with an absent requested input');
  const hashes = (name: string): Record<string, string> => {
    const entries = report[name];
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)
        || Object.values(entries).some(digest => typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest))) throw new Error(`ML assessment has an invalid ${name} inventory`);
    return entries as Record<string, string>;
  };
  const artifacts = hashes('artifacts');
  if (report.status === 'passed' && !Object.keys(artifacts).length) throw new Error('passed ML assessment has no owned output artifact');
  for (const [name, digest] of Object.entries(artifacts)) {
    const file = resolve(output, name), rel = relative(output, file), stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || rel.startsWith('..') || isAbsolute(rel) || rel === 'report.json' || rel === 'result.json' || sha256File(file) !== digest)
      throw new Error('ML artifact is missing, changed or outside its owned operation: ' + name);
  }
  const inputs: Record<string, string> = { ...binding, ...requested.files };
  for (const [name, digest] of [...Object.entries(hashes('inputs')), ...Object.entries(hashes('tool_inputs'))]) {
    const file = resolve(root, name);
    if (inputs[file] && inputs[file] !== digest) throw new Error('ML backend reported a changed input: ' + name);
    inputs[file] = digest;
  }
  for (const [file, digest] of Object.entries(inputs))
    if (!statSync(file, { throwIfNoEntry: false })?.isFile() || sha256File(file) !== digest) throw new Error('ML input changed: ' + file);
  const reported = report.absent_inputs ?? [];
  if (!Array.isArray(reported)) throw new Error('invalid ML absent inputs');
  const absent = [...new Set([...requested.absent, ...reported.map(name => resolve(root, String(name)))])].sort();
  if (absent.some(file => !requested.absent.includes(file) || lstatSync(file, { throwIfNoEntry: false }))) throw new Error('ML absent input appeared or was never declared');
  return { status: code === 0 ? 'passed' : code === 2 ? 'error' : 'failed', exit_code: code, cause: String(report.cause ?? (code === 0 ? 'ml completed' : 'ml blocked; inspect report.json')),
    scope: 'ml_observation', operation: 'ml', tool_exit: code, report: path, report_sha256: sha256File(path), engineering_status: report.status,
    engineering_inputs: inputs, engineering_absent_inputs: absent, engineering_requested_inputs: requested, engineering_producer_inputs: binding,
    qualified: false, release_approved: false, adopt_model: false, ml_action: report.action, ml_id: report.id, artifacts };
}

/** The inputs an observation fixes before its backend starts. */
export async function requestedInputs(operation: string, root: string, args: string[]): Promise<Requested | undefined> {
  if (operation === 'placement') return placementRequested(root, args);
  return operation === 'ml' ? mlRequested(root, args) : undefined;
}

interface ObservationManifest { root: string; board: string; operation: string; arguments?: unknown; from_run?: unknown; design_id?: unknown; design_stage?: unknown; design_contract?: unknown }

/** The sealed judgement of one observation; the finalizer repeats it, so nothing may change between the two. */
export function observationEvidence(folder: string, manifest: ObservationManifest, code: number, binding: Record<string, string>, requested?: Requested): Row {
  const { root, board } = manifest, args = (manifest.arguments ?? []) as string[], parent = manifest.from_run as Reference | undefined;
  switch (manifest.operation) {
    case 'placement': return placement(folder, root, board, args, parent, code, binding, requested!);
    case 'routing': return routing(folder, root, board, parent, code, binding);
    case 'parts': return parts(folder, root, board, args, parent, code, binding);
    case 'design': return design(folder, root, String(manifest.design_id), String(manifest.design_stage), manifest.design_contract as { path: string; sha256: string }, code, binding);
    case 'schematic': return schematic(folder, root, board, code, binding);
    case 'outcomes': return outcome(folder, root, String(args[1]), code, binding);
    case 'ml': return ml(folder, root, args, code, binding, requested!);
    default: throw new Error('not an observation: ' + manifest.operation);
  }
}
