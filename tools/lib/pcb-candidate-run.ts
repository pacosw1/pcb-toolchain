// Transactional candidate operations: build, edit, route, repair and release work on an isolated snapshot, and canonical CAD
// changes only in adoption. Runs as the owned child of tools/pcb-check-worker.ts, which reads operation/result.json.
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dependencyFiles } from './design-contract-load.ts';
import { designServices } from './design-services.ts';
import { validateExplicitSpec } from './explicit-spec.ts';
import { atomicJson, plainJson, readObject, sha256File } from './json-file.ts';
import { iotroutePolicy } from './outcome-controls.ts';
import { checkPlacementRules, verifyManifest } from './placement-rules.ts';
import { verifyAction } from './pcb-action.ts';
import { candidateLayoutCheck, designAdmission, type OperationManifest, placementCheck, routesCopper } from './pcb-candidate-screens.ts';
import { parentCandidate } from './pcb-candidate.ts';
import { declaredPours, pcbIdentity, type PourSet } from './pcb-identity.ts';
import { type Emit, execute, measuredStage, operationEvent, type Row } from './pcb-operation-log.ts';
import { validateGate } from './pcb-routing-admission.ts';
import { snapshot, sourceState, type SourceState } from './pcb-sources.ts';
import { boardConfig, operationCommand, pythonNative, routePolicyArgs } from './pcb-workflow.ts';
import { keepStuck } from './route-stuck.ts';
import { iotrouteBin } from './iotroute-bin.ts';
import { fileRoot } from './project-root.mjs';
import { isFile, isRelativeTo, joinPath, relativeTo, resolvePath, which, withSuffix } from './py-path.ts';
import { sameValue } from './py-values.ts';
import { applyPlan, planDependencies } from './route-decision.ts';
import { EscapeStageReceipts } from './route-decision-escape.ts';

/** Scratch folders of the board pipelines, one per pipeline, all inside the operation. */
const PIPELINE_WORK = ['ENV_WORK', 'BASEB_WORK', 'BASEC_WORK', 'AC24_WORK', 'AC24C_WORK', 'CELL_WORK', 'FIELD24B_WORK', 'AIO_WORK'];

interface Hook { stage?: string; run?: unknown[]; env?: Record<string, unknown> }
interface Candidate {
  folder: string; root: string; workspace: string; manifest: OperationManifest; board: string; native: string; sourceNative: string; sources: SourceState; extraInputs: string[];
  env: NodeJS.ProcessEnv; spec: string | null; pours: PourSet; emit: Emit;
}
interface ToolOutcome { code: number; report: Row | null }

const finish = (folder: string, result: Row): number => {
  atomicJson(join(folder, 'operation/result.json'), result);
  return Number(result.exit_code);
};
const sameIdentity = (run: Candidate): boolean => sameValue(pcbIdentity(run.sourceNative, run.pours), pcbIdentity(run.native, run.pours));
const sourceUnchanged = (run: Candidate): boolean => sameValue(sourceState(run.root, run.board, run.extraInputs), run.sources);

/** The gate.json "post_verify" and "place_check" hooks. Placeholders: {node}, {kicad_python}, {candidate}, {run}, {operation}. */
export function postVerifyCommands(hooks: unknown, folder: string, candidate: string, node: string, env: NodeJS.ProcessEnv): { stage: string; command: string[]; env: NodeJS.ProcessEnv }[] {
  const values: [string, string][] = [['{node}', node], ['{kicad_python}', pythonNative()], ['{candidate}', candidate], ['{run}', folder], ['{operation}', join(folder, 'operation')]];
  const fill = (text: unknown): string => values.reduce((value, [key, replacement]) => value.replaceAll(key, replacement), String(text));
  return ((hooks ?? []) as Hook[]).map(hook => {
    if (!hook || typeof hook !== 'object' || !hook.stage || !Array.isArray(hook.run) || !hook.run.length) throw new Error('gate.json hook entries need a stage and a run argv');
    return { stage: hook.stage, command: hook.run.map(fill), env: { ...env, ...Object.fromEntries(Object.entries(hook.env ?? {}).map(([key, value]) => [key, fill(value)])) } };
  });
}

/** Everything else the candidate depends on: the snapshot and the final freshness check bind these too. */
async function extraInputs(root: string, manifest: OperationManifest, design: Row | null, parentFiles: Record<string, string>): Promise<string[]> {
  const extra: string[] = [];
  const within = (name: string, digest: string, message: string): void => {
    const path = resolvePath(name);
    if (!isRelativeTo(path, root) || sha256File(path) !== digest) throw new Error(`${message}: ${name}`);
    extra.push(relativeTo(path, root));
  };
  if (design) {
    // The changed layout must obey its declared future constraints too: their sources, without rerunning stage checks.
    extra.push(...dependencyFiles(root, manifest.design_contract!.path, 'placement', designServices(root, root)));
    for (const [name, digest] of Object.entries({ ...design.inputs as Row, ...design.tool_inputs as Row })) {
      const path = resolvePath(joinPath(root, name));
      if (!isRelativeTo(path, root)) continue;
      if (!isFile(path) || sha256File(path) !== digest) throw new Error(`design prerequisite dependency changed: ${name}`);
      extra.push(relativeTo(path, root));
    }
  }
  for (const [name, digest] of Object.entries(parentFiles)) within(name, digest, 'parent candidate dependency changed or escaped checkout');
  if (manifest.operation === 'repair') {
    const plan = manifest.plan!;
    for (const [name, digest] of Object.entries({ [resolvePath(plan.path)]: plan.sha256, ...planDependencies(plan.content as never) }))
      within(name, digest, 'routing repair dependency is stale or outside checkout');
  }
  return extra;
}

/** Stops the operation when a reviewed part use is incomplete; a complete one adds its sources to the snapshot. */
function reviewParts(root: string, folder: string, manifest: OperationManifest, extra: string[]): number | null {
  const engineering = manifest.engineering_manifest;
  if (!engineering) return null;
  const path = resolvePath(engineering.path), output = join(folder, 'operation/part-review.json');
  if (!isRelativeTo(path, root) || sha256File(path) !== engineering.sha256) throw new Error('engineering manifest changed or is outside this checkout');
  const review = verifyManifest(root, manifest.board, path);
  atomicJson(output, review);
  if (review.status !== 'passed') {
    return finish(folder, { status: 'failed', exit_code: 1, scope: 'engineering_preflight', operation: manifest.operation, cause: 'reviewed part evidence is incomplete or stale',
      candidate_verified: false, report: output });
  }
  extra.push(relativeTo(path, root));
  for (const name of Object.keys(review.inputs ?? {})) {
    const dependency = resolvePath(joinPath(root, name));
    if (!isRelativeTo(dependency, root)) throw new Error(`review dependency escapes checkout: ${name}`);
    extra.push(relativeTo(dependency, root));
  }
  return null;
}

/** Before spending on copper: the placement and test access the router would build on. */
async function routingPreflight(run: Candidate): Promise<number | null> {
  const { folder, root, manifest, board } = run, operation = manifest.operation;
  if (!routesCopper(manifest)) return null;
  const screens = new EscapeStageReceipts((kind, data) => run.emit(kind, { stage: 'placement-preflight', ...data }));
  if (manifest.engineering_manifest) {
    const output = join(folder, 'operation/placement-preflight.json');
    if (placementCheck(root, board, manifest.engineering_manifest.path, run.native, output, screens).status !== 'passed') {
      return finish(folder, { status: 'failed', exit_code: 1, scope: 'engineering_preflight', operation, cause: 'placement requirements block routing', candidate_verified: false,
        source_sha256: run.sources.sha256, report: output });
    }
  }
  if (manifest.design_contract) {
    const output = join(folder, 'operation/design-layout-preflight.json');
    if ((await candidateLayoutCheck(root, run.workspace, manifest, output, run.emit, screens)).status !== 'passed') {
      return finish(folder, { status: 'failed', exit_code: 1, scope: 'design_layout_screen', operation, candidate_verified: false, qualified: false,
        cause: 'candidate placement or test access blocks routing', source_sha256: run.sources.sha256, report: output });
    }
  }
  return null;
}

async function repair(run: Candidate): Promise<ToolOutcome> {
  const plan = run.manifest.plan!;
  if (sha256File(plan.path) !== plan.sha256) throw new Error('routing repair plan changed after admission');
  const guard = await measuredStage(run.emit, 'bounded-route-repair', 'operation', () => applyPlan(run.workspace, run.board, plan.content as never, join(run.folder, 'operation/repair')));
  atomicJson(join(run.folder, 'operation/repair-guard.json'), guard);
  return { code: guard.status === 'passed' || guard.status === 'proposed' ? 0 : 1, report: null };
}

function executable(name: string): string {
  const path = which(name);
  if (!path) throw new Error(`route executable is unavailable: ${name}`);
  return resolvePath(path);
}

/** `iotroute route`: it reads the candidate and writes only its own folder. A missing tool stops the run here, by name. */
async function routeJson(run: Candidate): Promise<ToolOutcome> {
  const output = join(run.folder, 'operation/router');
  const iotroute = executable(iotrouteBin());
  const tools = { IOTROUTE_BIN: iotroute, KICAD_API_CLI: executable(process.env.KICAD_API_CLI || 'kicad-cli-nightly'),
    KICAD_CLI: executable(process.env.KICAD_CLI ?? (process.platform === 'darwin' ? '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli' : 'kicad-cli')) };
  const code = await execute(run.folder, 'route', [iotroute, 'route', run.board, output, '--input', run.native, '--config', run.spec!], run.workspace, { ...run.env, ...tools });
  const record = join(output, 'result.json');
  // A stage that stops before its end writes no record: the cause is in the stage's own log, named by operation/route.log.
  const report: Row = isFile(record) ? readObject<Row>(record) : { status: 'ERROR', cause: `iotroute route wrote no result.json (exit ${code}); see operation/route.log` };
  const stuck = keepStuck(run.folder, run.board, join(output, 'stuck.json'));
  if (stuck) report.cause = `route stuck: ${stuck.summary[0]}`;
  atomicJson(join(run.folder, 'operation/router-summary.json'), report);
  if (!code) {
    if (!report.board_file || !isFile(String(report.board_file))) throw new Error('iotroute route returned success without its board_file');
    copyFileSync(String(report.board_file), run.native);
  }
  return { code, report };
}

/** iotroute run gives its verdict from KiCad DRC with parity on the saved fill; then the normal gate runs on the copy. A board's
 *  gate configuration is admitted first: a gate of any stage that the shared validator accepts. */
async function iotroute(run: Candidate): Promise<ToolOutcome> {
  await validateGate(run.workspace, run.board);
  const { folder, manifest, native } = run, output = join(folder, 'operation/router'), routed = join(output, native.split('/').at(-1)!);
  mkdirSync(output, { recursive: true });
  const command = [manifest.node, 'tools/router/route-dispatch.mjs', '--timeout', String(manifest.timeout_s), '--', 'iotroute', 'run', run.board, routed, '--pcb', native, '--json', '--diagnose', '--checkpoint',
    ...routePolicyArgs(manifest.spec ?? null, native)];
  const code = await execute(folder, 'route', command, run.workspace, run.env);
  const record = `${routed}.iotroute/result.json`;
  const report: Row = isFile(record) ? readObject<Row>(record) : { status: 'ERROR', cause: 'iotroute run wrote no result.json' };
  if (report.status === 'FAIL') report.cause = `iotroute DRC not clean: errors ${String(report.drc_errors)} unconnected ${String(report.unconnected)} parity ${String(report.parity)}`;
  const stuck = keepStuck(folder, run.board, `${routed}.iotroute/stuck.json`);
  if (stuck) report.cause = `route stuck: ${stuck.summary[0]}`;
  const summary = join(folder, 'operation/router-summary.json');
  atomicJson(summary, report);
  const policy = iotroutePolicy(command, report, sha256File(summary), manifest.timeout_s, code);
  if (policy) atomicJson(join(folder, 'operation/execution-policy.json'), policy);
  if (!code) {
    if (report.status !== 'PASS' || !report.board_file || !isFile(String(report.board_file))) throw new Error('iotroute run returned success without a PASS record and its board_file');
    copyFileSync(String(report.board_file), native);
  }
  return { code, report };
}

function runTool(run: Candidate): Promise<ToolOutcome> {
  const { manifest } = run, router = manifest.router ?? 'explicit';
  if (manifest.operation === 'repair') return repair(run);
  if (manifest.operation === 'route' && router === 'route-json') return routeJson(run);
  if (manifest.operation === 'route' && router === 'iotroute') return iotroute(run);
  const command = operationCommand(run.workspace, run.board, manifest.operation, run.spec, manifest.kind);
  return execute(run.folder, manifest.operation, command, run.workspace, run.env).then(code => ({ code, report: null }));
}

/** A result that names the candidate and what it preserved: every outcome from here on is continuable or adoptable evidence. */
const bound = (run: Candidate, changed: string[], identity: boolean): Row => ({ source_sha256: run.sources.sha256, candidate: run.native, candidate_sha256: sha256File(run.native),
  identity_preserved: identity, protected_source_changes: changed, source_unchanged: sourceUnchanged(run), workspace: run.workspace, board: run.board });

/** The candidate against the reviewed rules. A stop returns the operation's exit code. */
async function postChecks(run: Candidate, changed: string[], identity: boolean): Promise<number | null> {
  const { folder, root, manifest, board } = run, operation = manifest.operation;
  const screens = new EscapeStageReceipts((kind, data) => run.emit(kind, { stage: 'placement-postcheck', ...data }));
  if (manifest.engineering_manifest) {
    const output = join(folder, 'operation/placement-postcheck.json');
    const constraints = placementCheck(root, board, manifest.engineering_manifest.path, run.native, output, screens);
    if (constraints.status !== 'passed') {
      const blockers = (constraints.blockers ?? []) as Row[];
      return finish(folder, { status: 'failed', exit_code: 1, scope: 'candidate_engineering_screen', operation, cause: 'candidate violates reviewed placement or block requirements',
        candidate_verified: false, report: output, continuation_allowed: blockers.length > 0 && blockers.every(row => row.code === 'constraint_violation'), ...bound(run, changed, identity) });
    }
  }
  if (manifest.design_contract) {
    const output = join(folder, 'operation/design-layout-postcheck.json');
    if ((await candidateLayoutCheck(root, run.workspace, manifest, output, run.emit, screens)).status !== 'passed') {
      return finish(folder, { status: 'failed', exit_code: 1, scope: 'design_layout_screen', operation, candidate_verified: false, qualified: false,
        cause: 'candidate violates declared placement or test access requirements', report: output, continuation_allowed: false, ...bound(run, changed, identity) });
    }
  }
  if (operation === 'edit' && manifest.kind === 'place') {
    // The board's own placement rules, before the full gate and before any route spends time on this placement.
    const hooks = boardConfig(root, board).cfg.get('place_check');
    for (const hook of postVerifyCommands(plainJson(hooks), folder, run.native, manifest.node, run.env)) {
      if (await execute(folder, hook.stage, hook.command, run.workspace, hook.env)) {
        return finish(folder, { status: 'failed', exit_code: 1, scope: 'candidate_place_check', operation, candidate_verified: false,
          cause: `placement check ${hook.stage} failed; see operation/${hook.stage}.log`, continuation_allowed: false, ...bound(run, changed, identity) });
      }
    }
    const output = join(folder, 'operation/placement-constraints.json');
    const rules = checkPlacementRules(root, board, run.native, output);
    if (rules && rules.status !== 'passed') {
      return finish(folder, { status: 'failed', exit_code: 1, scope: 'candidate_place_check', operation, candidate_verified: false,
        cause: 'placement constraints failed; see operation/placement-constraints.log', report: output, continuation_allowed: false, ...bound(run, changed, identity) });
    }
  }
  return null;
}

/** The fresh configured gate on the candidate, then the board's own semantic checks in the snapshot. */
async function gate(run: Candidate, changed: string[], identity: boolean): Promise<Row> {
  const { folder, workspace, manifest, board, native, env } = run, gatePath = join(folder, 'gate/result.json');
  const code = await execute(folder, 'validate', [manifest.node, join(workspace, 'tools/gate.mjs'), board, '--fresh', '--evidence-dir', join(folder, 'gate')], workspace, env);
  const report = isFile(gatePath) ? readObject<Row>(gatePath) : null;
  let verified = code === 0 && report?.exit === 0 && !report.changedDuringRun;
  if (verified) {
    const hooks = boardConfig(run.root, board).cfg.get('post_verify');
    for (const hook of postVerifyCommands(plainJson(hooks), folder, native, manifest.node, env)) {
      if (await execute(folder, hook.stage, hook.command, workspace, hook.env)) { verified = false; break; }
    }
  }
  return { status: verified ? 'passed' : 'failed', exit_code: verified ? 0 : 1, cause: verified ? 'candidate meets configured gate targets' : 'candidate does not meet configured gate targets',
    candidate_verified: verified, identity_preserved: identity, protected_source_changes: changed, candidate: native, candidate_sha256: sha256File(native),
    metrics: report?.metrics ?? null, input_sha256: (report?.provenance as Row | undefined)?.input_sha256 ?? null };
}

const filesIn = (folder: string): string[] => {
  try {
    return readdirSync(folder).map(name => join(folder, name)).filter(isFile);
  } catch {
    return [];
  }
};

function workEnvironment(root: string, workspace: string, folder: string, manifest: OperationManifest): NodeJS.ProcessEnv {
  // The snapshot holds tools/ only: its tools find the toolchain's binaries through this.
  const env: NodeJS.ProcessEnv = { ...process.env, IOT_LAB: workspace, KICAD_PY: pythonNative(), KICAD_PYTHON: pythonNative(), PCB_TOOLCHAIN_ROOT: process.env.PCB_TOOLCHAIN_ROOT ?? fileRoot };
  if (manifest.engineering_manifest) {
    Object.assign(env, { PCB_ENGINEERING_MANIFEST: join(workspace, relativeTo(resolvePath(manifest.engineering_manifest.path), root)), PCB_ENGINEERING_BOARD: manifest.board, PCB_ENGINEERING_ROOT: workspace });
  }
  for (const key of PIPELINE_WORK) env[key] = join(folder, 'operation/work', key.toLowerCase());
  return env;
}

async function candidateOperation(folder: string, root: string, manifest: OperationManifest, design: Row | null, parent: { candidate: string; dependencies: Record<string, string> } | null, emit: Emit): Promise<number> {
  const { board, operation } = manifest;
  const extra = await extraInputs(root, manifest, design, parent?.dependencies ?? {});
  const stopped = reviewParts(root, folder, manifest, extra);
  if (stopped !== null) return stopped;
  const workspace = join(folder, 'workspace');
  const sources = await measuredStage(emit, 'snapshot', 'snapshot', () => snapshot(root, workspace, board, extra));
  atomicJson(join(folder, 'operation/source.json'), sources);
  const native = withSuffix(boardConfig(workspace, board).project, '.kicad_pcb');
  if (parent) {
    // The prior isolated geometry goes into the new workspace; the source receipt still binds unchanged canonical CAD.
    copyFileSync(parent.candidate, native);
    if (sha256File(native) !== sha256File(parent.candidate)) throw new Error('parent changed while continuing its candidate');
  }
  let spec: string | null = null;
  if (manifest.spec) {
    spec = join(folder, 'operation/spec.json');
    writeFileSync(spec, JSON.stringify(manifest.spec));
  }
  const run: Candidate = { folder, root, workspace, manifest, board, native, sourceNative: withSuffix(boardConfig(root, board).project, '.kicad_pcb'), sources, extraInputs: extra,
    env: workEnvironment(root, workspace, folder, manifest), spec, pours: declaredPours(manifest as never), emit };
  const blocked = await routingPreflight(run);
  if (blocked !== null) return blocked;
  verifyAction(manifest, manifest.action, sources);
  const inputCandidateSha256 = sha256File(native);
  const { code, report } = await runTool(run);
  let result: Row;
  if (code) {
    // A failed router leaves its input candidate in the private workspace. Bind that
    // unchanged candidate for continuation; partial router output remains separate,
    // unverified evidence and can never become adoptable through this path.
    const identity = sameIdentity(run), source = relativeTo(run.sourceNative, root);
    const changed = Object.entries(sources.files).filter(([name, digest]) => name !== source && (!isFile(join(workspace, name)) || sha256File(join(workspace, name)) !== digest)).map(([name]) => name);
    result = { status: 'failed', exit_code: 1, cause: report?.cause ?? `${operation} tool failed`, tool_exit: code,
      candidate_verified: false, continuation_allowed: operation === 'route' && manifest.router === 'iotroute' && identity && changed.length === 0 && sha256File(native) === inputCandidateSha256,
      ...bound(run, changed, identity) };
  }
  else {
    const identity = sameIdentity(run), source = relativeTo(run.sourceNative, root);
    const changed = Object.entries(sources.files).filter(([name, digest]) => name !== source && (!isFile(join(workspace, name)) || sha256File(join(workspace, name)) !== digest)).map(([name]) => name);
    if (!identity || changed.length) {
      return finish(folder, { status: 'failed', exit_code: 1, cause: 'candidate changed protected design inputs; explicit design revision required', identity_preserved: identity,
        protected_source_changes: changed, candidate_verified: false, scope: 'candidate_board_gate', operation, source_sha256: sources.sha256 });
    }
    const screened = await postChecks(run, changed, identity);
    if (screened !== null) return screened;
    result = await gate(run, changed, identity);
  }
  Object.assign(result, { scope: 'candidate_board_gate', operation, board, source_sha256: sources.sha256, source_unchanged: sourceUnchanged(run), workspace });
  if (!result.source_unchanged) Object.assign(result, { status: 'error', exit_code: 2, cause: 'canonical source changed during candidate operation' });
  const kept = [...filesIn(join(folder, 'gate')), ...filesIn(join(folder, 'operation')), ...(isFile(native) ? [native] : [])];
  result.artifacts = Object.fromEntries(kept.map(path => [relativeTo(path, folder), sha256File(path)]));
  return finish(folder, result);
}

async function release(folder: string, root: string, manifest: OperationManifest): Promise<number> {
  const env = { ...process.env, FAB_WORK_DIR: join(folder, 'release-work'), FAB_RELEASE_OUT: join(folder, 'candidate') };
  const code = await execute(folder, 'release', ['sh', join(root, 'tools/fab-workflow.sh'), manifest.board, 'release'], root, env);
  return finish(folder, { status: code === 0 ? 'passed' : code === 2 ? 'error' : 'failed', exit_code: code === 0 ? 0 : code === 2 ? 2 : 1,
    cause: `release ${code === 0 ? 'completed' : 'failed; inspect original tool evidence'}`, scope: 'fabrication_candidate', operation: 'release', tool_exit: code, artifact_directory: join(folder, 'candidate') });
}

export async function runOperation(folderPath: string): Promise<number> {
  const folder = resolvePath(folderPath), manifest = readObject<OperationManifest>(join(folder, 'run.json')), root = resolvePath(manifest.root);
  const emit: Emit = (kind, data) => operationEvent(folder, kind, data);
  mkdirSync(join(folder, 'operation'), { recursive: true });
  validateExplicitSpec(manifest.operation, manifest.kind, manifest.router, manifest.spec);
  verifyAction(manifest, manifest.action);
  const design = await designAdmission(root, folder, manifest, emit);
  if (design && design.status !== 'passed') return 1;
  if (manifest.operation === 'release') return release(folder, root, manifest);
  const parent = manifest.from_run ? parentCandidate(root, manifest.board, manifest.from_run) : null;
  return candidateOperation(folder, root, manifest, design as unknown as Row | null, parent, emit);
}
