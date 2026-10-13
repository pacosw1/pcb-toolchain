// Run only the local solver; the host supplies a process deadline. Native KiCad
// import and validation remain separate from solver completion.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { retainedTrackPortConflicts, solverWork } from './planning.mjs';
import { retainedCopperPlanningInput, configureReusePipeline } from './reuse.mjs';

const require = createRequire(import.meta.url);
const pkg = require('@tscircuit/capacity-autorouter/package.json');
if (pkg.version !== '0.0.979') throw new Error('unexpected router version');
const request = JSON.parse(readFileSync(0, 'utf8'));
if (!Number.isFinite(request.budget_ms) || request.budget_ms <= 0) throw new Error('finite positive budget required');
console.log = (...args) => console.error(...args);
const start = performance.now();
let lastPhase = '', lastReport = -Infinity;
function progress(phase, solver) {
  const elapsed = performance.now() - start;
  // Diagnostic sampling policy, not a routing/design tolerance. Emit before
  // expensive work too, so a hard process deadline retains its last known phase.
  if (phase === lastPhase && elapsed - lastReport < 1000) return;
  process.stderr.write('IOT_CAPACITY_PROGRESS ' + JSON.stringify({
    schema: 'iot-lab.capacity-progress.v1', phase, elapsed_ms: elapsed,
    iterations: solver?.iterations ?? 0,
    subsolver: solver?.activeSubSolver?.constructor?.name ?? null,
    subsolver_iterations: solver?.activeSubSolver?.iterations ?? null,
    work: solverWork(solver),
  }) + '\n');
  lastPhase = phase; lastReport = elapsed;
}
progress('loading_backend');
const { AutoroutingPipelineSolver, AutoroutingPipelineSolver10_BgaFanout } = await import('@tscircuit/capacity-autorouter');
const Solver = { topology: AutoroutingPipelineSolver, fanout: AutoroutingPipelineSolver10_BgaFanout,
  reuse: AutoroutingPipelineSolver }[request.pipeline];
if (!Solver) throw new Error('unknown routing pipeline');
progress('initializing');
const solver = new Solver(request.pipeline==='reuse' ? retainedCopperPlanningInput(request.input) : structuredClone(request.input), { cacheProvider: null });
const reuse = request.pipeline==='reuse' ? configureReusePipeline(solver,request.input,start+request.budget_ms) : null;
let stitchedProposal = false;
let planningChecked = false, planningConflicts = [];
while (!solver.solved && !solver.failed && performance.now() - start < request.budget_ms) {
  if (reuse && solver.getCurrentPhase()==='traceSimplificationSolver') {
    if (!solver.highDensityStitchSolver?.solved) throw new Error('stitching did not complete');
    stitchedProposal=true; progress('stitched_proposal',solver); break;
  }
  // The constructor sets these nodes before the first detailed routing step.
  // Protected copper is restored by our importer, so a port through that copper
  // is an invalid plan even if the backend could move the original trace.
  if (!planningChecked && solver.highDensityRouteSolver) {
    if (!Array.isArray(solver.highDensityNodePortPoints)) throw new Error('missing detailed planning nodes');
    planningConflicts = retainedTrackPortConflicts(request.input, solver.highDensityNodePortPoints, solver.connMap);
    planningChecked = true;
    if (planningConflicts.length) { progress('planning_conflict', solver); break; }
  }
  progress(solver.getCurrentPhase?.() ?? solver.constructor.name, solver);
  solver.step();
}
const status = performance.now() - start >= request.budget_ms ? 'timeout' : planningConflicts.length ? 'model_conflict' : (solver.solved||stitchedProposal) ? 'candidate' : solver.failed ? 'backend_error' : 'timeout';
const output = {
  schema: 'iot-lab.capacity-route.v1', status, qualified: false,
  input_sha256: request.input_sha256, native_validation_required: true,
  pipeline: request.pipeline, iterations: solver.iterations, elapsed_ms: performance.now() - start,
  error: solver.error ?? null,
  backend: { name: pkg.name, version: pkg.version, node: process.version,
    entry_sha256: createHash('sha256').update(readFileSync(require.resolve(pkg.name))).digest('hex') },
};
if (planningConflicts.length) {
  output.reason = 'planned channel endpoint conflicts with retained copper; repair topology or placement before detailed routing';
  output.planning_conflicts = planningConflicts;
}
if (reuse) output.reuse= reuse;
if (status === 'candidate') {
  if (stitchedProposal) {
    output.completed_stage='highDensityStitchSolver';
    output.backend_solved=false;
    output.reason='stitched proposal; native validation required before optional polishing';
    output.output={...structuredClone(request.input),traces:[...structuredClone(request.input.traces??[]),...solver.getNewTracesBeforePowerExpansion()]};
  } else output.output = solver.getOutputSimpleRouteJson();
}
process.stdout.write(JSON.stringify(output));
