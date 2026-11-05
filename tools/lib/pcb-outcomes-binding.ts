// Fail closed if an outcome producer or any evidence it reports changes during a run.
import { lstatSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { sha256File, readObject } from './json-file.ts';
import { parentCandidate } from './pcb-candidate.ts';

type Row = Record<string, unknown>;
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
  if (report.schema !== 'iot-lab.route-decision.v1' || report.qualified !== false
      || (code === 0 && (!['repairable', 'decision'].includes(String(report.status)) || report.board !== board))
      || (code !== 0 && report.status !== 'blocked')) throw new Error('routing report type, identity, or verdict disagrees');
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
