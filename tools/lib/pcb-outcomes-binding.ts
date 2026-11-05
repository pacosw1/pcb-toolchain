// Fail closed if an outcome producer or any evidence it reports changes during a run.
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256File, readObject } from './json-file.ts';

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
