// Production adapters for the read-only next decision. Owned probes keep their
// inherited deadline and cannot turn unconfirmed child cleanup into evidence.
import { currentAssessment } from './design-contract.ts';
import { now } from './lean-clock.ts';
import { runStage } from './lean-stage.ts';
import { parentCandidate } from './pcb-candidate.ts';
import { type NextReaders } from './pcb-next.ts';
import { status } from './pcb-runs.ts';
import { sourceState } from './pcb-sources.ts';
import { jsonDumps } from './py-compat.mjs';
import type { ObservationReport, RunState } from './pcb-cycle.ts';

export const nextReaders: NextReaders = {
  status: folder => JSON.parse(jsonDumps(status(folder))) as RunState,
  sourceState: (root, board, extra) => sourceState(root, board, extra as string[] | null | undefined),
  parentCandidate: (root, board, reference) => parentCandidate(root, board, reference),
  currentAssessment: (report: ObservationReport) => currentAssessment(report),
  runStage: async (command, options) => {
    const result = await runStage(command, {
      stage: options.stage, env: options.env, deadline: now() + options.timeoutS,
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    return { returncode: result.returncode, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  },
};
