// Gate verdict admission for the CLI supervisor. A process exit without a
// matching terminal gate event and source-bound result is never a pass.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Obj = Record<string, unknown>;
export interface Finding { stage: string; cause: string; log: string }
export interface GateOutcome {
  status: 'passed' | 'failed' | 'error'; exit_code: number; cause: string;
  metrics: Obj; input_sha256: string; findings: Finding[];
}
const object = (value: unknown): value is Obj => value !== null && typeof value === 'object' && !Array.isArray(value);
const truthy = (value: unknown): boolean => Array.isArray(value) ? value.length > 0 : object(value) ? Object.keys(value).length > 0 : Boolean(value);

export function gateOutcome(folder: string, code: number, gateEnded: boolean, findings: Finding[]): GateOutcome {
  const report: unknown = JSON.parse(readFileSync(join(folder, 'gate/result.json'), 'utf8'));
  if (!object(report) || !object(report.metrics) || Object.keys(report.metrics).length === 0 || !object(report.provenance)
      || typeof report.provenance.input_sha256 !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/.test(report.provenance.input_sha256)
      || !object(report.provenance.tools) || typeof report.changedDuringRun !== 'boolean'
      || (report.checks !== undefined && !object(report.checks))) throw new Error('invalid gate result/provenance');
  if ((code !== 0 && code !== 1) || report.exit !== code || !gateEnded) throw new Error('gate exit and terminal evidence disagree');
  const metrics = report.metrics, tools = report.provenance.tools;
  const missing = Object.entries(metrics).filter(([, value]) => value === null).map(([name]) => name);
  const missingVersions = Object.entries(tools).filter(([, value]) => value === null).map(([name]) => name);
  const checks = object(report.checks) ? Object.values(report.checks).filter(object) : [];
  if (object(report.checks) && checks.length !== Object.keys(report.checks).length) throw new Error('invalid gate result/provenance');
  if (code === 0 && checks.some(check => ['failed', 'blocked', 'error'].includes(String(check.status))))
    throw new Error('gate exit and terminal evidence disagree');
  const knownFailure = checks.some(check => check.status === 'failed' && object(check.metrics)
    && Object.keys(check.metrics).length > 0 && Object.values(check.metrics).every(value => value !== null));
  const deliberatelyBlocked = missing.length > 0 && knownFailure && !truthy(report.preflightErrors)
    && missing.every(key => checks.some(check => check.status === 'blocked' && object(check.metrics) && key in check.metrics));
  if (report.changedDuringRun || (missing.length && !deliberatelyBlocked) || missingVersions.length) {
    const cause = report.changedDuringRun ? 'gate inputs changed during run; evidence is invalid'
      : missing.length ? `required checker did not complete: ${missing.join(', ')}` : `required tool version unavailable: ${missingVersions.join(', ')}`;
    return { status: 'error', exit_code: 2, cause, metrics, input_sha256: report.provenance.input_sha256, findings };
  }
  return { status: code === 0 ? 'passed' : 'failed', exit_code: code,
    cause: code === 0 ? 'all configured gate targets met' : deliberatelyBlocked ? 'native findings block dependent checks' : 'configured gate targets not met',
    metrics, input_sha256: report.provenance.input_sha256, findings };
}
