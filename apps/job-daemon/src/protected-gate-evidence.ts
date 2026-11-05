// Structural validation of fresh gate output only. It does not invoke a verifier, authenticate output,
// establish dependency provenance, inspect tool identities or confirm cleanup; never accept client evidence as trusted.
import { createHash } from 'node:crypto';
import { parseEvidenceJson } from './canonical-json.ts';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA = /^[0-9a-f]{64}$/;
const obj = (v:unknown):v is Record<string,unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const digest = (b:Uint8Array):string => createHash('sha256').update(b).digest('hex');
function json(bytes:Uint8Array):unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 16 * 1024 * 1024) throw new Error('invalid gate evidence size');
  try { return parseEvidenceJson(bytes); } catch { throw new Error('invalid gate evidence JSON'); }
}
function sameSet(values:unknown, required:Set<string>): boolean {
  return Array.isArray(values) && values.length === required.size && values.every(v => typeof v === 'string' && required.has(v)) && new Set(values).size === required.size;
}
const violations = (value:unknown): boolean => Array.isArray(value) && value.every(row => obj(row) && ['warning','info','exclusion'].includes(String(row.severity)));

export function validateFreshGateEvidence(input: {result:Uint8Array;findings:Uint8Array;identity:Uint8Array;erc?:Uint8Array;drc?:Uint8Array},
  expected: {board:string;project:string;inputSha256:string;requiredInputs:{path:string;sha256:string|null;link?:string}[];toolVersions:Record<string,string>;
    sourceBoardSha256:string;candidateBoardSha256:string;candidateBoardInputPath:string;
    requiredChecks:string[];processExit:number;terminalEvent:boolean;warningsAsErrors:boolean}):
  {resultSha256:string;findingsSha256:string;identitySha256:string;nativeSha256:Record<string,string>} {
  const required = new Set(expected.requiredChecks);
  if (typeof expected.board !== 'string' || !ID.test(expected.board) || typeof expected.project !== 'string' || !expected.project || expected.project.length > 4096 ||
      !SHA.test(expected.inputSha256) || !Array.isArray(expected.requiredChecks) || required.size !== expected.requiredChecks.length || required.size < 1 || required.size > 5000 ||
      !expected.requiredChecks.every(x => typeof x === 'string' && ID.test(x)) || expected.processExit !== 0 || expected.terminalEvent !== true || typeof expected.warningsAsErrors !== 'boolean' ||
      !Array.isArray(expected.requiredInputs) || expected.requiredInputs.length < 1 || expected.requiredInputs.length > 100_000 || !obj(expected.toolVersions) || !Object.keys(expected.toolVersions).length ||
      !SHA.test(expected.sourceBoardSha256) || !SHA.test(expected.candidateBoardSha256) || typeof expected.candidateBoardInputPath !== 'string' || !expected.candidateBoardInputPath)
    throw new Error('gate invocation is not a valid completed pass');
  const result=json(input.result), findings=json(input.findings);
  if (!obj(result) || result.exit !== 0 || result.changedDuringRun !== false || !obj(result.provenance) || result.provenance.input_sha256 !== expected.inputSha256 ||
      !obj(result.provenance.tools) || !Object.keys(result.provenance.tools).length || Object.values(result.provenance.tools).some(v => typeof v !== 'string' || !v) || !Array.isArray(result.provenance.inputs) ||
      !Array.isArray(result.preflightErrors) || result.preflightErrors.length || !obj(result.checks) || !sameSet(Object.keys(result.checks),required))
    throw new Error('gate result is incomplete or does not bind the expected inputs');
  const wanted = new Map<string,{sha256:string|null;link?:string}>();
  for (const entry of expected.requiredInputs) {
    if (!entry || typeof entry.path !== 'string' || !entry.path || entry.path.length > 4096 || wanted.has(entry.path) ||
        (entry.sha256 !== null && (typeof entry.sha256 !== 'string' || !SHA.test(entry.sha256))) || (entry.link !== undefined && typeof entry.link !== 'string'))
      throw new Error('invalid independently expected gate input');
    wanted.set(entry.path,{sha256:entry.sha256,...(entry.link === undefined ? {} : {link:entry.link})});
  }
  if (wanted.get(expected.candidateBoardInputPath)?.sha256 !== expected.candidateBoardSha256) throw new Error('candidate board is absent from gate dependencies');
  if (result.provenance.inputs.length !== wanted.size) throw new Error('gate dependency set differs');
  for (const entry of result.provenance.inputs) {
    if (!obj(entry) || typeof entry.path !== 'string' || !wanted.has(entry.path) || !Object.hasOwn(entry,'sha256') ||
        Object.keys(entry).some(key => !['path','sha256','link'].includes(key))) throw new Error('invalid gate dependency');
    const expectedEntry = wanted.get(entry.path)!;
    if (entry.sha256 !== expectedEntry.sha256 || entry.link !== expectedEntry.link || Object.hasOwn(entry,'link') !== Object.hasOwn(expectedEntry,'link')) throw new Error('gate dependency changed');
    wanted.delete(entry.path);
  }
  const actualTools = result.provenance.tools;
  if (wanted.size || Object.keys(actualTools).length !== Object.keys(expected.toolVersions).length ||
      Object.entries(expected.toolVersions).some(([key,value]) => typeof value !== 'string' || !value || actualTools[key] !== value))
    throw new Error('gate dependency or tool versions changed');
  const fingerprint = digest(Buffer.from(JSON.stringify({inputs:result.provenance.inputs,tools:result.provenance.tools})));
  if (fingerprint !== expected.inputSha256) throw new Error('gate provenance fingerprint is invalid');
  const identity = json(input.identity);
  if (!obj(identity) || Object.keys(identity).length !== 4 || identity.schema !== 'pcb.board-identity.v1' || identity.identityPreserved !== true ||
      identity.sourceSha256 !== expected.sourceBoardSha256 || identity.candidateSha256 !== expected.candidateBoardSha256)
    throw new Error('board identity evidence does not match source and candidate');
  for (const [id,check] of Object.entries(result.checks)) {
    if (!obj(check) || check.status !== 'passed' || check.cached !== false || !obj(check.metrics) || !Object.keys(check.metrics).length ||
        Object.values(check.metrics).some(x => !Number.isSafeInteger(x) || (x as number) < 0)) throw new Error(`gate check ${id} is incomplete, cached or not passed`);
    if (id === 'drc' && check.metrics.drc_parity !== 0) throw new Error('schematic parity is not clean');
  }
  if (!obj(findings) || findings.schema_version !== 1 || findings.board !== expected.board || findings.project !== expected.project || findings.input_sha256 !== expected.inputSha256 ||
      findings.inputs_valid !== true || findings.complete !== true || !sameSet(findings.completed_checks,required) || !Array.isArray(findings.findings) ||
      findings.findings.some(row => !obj(row) || typeof row.stage !== 'string' || !required.has(row.stage) || !['warning','info','exclusion'].includes(String(row.severity)) ||
        (expected.warningsAsErrors && row.severity === 'warning')))
    throw new Error('gate findings are incomplete or contain disallowed findings');
  const nativeSha256:Record<string,string>={};
  if (required.has('erc')) {
    if (!input.erc) throw new Error('native ERC report missing');
    const report=json(input.erc);
    if (!obj(report) || !Array.isArray(report.sheets) || !report.sheets.length || report.sheets.some(sheet => !obj(sheet) || !violations(sheet.violations))) throw new Error('native ERC report invalid or has errors');
    nativeSha256.erc=digest(input.erc);
  }
  if (required.has('drc')) {
    if (!input.drc) throw new Error('native DRC report missing');
    const report=json(input.drc);
    if (!obj(report) || !violations(report.violations) || !Array.isArray(report.schematic_parity) || report.schematic_parity.length || !Array.isArray(report.unconnected_items) || report.unconnected_items.length)
      throw new Error('native DRC report invalid or has errors');
    nativeSha256.drc=digest(input.drc);
  }
  return {resultSha256:digest(input.result),findingsSha256:digest(input.findings),identitySha256:digest(input.identity),nativeSha256};
}
