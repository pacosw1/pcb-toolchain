// Source-bound routing diagnosis and one guarded repair in an isolated workspace.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardJson } from './board-json.ts';
import { BoardEdit, saveBoard, quoted } from './board-edit.ts';
import type { SaveReport } from './board-edit.ts';
import type { Board } from './board-types.ts';
import { atomicJson, sha256File } from './json-file.ts';
import { fingerprint } from './fingerprint.ts';
import { sourcesSha } from './iotroute-bin.ts';
import { resolvePath, withSuffix } from './py-path.ts';
import { bridgeUuid, mm, prepareShift, protectedGeometry, selectGap, selectVia, verifyCopperScope } from './route-decision-board.ts';
import type { Choice, RejectedGap } from './route-decision-board.ts';
import { checkReport, classify, implementations, inside, loadEvidence, nativeInputs, read, same, sourceInputs } from './route-decision-evidence.ts';
import type { Diagnostics, DrcReport, Finding, Hashes } from './route-decision-evidence.ts';
export * from './route-decision-evidence.ts';
export * from './route-decision-board.ts';
export * from './route-decision-escape.ts';
export const SCHEMA = 'iot-lab.route-decision.v1';
export interface DecisionServices { board(path: string): Board; save(pcb: string, text: string, outDir: string): SaveReport }
export const decisionServices: DecisionServices = {
  board(path) {
    const document = boardJson(path);
    if (document.board_sha256 !== sha256File(path)) throw new Error('board JSON does not bind the exact native source');
    for (const [ext, expected] of [['.kicad_pro', document.project_sha256], ['.kicad_dru', document.rules_sha256]]) {
      const file = withSuffix(path, ext!);
      if ((existsSync(file) ? sha256File(file) : '') !== expected) throw new Error('board JSON native sidecars changed');
    }
    return document.board;
  }, save: saveBoard,
};
export interface Decision {
  schema: string; status: string; qualified: boolean; root: string; board: string; native_project: string;
  source_inputs: Hashes; native_inputs: Hashes; inputs: Hashes; implementation_sha256: Hashes; evidence: string; evidence_sha256: Hashes;
  findings: Finding[]; action: string; choice: Choice | null; scope: { refs: string[]; nets: string[]; copper_policy: string };
  rejected_gap_patterns: RejectedGap[]; attempt_policy: { max_proposals: number; retry_unchanged_inputs: boolean }; plan_path: string | null;
  next_action: { kind: string; argv: string[]; cwd: string }; required_checks: string[]; acceptance: string; tools_and_external_libraries: string;
  plan_sha256?: string;
}
export function diagnoseEvidence(root: string, board: string, evidence: string, planPath?: string | null, services = decisionServices): Decision {
  root = resolvePath(root); evidence = resolvePath(evidence);
  const { cfg, native, sources } = nativeInputs(root, board), implementation = implementations(root);
  const { diagnostics, report, artifacts } = loadEvidence(root, board, evidence), findings = classify(report, diagnostics), kinds = new Set(findings.map(row => row.classification));
  let action = 'inspect_diagnostics', choice: Choice | null = null, rejected: RejectedGap[] = [];
  if (kinds.has('schematic_parity')) action = 'resolve_schematic_parity';
  else if (kinds.has('constraints_unknown')) action = 'resolve_constraint_coverage';
  else if (kinds.has('native_geometry')) { choice = selectVia(services.board(native), report); action = choice ? 'apply_local_repair' : 'inspect_native_geometry'; }
  else if (kinds.has('native_open')) {
    ({ choice, rejected } = selectGap(services.board(native), report));
    action = choice ? 'apply_local_repair' : kinds.has('escape_failure') || kinds.has('model_enclosed') ? 'inspect_escape' : 'diagnose_selected_connections';
  } else if (kinds.has('no_routing_defect')) action = 'run_remaining_configured_gates';
  const refs = [...new Set(findings.flatMap(row => row.refs))].sort(), nets = [...new Set(findings.flatMap(row => row.nets))].sort();
  planPath = planPath ? resolvePath(planPath) : null;
  const nextArgv = choice && planPath ? ['tools/pcb', 'repair', board, '--plan', planPath, '--follow']
    : ['tools/pcb', 'routing', '--json', 'diagnose', board, '--evidence', evidence];
  const plan: Decision = { schema: SCHEMA, status: choice ? 'repairable' : 'decision', qualified: false, root, board,
    native_project: relative(root, native), source_inputs: sources, native_inputs: sources, inputs: { ...sources, ...artifacts }, implementation_sha256: implementation,
    evidence, evidence_sha256: artifacts, findings, action, choice, scope: { refs, nets: choice ? [choice.net] : nets, copper_policy: 'preserve all original tracks; only one explicitly selected via may move' },
    rejected_gap_patterns: rejected, attempt_policy: { max_proposals: 1, retry_unchanged_inputs: false }, plan_path: planPath,
    next_action: { kind: choice && planPath ? 'local_repair' : action, argv: nextArgv, cwd: root }, required_checks: Object.entries(cfg.checks ?? {}).filter(([, on]) => on).map(([key]) => key).sort(),
    acceptance: 'fresh native ERC/DRC/refill/parity plus every configured and board-specific gate; explicit adoption',
    tools_and_external_libraries: 'fresh configured gate required; diagnosis does not certify runtime freshness' };
  if (!same(sources, nativeInputs(root, board).sources) || !same(implementation, implementations(root)) || Object.entries(artifacts).some(([p, h]) => sha256File(p) !== h)) throw new Error('source or diagnostic evidence changed during diagnosis');
  plan.plan_sha256 = fingerprint(plan); return plan;
}
export function planDependencies(plan: Decision | string): Hashes { return { ...(typeof plan === 'string' ? read<Decision>(plan) : plan).evidence_sha256 }; }
function directField(text: string, name: string): { start: number; end: number; text: string } {
  // This reads only the field being transported/replaced in an edit, never geometry.
  let depth = 0, start = -1, quoted = false, escaped = false;
  const found: { start: number; end: number; text: string }[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; continue; }
    if (c === '(') { if (depth === 1) start = i; depth++; }
    if (c === ')') { depth--; if (depth === 1 && start >= 0) { const part = text.slice(start, i + 1); if (new RegExp(`^\\(\\s*${name}(?:\\s|\\))`).test(part)) found.push({ start, end: i + 1, text: part }); start = -1; } }
  }
  if (depth || quoted || found.length !== 1) throw new Error('ambiguous native edit field: ' + name);
  return found[0]!;
}
export function applyPlan(root: string, board: string, value: Decision | string, output: string, services = decisionServices): Record<string, unknown> {
  root = resolvePath(root); output = resolvePath(output);
  const plan = typeof value === 'string' ? read<Decision>(value) : value, { plan_sha256: seal, ...body } = plan;
  if (plan.schema !== SCHEMA || plan.board !== board || fingerprint(body) !== seal) throw new Error('invalid or edited routing decision');
  const origin = resolvePath(plan.root);
  if (root === origin) throw new Error('repair requires an isolated candidate workspace, never the original checkout');
  if (existsSync(output) || [root, origin].some(base => ['hardware-design', 'tools'].some(name => inside(output, join(base, name))))) throw new Error('repair evidence must be new and outside original/candidate CAD');
  if (!same(nativeInputs(root, board).sources, plan.source_inputs) || !same(implementations(root), plan.implementation_sha256)) throw new Error('candidate source or repair implementation changed since diagnosis');
  const current = diagnoseEvidence(origin, board, plan.evidence, plan.plan_path, services);
  if (!same(current, plan) || plan.status !== 'repairable' || !plan.choice) throw new Error('routing decision is stale, unsupported or does not justify a local repair');
  const { native } = nativeInputs(root, board), before = sourceInputs(native), original = readFileSync(native), source = services.board(native), choice = plan.choice;
  const edit = new BoardEdit(original.toString('utf8')); let addedId: string, a: string[], b: string[], width: string, layer: string, sourceId: string, omit: string[];
  if (choice.strategy === 'via_shift_bridge') {
    const shift = prepareShift(source, choice.via_id, choice.along_trace_id, choice.fraction);
    if (!same(shift.destination.map(mm), choice.destination_mm)) throw new Error('via moved outside diagnosed destination');
    a = shift.origin.map(mm); b = shift.destination.map(mm); width = mm(shift.other.width); layer = shift.other.layer; sourceId = shift.other.id; omit = [choice.via_id];
    addedId = bridgeUuid(fingerprint({ sources: before, via: choice.via_id, along: choice.along_trace_id, destination: b }));
    const text = edit.textOf(choice.via_id), at = directField(text, 'at'); edit.replace(choice.via_id, text.slice(0, at.start) + `(at ${b.join(' ')})` + text.slice(at.end));
  } else {
    const selected = selectGap(source, loadEvidence(origin, board, plan.evidence).report).choice;
    if (!same(selected, choice)) throw new Error('native endpoint pattern or protected-copper crossing screen changed');
    addedId = bridgeUuid(seal!); [a, b] = choice.points_mm; width = choice.width_mm; layer = choice.layer; sourceId = choice.endpoint_ids[0]; omit = [];
  }
  if (source.copper.some(item => ('Track' in item ? item.Track.id : item.Via.id) === addedId)) throw new Error('same local repair was already applied');
  const net = directField(edit.textOf(sourceId), 'net').text;
  edit.add(`\n(segment (start ${a.join(' ')}) (end ${b.join(' ')}) (width ${width}) (layer ${quoted(layer)}) ${net} (uuid ${quoted(addedId)}))\n`);
  mkdirSync(output, { recursive: true });
  // One KiCad 10 DRC/refill/parity save of the text in a copy. The source is never a native save target.
  const saved = services.save(native, edit.text(), join(output, 'proposal')), candidate = services.board(saved.board);
  verifyCopperScope(source, candidate, choice, addedId);
  const protectedHash = protectedGeometry(source, omit);
  if (protectedHash !== protectedGeometry(candidate, [...omit, addedId]) || !same(sourceInputs(native), before) || !readFileSync(native).equals(original)) throw new Error('local repair changed protected geometry or source concurrently');
  const guard = { schema: 'iot-lab.local-routing-guard.v1', status: 'proposed', qualified: false, board, plan_sha256: seal,
    strategy: choice.strategy, source_inputs: before, protected_geometry_sha256: protectedHash, allowed_original_edits: omit,
    added_items: [addedId], candidate_sha256: sha256File(saved.board), candidate: native, full_configured_gates_required: true };
  atomicJson(join(output, 'guard.json'), guard);
  const temporary = join(dirname(native), `.route-repair-${process.pid}`);
  try {
    copyFileSync(saved.board, temporary);
    if (!readFileSync(native).equals(original)) throw new Error('candidate source changed before atomic local repair');
    renameSync(temporary, native);
  } finally { rmSync(temporary, { force: true }); }
  return guard;
}
export interface RouteObservation {
  schema: string; qualified: boolean; artifacts: Hashes; source_board_sha256: string; findings: Finding[]; stop_unchanged_retry: boolean;
  status?: string; action?: string; reason?: string; no_electrical_rule_relaxation?: boolean;
}
/** How `iotroute run` starts the cause of a refused admission (tools/router/core/src/run/steps.rs). */
const RULE_COVERAGE = 'rule coverage refused';
interface RunRecord { status?: string; cause?: string; input_sha256?: string; board_sha256?: string; board_file?: string }
/** The evidence of one `iotroute run`, in its work folder OUT.iotroute: what it found, and the next step that follows from that. */
export function observeRoute(sourceBoard: string, work: string): RouteObservation {
  const names = ['result.json', 'drc.json', 'open-triage.json', 'pin-escape.json'];
  const result: RouteObservation = { schema: 'iot-lab.route-observation.v1', qualified: false,
    artifacts: Object.fromEntries(names.filter(name => existsSync(join(work, name))).map(name => [name, sha256File(join(work, name))])),
    source_board_sha256: sha256File(sourceBoard), findings: [], stop_unchanged_retry: true };
  try {
    const record = read<RunRecord>(join(work, 'result.json'));
    if (record.status === 'ERROR') {
      result.status = 'unverified'; result.reason = record.cause ?? 'iotroute run gave no verdict';
      result.action = result.reason.startsWith(RULE_COVERAGE) ? 'resolve_constraint_coverage' : 'inspect_evidence';
      return result;
    }
    if (record.input_sha256 !== sha256File(sourceBoard) || !record.board_file || record.board_sha256 !== sha256File(record.board_file) || !['PASS', 'FAIL'].includes(record.status ?? '')) throw new Error('route inputs/result are stale or incomplete');
    const report = read<DrcReport>(join(work, 'drc.json')); checkReport(report);
    const diagnostics: Diagnostics = {};
    if (existsSync(join(work, 'open-triage.json'))) diagnostics.triage = read(join(work, 'open-triage.json'));
    if (existsSync(join(work, 'pin-escape.json'))) diagnostics.escape = read(join(work, 'pin-escape.json'));
    result.findings = classify(report, diagnostics); const kinds = new Set(result.findings.map(row => row.classification));
    result.status = 'diagnosed'; result.action = kinds.has('schematic_parity') ? 'resolve_schematic_parity' : kinds.has('escape_failure') || kinds.has('model_enclosed') ? 'inspect_escape'
      : kinds.has('constraints_unknown') ? 'resolve_constraint_coverage' : kinds.has('native_geometry') ? 'inspect_native_geometry'
        : kinds.has('native_open') ? 'diagnose_selected_connections' : 'continue_native_validation';
    result.reason = 'Diagnostic next step; no physical impossibility or joint-routability claim'; result.no_electrical_rule_relaxation = true;
  } catch (error) { result.status = 'unverified'; result.action = 'inspect_evidence'; result.reason = (error as Error).message; }
  return result;
}
export function retryKey(sourceBoard: string, configuration: unknown): string {
  const board = resolvePath(sourceBoard), files = Object.fromEntries(['.kicad_pcb', '.kicad_pro', '.kicad_dru', '.kicad_sch'].map(ext => {
    const file = withSuffix(board, ext); return [ext, existsSync(file) ? sha256File(file) : null];
  }));
  const tools = resolvePath(fileURLToPath(new URL('..', import.meta.url))), policy: Hashes = {};
  for (const name of [...IMPLEMENTATION_RETRY, 'route-features.json']) policy[name] = sha256File(join(tools, name));
  // Bind the route pipeline while its callers are moving independently on this branch.
  for (const name of ['lib/lean-workflow.ts']) {
    const file = join(tools, name); if (existsSync(file)) policy[name] = sha256File(file);
  }
  // The job, its grid and its rules are the router core.
  if (existsSync(join(tools, 'router/core/src'))) policy['router/core'] = sourcesSha(join(tools, 'router/core'));
  for (const name of ['ROUTE_FEATURES_FILE', 'KICAD_CLI', 'IOTROUTE_BIN', 'ROUTE_COVERAGE_BIN']) {
    const path = process.env[name]; if (path && existsSync(path)) policy[path] = sha256File(path);
  }
  return fingerprint({ inputs: files, configuration, policy, environment: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(ROUTE_|KICAD|IOT_LEAN)/.test(key))) });
}
const IMPLEMENTATION_RETRY = ['route_decision.ts', 'lib/route-decision.ts', 'lib/route-decision-board.ts', 'lib/route-decision-evidence.ts', 'lib/route-decision-escape.ts'];
