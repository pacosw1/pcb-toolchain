// Evaluate sealed historical routing outcomes. This observer never runs a
// placement or route, and an observation is not acceptance or qualification.
import { projectRoot } from './lib/project-root.mjs';
import { errorText, parseFlags, runMain, UsageError } from './lib/cli.ts';
import { atomicJson } from './lib/json-file.ts';
import { pcbIdentity } from './lib/pcb-identity.ts';
import { jsonDumps } from './lib/py-compat.mjs';
import { thermalServices } from './lib/outcome-thermal.ts';
import { cliObservation as observe, evaluateStudy, REPORT, sourceInputs, terminalSummary, type OutcomeServices } from './lib/placement-outcomes.ts';
import type { Evidence } from './lib/outcome-evidence.ts';
import type { Trial } from './lib/outcome-controls.ts';

export { sourceInputs };
const services: OutcomeServices = { pcbIdentity, thermal: thermalServices() };
export const cliObservation = (evidence: Evidence, trial: Trial) => observe(evidence, trial, services);

const USAGE = 'usage: placement_outcomes.ts evaluate STUDY_ID --manifest FILE [--root DIR] [--output FILE] [--json]';
function main(argv: string[]): number {
  const parsed = parseFlags(argv, { manifest: { type: 'string' }, root: { type: 'string' }, output: { type: 'string' }, json: { type: 'boolean' } }, USAGE);
  const [command, studyId] = parsed.positionals;
  if (parsed.positionals.length !== 2 || command !== 'evaluate' || !studyId || !parsed.values.manifest) throw new UsageError(USAGE);
  let result;
  try { result = evaluateStudy(projectRoot(parsed.values.root), parsed.values.manifest, studyId, services); }
  catch (error) {
    const reason = errorText(error);
    result = { schema: REPORT, study_id: studyId, status: 'blocked', qualified: false, adopt_weights: false, observational_ready: false,
      comparative_readiness: false, blockers: [{ code: 'study_evidence_invalid', detail: reason }], inputs: {},
      next_action: { kind: 'repair_study_evidence', reason, argv: ['tools/pcb', 'outcomes', '--json', 'evaluate', studyId, '--manifest', parsed.values.manifest] } };
  }
  if (parsed.values.output) atomicJson(parsed.values.output, result);
  const shown = parsed.values.output ? terminalSummary(result, parsed.values.output) : result;
  const nextAction = result.next_action as { reason: string };
  console.log(parsed.values.json ? jsonDumps(shown) : `${result.status === 'passed' ? 'PASS' : 'STUCK'}: ${nextAction.reason}`);
  return result.status === 'passed' ? 0 : 1;
}

runMain(import.meta.url, main);
