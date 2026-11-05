// tools/pcb cycle: start, status, begin, end, finish, attach. The cycle records observations; the owned runs keep their own evidence.
import { join } from 'node:path';
import { currentAssessment } from './design-contract.ts';
import { loadContract } from './design-contract-load.ts';
import { holdLock } from './file-lock.ts';
import { stockPopulationCurrent } from './part-stock.ts';
import { begin, create, type CycleOptions, end, finish, folderFor, read, type Stage, STAGES, summarize, attach } from './pcb-cycle.ts';
import { runDir, status } from './pcb-runs.ts';
import { jsonDumps } from './py-compat.mjs';
import { resolvePath } from './py-path.ts';
import { SOURCES } from './schematic-contract.ts';

const LOCK_WAIT_S = 30;   // the admission wait of a run attaching to its cycle (pcb-check-start.ts)
const ACTIONS = ['start', 'status', 'begin', 'end', 'finish', 'attach'];
const OUTCOMES = ['passed', 'blocked', 'rework'];

export const CYCLE_OPTIONS = {
  owner: { type: 'string' }, stage: { type: 'string' }, contract: { type: 'string' }, description: { type: 'string' }, activity: { type: 'string' },
  outcome: { type: 'string' }, evidence: { type: 'string', multiple: true }, decision: { type: 'string' }, run: { type: 'string' },
} as const;

type Values = Record<string, unknown>;

const options: CycleOptions = {
  readers: {
    loadContract: (root, path) => loadContract(root, path, SOURCES) as never,
    currentAssessment: report => currentAssessment(report),
    stockPopulationCurrent: report => stockPopulationCurrent(report as never),
    status: folder => JSON.parse(jsonDumps(status(folder))),
  },
  withLock: async (path, work) => {
    const lock = await holdLock(path, { waitS: LOCK_WAIT_S });
    try { return work(); } finally { await lock.release(); }
  },
};

const stageOf = (values: Values): Stage | undefined => {
  const stage = values.stage as string | undefined;
  if (stage !== undefined && !STAGES.includes(stage as Stage)) throw new Error(`--stage must be one of ${STAGES.join(', ')}`);
  return stage as Stage | undefined;
};

export async function cycleCommand(root: string, basePath: string, action: string, subject: string, values: Values): Promise<unknown> {
  if (!ACTIONS.includes(action)) throw new Error(`cycle action must be one of ${ACTIONS.join(', ')}`);
  const base = resolvePath(basePath);
  if (action === 'start') {
    if (!values.owner) throw new Error('cycle start requires --owner for integration ownership');
    return create(root, base, subject, values.owner as string, options, values.contract as string | undefined);
  }
  const folder = folderFor(base, subject);
  if (resolvePath(read(join(folder, 'cycle.json')).root) !== resolvePath(root)) throw new Error('cycle belongs to another checkout');
  if (action === 'begin') return begin(folder, stageOf(values) as Stage, (values.owner as string | undefined) ?? '', (values.description as string | undefined) ?? '', options);
  if (action === 'end') {
    if (values.outcome !== undefined && !OUTCOMES.includes(values.outcome as string)) throw new Error(`--outcome must be one of ${OUTCOMES.join(', ')}`);
    return end(folder, values.activity as string, values.outcome as string, (values.evidence as string[] | undefined) ?? [], (values.decision as string | undefined) ?? '', options);
  }
  if (action === 'finish') return finish(folder, options);
  if (action === 'attach') {
    if (!values.run) throw new Error('cycle attach requires --run RUN_ID');
    await attach(folder, runDir(base, values.run as string), options, stageOf(values));
  }
  return summarize(folder, options);
}
