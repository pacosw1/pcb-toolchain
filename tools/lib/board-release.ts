// The release records of a board against its sealed release runs. It reads them on each call and stores nothing.
// An order holds the hash of the release manifest and no CAD hash. The sealed run with that manifest holds the gate inputs, so the run gives the ordered CAD.
// A run folder is not committed. With no sealed run the compare is `unknown`, and `unknown` never reads as the same CAD.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Evidenced } from './board-machine.ts';
import { readObject, sha256File } from './json-file.ts';
import { verifySettled } from './pcb-evidence.ts';
import { RUN_ID } from './pcb-runs.ts';
import { releaseApprovalStatus, type ReleaseApprovalStatus } from './release-approval.mjs';
import { releaseOrders, type ReleaseOrder } from './release-order.mjs';

export type CadAfterOrder = 'no_order' | 'same' | 'differs' | 'unknown';
export interface ReleaseView {
  approval: { state: ReleaseApprovalStatus['state']; path: string; by: string | null; problems: string[]; stale: string[] };
  orders: ReleaseOrder[]; cad_after_order: CadAfterOrder; problems: string[];
}
interface ReleaseRun { candidate: string; created: string; manifest: string }
interface GateResult { provenance?: { inputs?: { path: string; sha256: string | null }[] } }

/** The sealed release runs of BOARD, oldest first. A run that fails its seal proves nothing, so it is not in the list. */
function sealedReleases(base: string, board: string): ReleaseRun[] {
  if (!existsSync(base)) return [];
  return readdirSync(base).filter(name => RUN_ID.test(name)).flatMap(id => {
    const folder = join(base, id), candidate = join(folder, 'candidate');
    try {
      const run = readObject<Record<string, unknown>>(join(folder, 'run.json'));
      if (run.board !== board || run.operation !== 'release') return [];
      verifySettled(folder);
      return [{ candidate, created: String(run.created_at), manifest: sha256File(join(candidate, 'release-manifest.json')) }];
    } catch { return []; }
  }).sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
}

function cadAfterOrder(root: string, board: string, run: ReleaseRun | undefined): CadAfterOrder {
  if (!run) return 'unknown';
  let result: GateResult;
  try { result = readObject<GateResult>(join(run.candidate, 'gate/result.json')); } catch { return 'unknown'; }
  const rows = (result.provenance?.inputs ?? []).filter(row => row.path.startsWith(`hardware-design/boards/${board}/`) && /\.kicad_(pcb|sch|dru)$/.test(row.path));
  if (!rows.length) return 'unknown';
  const hash = (path: string): string | null => existsSync(path) ? sha256File(path) : null;
  return rows.every(row => hash(join(root, row.path)) === row.sha256) ? 'same' : 'differs';
}

export function releaseView(root: string, board: string, base: string): ReleaseView {
  const runs = sealedReleases(base, board), problems: string[] = [];
  let orders: ReleaseOrder[] = [];
  try { orders = releaseOrders(root, board); } catch (error) { problems.push((error as Error).message); }
  // The newest sealed release is the candidate, so a newer release makes the approval stale. `base` holds no manifest, so no run reads as stale.
  const status = releaseApprovalStatus(root, board, runs.at(-1)?.candidate ?? base), last = orders.at(-1);
  const cad = problems.length ? 'unknown' : last ? cadAfterOrder(root, board, runs.find(run => run.manifest === last.candidate_sha256)) : 'no_order';
  return { approval: { state: status.state, path: status.path, by: status.approval?.by ?? null, problems: status.problems, stale: status.stale }, orders, cad_after_order: cad, problems };
}

const APPROVAL = { approved: 'current', stale: 'stale', invalid: 'unknown' } as const;
const ORDER = { same: 'current', differs: 'stale', unknown: 'unknown' } as const;

/** The classes that a release record proves. A missing record proves nothing, so it does not move the position. */
export function releaseEvidence({ approval: { state }, cad_after_order: cad }: ReleaseView): Evidenced {
  if (cad !== 'no_order') return { order: ORDER[cad] };   // an approval that goes stale after the order never opens the ordered CAD again
  return state === 'missing' ? {} : { release_approval: APPROVAL[state] };
}

export function releaseText({ approval, orders, cad_after_order: cad, problems }: ReleaseView): string[] {
  const reference = orders.at(-1)?.reference;
  return [
    ...(approval.state === 'missing' ? [] : [`Release approval: ${approval.state}${approval.by ? ` by ${approval.by}` : ''}`]),
    ...[...approval.problems, ...approval.stale, ...problems].map(line => `  ${line}`),
    ...(cad === 'no_order' ? [] : [`Orders: ${orders.length}${reference ? `, last ${reference}` : ''}; CAD after the order: ${cad}`]),
  ];
}
