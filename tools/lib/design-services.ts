// Production design verifiers. Every child command is admitted under the inherited owned-stage deadline.
import { join } from 'node:path';
import { deadlineAfter } from './lean-workflow.ts';
import { runStage } from './lean-stage.ts';
import { checkContract, SOURCES } from './schematic-contract.ts';
import { verifyManifest, verifySelection } from './part-review.ts';
import { readBoard } from './part-native.ts';
import { checkManifest, reviewedContract } from './engineering-constraints.ts';
import { verifyEscapeEvidence } from './route-decision-escape.ts';
import { nativeInputs } from './route-decision-evidence.ts';
import { requiredGateEvidence, verifyCurrentInputs } from './pcb-next.ts';
import { jsonDumps } from './py-compat.mjs';
import type { DesignServices } from './design-contract-verifiers-async.ts';
import type { Dict } from './py-values.ts';

const plain = (value: unknown): Dict => JSON.parse(jsonDumps(value)) as Dict;
export function designServices(root: string, output: string): DesignServices {
  let sequence = 0;
  const owned = async (command: string[], options: { stage: string; timeoutSeconds: number; env: NodeJS.ProcessEnv }) => {
    const result = await runStage(command, { stage: options.stage, cwd: root, env: options.env,
      deadline: deadlineAfter(options.timeoutSeconds), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    return { returncode: result.returncode, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  const review = { verifyManifest: (r: string, b: string, p: string) => plain(verifyManifest(r, b, p)),
    verifyEscapeEvidence: (contract: never, candidate: string, evidence: string) => verifyEscapeEvidence(contract, candidate, evidence) };
  return { ...SOURCES,
    verifyManifest: (r, b, p) => plain(verifyManifest(r, b, p)),
    verifySelection: (r, b, p) => plain(verifySelection(r, b, p)),
    checkSchematic: async (r, b, p) => plain(await checkContract(r, b, p, join(output, `schematic-${sequence++}.json`))),
    checkPlacement: (r, b, p, options) => plain(checkManifest(r, b, p, review as never, options)),
    reviewedContract: (r, b, p) => plain(reviewedContract(r, b, p, review as never)),
    nativeInputs: (r, b) => nativeInputs(r, b).sources,
    generateEscapeEvidence: () => { throw new Error('candidate escape generation is outside a design observation'); },
    requiredGateEvidence: (run, gate, result) => plain(requiredGateEvidence(run, gate, plain(result) as never)),
    verifyCurrentInputs: async (r, b, gate) => { await verifyCurrentInputs(r, b, gate,
      (command, opts) => owned(command, { stage: opts.stage, timeoutSeconds: opts.timeoutS, env: opts.env })); },
    readBoard: (r, b) => readBoard(r, b) as unknown as Dict,
    runStage: owned,
  };
}
