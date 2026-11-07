// A route that would repeat a stuck one. When the latest route of a board ended stuck (operation/stuck.json), a new route needs
// either a recorded route decision for that run (an accepted move, tools/ROUTE-DECISIONS.md) or inputs that differ from that run's.
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readObject } from './json-file.ts';
import { isFile, resolvePath } from './py-path.ts';
import { MOVE_SCHEMA, moveArgs } from './route-moves.ts';
import { STUCK_FILE } from './route-stuck.ts';

interface RunRecord { root?: string; board?: string; operation?: string; created_at?: string; action?: { source_revision?: string; parameters_sha256?: string } }
interface MoveRecord { schema?: string; status?: string; evidence_sha256?: Record<string, string> }
/** The admitted action of the new route: its source revision and the fingerprint of its parameters. */
export interface RouteInputs { source_revision: string; parameters_sha256: string }

function runs(base: string): { folder: string; manifest: RunRecord }[] {
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory() && isFile(join(base, entry.name, 'run.json')))
    .map(entry => ({ folder: join(base, entry.name), manifest: readObject<RunRecord>(join(base, entry.name, 'run.json')) }));
}

/** Throws when the latest route of `board` in `base` ended stuck, no accepted move names its report, and `now` does not differ from its inputs. */
export function assertRouteNotRepeated(base: string, root: string, board: string, now: RouteInputs | undefined): void {
  const all = runs(base), mine = (operation: string) => all.filter(({ manifest }) => manifest.operation === operation && manifest.board === board && resolvePath(manifest.root ?? '') === resolvePath(root));
  const latest = mine('route').sort((a, b) => String(b.manifest.created_at).localeCompare(String(a.manifest.created_at)) || (a.folder < b.folder ? 1 : -1))[0];
  if (!latest) return;
  const evidence = join(latest.folder, STUCK_FILE);
  if (!isFile(evidence)) return;
  const decided = mine('routing').some(({ folder }) => {
    const path = join(folder, 'operation/report.json');
    if (!isFile(path)) return false;
    const report = readObject<MoveRecord>(path);
    return report.schema === MOVE_SCHEMA && report.status === 'accepted' && Object.keys(report.evidence_sha256 ?? {}).some(key => resolvePath(key) === resolvePath(evidence));
  });
  const before = latest.manifest.action;
  if (decided || (before && now && (before.source_revision !== now.source_revision || before.parameters_sha256 !== now.parameters_sha256))) return;
  const record = `tools/pcb ${moveArgs(board, evidence, { kind: 'reroute_stuck' }).map(arg => /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg}'`).join(' ')}`;
  throw new Error(`route stopped: the latest route of ${board}, ${basename(latest.folder)}, ended stuck. No route decision is recorded for it and the inputs are not shown to differ. `
    + `Read ${evidence}, then record a decision: ${record}`);
}
