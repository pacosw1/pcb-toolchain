// The loop reuses the ordinary candidate admission, receipt, move and cleanup contracts.
import { existsSync, readdirSync } from 'node:fs';
import { basename, join, resolve, relative, isAbsolute } from 'node:path';
import { startCheck } from './pcb-check-start.ts';
import { sourceState } from './pcb-sources.ts';
import { routePolicyArgs } from './pcb-workflow.ts';
import { holdLock } from './file-lock.ts';
import { atomicJson, plainJson, readObject, sha256File } from './json-file.ts';
import { requestCancel, status, RUN_ID } from './pcb-runs.ts';
import { verify, verifySettled } from './pcb-evidence.ts';
import { parentCandidate } from './pcb-candidate.ts';
import { movedPolicy, validateMove, NOTHING_REVIEWED } from './route-moves.ts';
import type { Move } from './route-moves.ts';
import { Evidence } from './outcome-evidence.ts';
import { routedQuality } from './outcome-quality.ts';
import { now as steadyClock } from './lean-clock.ts';
import { loopFolder, loopHash } from './route-loop.ts';
import type { Fields, LoopBackend, LoopChild, LoopEvidence, LoopRound, LoopState } from './route-loop.ts';
import type { StuckReport } from './route-stuck.ts';
import { pcbIdentity } from './pcb-identity.ts';
import { footprints } from './native-board.ts';

export const loopRunsBase = (root: string) => resolve(process.env.PCB_RUNS_DIR ?? join(root, '.gate', 'cli'));
const context = (s: LoopState, r: LoopRound) => ({
  id: s.id,
  round: r.round,
  launch_id: r.launch_id,
  source_sha256: s.source_sha256,
  deadline_ms: s.deadline_ms
});
function childManifest(s: LoopState, c: LoopChild): Fields {
  if (!RUN_ID.test(c.id) || resolve(c.folder) !== join(loopRunsBase(s.root), c.id))
    throw Error('Loop child is outside its admitted run store.');
  const m = readObject<Fields>(join(c.folder, 'run.json'));
  const r = s.rounds.find((r) => r.child?.id === c.id);
  if (!r || m.root !== s.root || m.board !== s.board || loopHash(m.loop_context) !== loopHash(context(s, r)))
    throw Error('Child run does not belong to this loop revision.');
  return m;
}
function searchEvidence(
  folder: string,
  native: string,
  hashes: Record<string, string>,
  board: string
): { candidate: string; report: Fields; path: string } | null {
  const options: { candidate: string; report: Fields; path: string }[] = [];
  const summary = hashes['operation/router-summary.json']
    ? readObject<Fields>(join(folder, 'operation/router-summary.json'))
    : null;
  const pose = (path: string) =>
    footprints(path)
      .map((f) => [f.props.get('Reference'), f.pose.map((n) => n.normalize().toString())])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  for (const key of Object.keys(hashes).filter(
    (k) => k === 'operation/stuck.json' || (k.startsWith('operation/router/') && k.endsWith('/stuck.json'))
  )) {
    const path = join(folder, key),
      report = readObject<Fields>(path);
    if (
      report.schema !== 'iot-lab.stuck-report.v1' ||
      report.board !== board ||
      !['parity', 'drc_errors', 'unconnected'].every((k) => Number.isSafeInteger(report[k]) && Number(report[k]) >= 0)
    )
      continue;
    const candidate =
      key === 'operation/stuck.json'
        ? typeof summary?.board_file === 'string'
          ? resolve(summary.board_file)
          : native
        : path.slice(0, -'/stuck.json'.length).replace(/\.iotroute$/, '');
    const rel = relative(folder, candidate);
    if (rel.startsWith('..') || isAbsolute(rel) || !hashes[rel] || !existsSync(candidate)) continue;
    if (
      loopHash(pcbIdentity(candidate)) !== loopHash(pcbIdentity(native)) ||
      loopHash(pose(candidate)) !== loopHash(pose(native))
    )
      continue;
    options.push({ candidate, report, path });
  }
  options.sort(
    (a, b) =>
      Number(a.report.parity) - Number(b.report.parity) ||
      Number(a.report.drc_errors) - Number(b.report.drc_errors) ||
      Number(a.report.unconnected) - Number(b.report.unconnected) ||
      a.path.localeCompare(b.path)
  );
  return options[0] ?? null;
}
export function defaultLoopBackend(): LoopBackend {
  return {
    clock: () => steadyClock() * 1000,
    source: (root, board) => sourceState(root, board).sha256,
    validatePolicy: (p) => {
      routePolicyArgs(p, 'loop-candidate');
    },
    lock: async (path, work) => {
      const held = await holdLock(path, { waitS: 5 });
      try {
        return await work();
      } finally {
        await held.release();
      }
    },
    async start(s, r, timeout) {
      const spec = join(loopFolder(s.root, s.id), `round-${r.round}-policy.json`);
      atomicJson(spec, r.policy);
      const folder = await startCheck({
        root: s.root,
        base: loopRunsBase(s.root),
        board: s.board,
        operation: 'route',
        router: 'iotroute',
        spec,
        timeout,
        heartbeat: 2,
        ...(r.from ? { fromRun: r.from.id } : {}),
        loopContext: context(s, r)
      });
      return { id: basename(folder), folder };
    },
    recover(s, r) {
      const base = loopRunsBase(s.root);
      if (!existsSync(base)) return null;
      const found: LoopChild[] = [];
      for (const id of readdirSync(base).filter((id) => RUN_ID.test(id))) {
        try {
          const m = readObject<Fields>(join(base, id, 'run.json'));
          if (m.root === s.root && m.board === s.board && loopHash(m.loop_context) === loopHash(context(s, r)))
            found.push({ id, folder: join(base, id) });
        } catch {
          /* unrelated/incomplete run */
        }
      }
      if (found.length > 1) throw Error('Multiple runs share one loop launch. Stop and inspect their ownership.');
      return found[0] ?? null;
    },
    inspect(s, c): LoopEvidence {
      childManifest(s, c);
      const current = plainJson(status(c.folder)) as Fields;
      if (!['passed', 'failed', 'error', 'cancelled', 'timeout'].includes(String(current.status)))
        return { state: String(current.status), cleanup: false };
      let terminal: Fields;
      try {
        terminal = plainJson(verifySettled(c.folder)) as Fields;
      } catch {
        return { state: String(current.status), cleanup: false, cause: 'The child has no verifiable settled receipt.' };
      }
      const receipt = join(c.folder, 'result.json'),
        hashes = terminal.evidence_sha256 as Record<string, string>;
      const evidence: LoopEvidence = {
        state: String(terminal.status),
        cleanup: true,
        receipt_sha256: sha256File(receipt),
        cause: String(terminal.cause ?? 'Round ended.'),
        cpu_s: null
      };
      if (!['passed', 'failed'].includes(String(terminal.status))) return evidence;
      let candidate: string;
      try {
        candidate = parentCandidate(s.root, s.board, {
          folder: c.folder,
          result_sha256: evidence.receipt_sha256!
        }).candidate;
      } catch (e) {
        return {
          ...evidence,
          state: 'error',
          cause: `Candidate source/identity verification failed: ${e instanceof Error ? e.message : String(e)}`
        };
      }
      evidence.candidate = candidate;
      evidence.identity_preserved = terminal.identity_preserved === true;
      evidence.verified =
        terminal.status === 'passed' && terminal.candidate_verified === true && evidence.identity_preserved;
      const search = searchEvidence(c.folder, candidate, hashes, s.board);
      if (search) {
        evidence.search_candidate = search.candidate;
        evidence.report = search.report;
        evidence.report_path = search.path;
        evidence.report_sha256 = sha256File(search.path);
      }
      const saved = Object.keys(hashes).find((k) => {
        const variant = search?.candidate.match(/^(.*\/portfolio\/v\d{2}\/)/)?.[1];
        if (!variant || !/(^|\/)state\.json$/.test(k) || !join(c.folder, k).startsWith(variant)) return false;
        try {
          const v = readObject<Fields>(join(c.folder, k));
          return v.terminal !== true && (v.payload as Fields | undefined)?.schema === 'iot-lab.route-resume.v1';
        } catch {
          return false;
        }
      });
      if (saved) evidence.checkpoint = { path: join(c.folder, saved), sha256: hashes[saved]!, resumable: true };
      const quality = routedQuality(
        new Evidence(s.root),
        evidence.verified ? candidate : (search?.candidate ?? candidate)
      );
      if (typeof quality.routed_track_length_mm === 'number') evidence.wire_mm = quality.routed_track_length_mm;
      if (typeof quality.routed_via_count === 'number') evidence.vias = quality.routed_via_count;
      if (quality.unknowns) evidence.quality_unknown = quality.unknowns as Fields;
      return evidence;
    },
    cancel: (c) => {
      requestCancel(c.folder);
    },
    async propose(s, r, raw) {
      if (!r.child || !r.evidence) return { status: 'rejected', cause: 'No retained round evidence.' };
      childManifest(s, r.child);
      verify(r.child.folder);
      if (['move_part', 'move_cluster', 'swap_pins'].includes(String(raw.kind)))
        return {
          status: 'proposal',
          cause:
            'Placement and pin changes require an explicit reviewed edit action. The routing loop stopped without changing them.'
        };
      const switchToSingle = raw.kind === 'single_reuse';
      if (switchToSingle && (Object.keys(raw).some((k) => k !== 'kind') || !r.policy.sprints))
        return { status: 'rejected', cause: 'Single-run reuse requires a retained sprint round and no extra fields.' };
      const move = (switchToSingle ? { kind: 'reroute_stuck' } : raw) as Move,
        output = join(loopFolder(s.root, s.id), 'decisions', String(s.decisions.length), 'report.json');
      const evidenceFile = r.evidence.report_path ?? join(r.child.folder, 'operation/stuck.json');
      const reportRel = relative(r.child.folder, evidenceFile),
        terminal = plainJson(verify(r.child.folder)) as Fields,
        hashes = terminal.evidence_sha256 as Record<string, string>;
      if (r.evidence.report && (reportRel.startsWith('..') || isAbsolute(reportRel) || !hashes[reportRel]))
        throw Error('Stuck report leaves its sealed child evidence.');
      if (r.evidence.report && sha256File(evidenceFile) !== r.evidence.report_sha256)
        throw Error('Stuck evidence changed after the decision boundary.');
      if (!r.evidence.report && (!r.evidence.verified || move.kind !== 'change_setting'))
        return { status: 'rejected', cause: 'This round has no bound stuck report for that move.' };
      const report = (r.evidence.report ?? {
        route_layers: Array.isArray(s.policy.route.layers) ? s.policy.route.layers : []
      }) as unknown as StuckReport;
      const reasons = validateMove(move, {
        report,
        reviewed: NOTHING_REVIEWED,
        parts: new Map(),
        bounds: { left: 0, top: 0, right: 0, bottom: 0 }
      });
      if (reasons.length) return { status: 'rejected', cause: reasons.join('; ') };
      let previous = r.evidence.search_candidate ?? r.evidence.candidate!;
      const useSeed =
        move.kind === 'reroute_stuck' ||
        move.kind === 'widen_region' ||
        (!r.evidence.verified && move.kind === 'change_setting');
      if (useSeed) {
        const path = resolve(previous),
          rel = relative(r.child.folder, path);
        if (!path || rel.startsWith('..') || isAbsolute(rel) || !hashes[rel] || sha256File(path) !== hashes[rel])
          return { status: 'rejected', cause: 'The retained routing seed is missing or differs from the candidate.' };
        for (const name of ['result.json', 'route.json']) {
          const seed = relative(r.child.folder, path + '.iotroute/' + name);
          if (!hashes[seed] || !existsSync(join(r.child.folder, seed)))
            return {
              status: 'rejected',
              cause: 'The retained route has no bound partial-reuse work. Choose a bounded setting change or stop.'
            };
        }
        previous = path;
      }
      let policy = movedPolicy(r.policy, move, previous);
      if (useSeed && move.kind === 'change_setting') policy = { ...policy, reuse: previous };
      if (policy.sprints && policy.reuse) {
        if (!switchToSingle)
          return {
            status: 'rejected',
            cause: 'Packed sprints do not support partial reuse. Choose single_reuse explicitly, or stop.'
          };
        const resources = r.policy.sprints as Fields;
        if (Number(resources.parallelism ?? 2) < 2 || Number(resources.mem_gb ?? 4) < 4)
          return {
            status: 'rejected',
            cause: 'Ordinary reuse needs the existing two-CPU/four-GiB reservation; this loop admitted less.'
          };
        const { sprints: _sprints, ...single } = policy;
        policy = { ...single, max_time_s: Number(resources.deadline_s ?? 120) };
      }
      atomicJson(output, {
        schema: 'iot-lab.route-loop-move.v1',
        status: 'accepted',
        qualified: false,
        move,
        source_sha256: s.source_sha256,
        evidence_sha256: r.evidence.receipt_sha256,
        policy
      });
      return { status: 'accepted', policy };
    }
  };
}
