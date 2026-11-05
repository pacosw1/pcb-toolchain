// The engineering screens around a candidate: the previous design stage before any spending, and reviewed placement, block
// and test access rules on the candidate itself. Each writes its report next to the operation's other evidence.
import { dirname, join } from 'node:path';
import { evaluateCandidateLayout, evaluateContract } from './design-contract-async.ts';
import type { Report } from './design-contract-verifiers-async.ts';
import { designServices } from './design-services.ts';
import { checkManifest, reviewedContract, type ReviewServices } from './engineering-constraints.ts';
import { prerequisiteStage, type AdmittedAction } from './pcb-action.ts';
export { routesCopper } from './pcb-action.ts';
import { atomicJson, readObject, sha256File } from './json-file.ts';
import { verifyManifest } from './part-review.ts';
import { type Emit, measuredStage, type Row } from './pcb-operation-log.ts';
import { boardConfig } from './pcb-workflow.ts';
import { jsonDumps } from './py-compat.mjs';
import { isFile, isRelativeTo, resolvePath, withSuffix } from './py-path.ts';
import { EscapeStageReceipts, verifyEscapeEvidence } from './route-decision-escape.ts';
import type { Dict } from './py-values.ts';

const plain = (value: unknown): Row => JSON.parse(jsonDumps(value)) as Row;

export interface Binding { path: string; sha256: string; content?: Row }
export interface OperationManifest extends Row {
  root: string; board: string; operation: string; node: string; timeout_s: number; kind?: string; router?: string; spec?: Row;
  action?: AdmittedAction; design_contract?: Binding; engineering_manifest?: Binding; plan?: Binding; from_run?: { folder: string; result_sha256: string };
}

const review: ReviewServices = {
  verifyManifest: (root, board, path) => plain(verifyManifest(root, board, path)) as Dict,
  verifyEscapeEvidence: (contract, candidate, evidence) => verifyEscapeEvidence(plain(contract) as never, candidate, evidence) as unknown as Dict[],
};

/** The rules of the board's verified part review; none when it has no review. A review that does not verify stops here. */
export function reviewedRules(root: string, board: string): unknown[] {
  const manifest = join(root, 'hardware-design/registry/part-reviews', `${board}.json`);
  return isFile(manifest) ? reviewedContract(root, board, manifest, review).rules : [];
}

/** The previous stage must hold before a candidate costs anything. The fresh gate still judges the changed layout. */
export async function designAdmission(root: string, folder: string, manifest: OperationManifest, emit: Emit): Promise<Report | null> {
  const binding = manifest.design_contract;
  if (!binding) return null;
  const path = resolvePath(binding.path);
  if (!isRelativeTo(path, root) || sha256File(path) !== binding.sha256) throw new Error('design contract changed or escaped its checkout after admission');
  const declared = readObject<{ identity?: Row }>(path).identity ?? {};
  if (declared.board !== manifest.board) throw new Error('candidate design contract must name this exact native board');
  const through = prerequisiteStage(manifest), output = join(folder, 'operation/design-preflight.json');
  const report = await measuredStage(emit, 'design-prerequisites', 'operation', () => evaluateContract(root, path, through, designServices(root, dirname(output))));
  atomicJson(output, report);
  if (report.status !== 'passed') {
    const first = (report.blockers as Row[])[0] ?? {};
    atomicJson(join(folder, 'operation/result.json'), { status: 'failed', exit_code: 1, scope: 'design_preflight', operation: manifest.operation,
      cause: first.detail ?? 'design prerequisites are incomplete or stale', candidate_verified: false, qualified: false, release_approved: false,
      report: output, design_stage: through });
  }
  return report;
}

export function placementCheck(root: string, board: string, manifest: string, candidate: string, output: string, screens: EscapeStageReceipts): Row {
  const contract = reviewedContract(root, board, manifest, review);
  const screened = contract.rules.some(rule => rule.kind === 'escape');
  const evidence = screened ? screens.get(plain(contract) as never, candidate, output.replace(/\.json$/, '-escape.json')) : null;
  const report = plain(checkManifest(root, board, manifest, review, { candidate, escapeEvidence: evidence }));
  if (evidence) {
    report.escape_evidence = evidence;
    report.inputs = { ...report.inputs as Row, ...readObject<{ inputs?: Row }>(evidence).inputs, [evidence]: sha256File(evidence) };
    report.escape_screens = { generated: screens.generated, reused: screens.hits };
  }
  atomicJson(output, report);
  return report;
}

/** Reviewed fixed and rigid poses belong to the original source: rebuilding them from the edited workspace compares a pose to itself. */
export async function candidateLayoutCheck(root: string, workspace: string, manifest: OperationManifest, output: string, emit: Emit, screens: EscapeStageReceipts): Promise<Row> {
  const candidate = withSuffix(boardConfig(workspace, manifest.board).project, '.kicad_pcb'), stage = output.split('/').at(-1)!.replace(/\.json$/, '');
  const report = await measuredStage(emit, stage, 'operation', () => evaluateCandidateLayout(root, manifest.design_contract!.path, designServices(root, dirname(output)),
    { candidate, evidenceDirectory: output.replace(/\.json$/, '-evidence'), escapeScreens: screens as never }));
  atomicJson(output, report);
  return report as unknown as Row;
}
