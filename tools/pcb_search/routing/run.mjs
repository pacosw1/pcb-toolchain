// Run only the local solver; the host supplies a process deadline. Native KiCad
// import and validation remain separate from solver completion.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { AutoroutingPipelineSolver, AutoroutingPipelineSolver10_BgaFanout } from '@tscircuit/capacity-autorouter';

const require = createRequire(import.meta.url);
const pkg = require('@tscircuit/capacity-autorouter/package.json');
if (pkg.version !== '0.0.979') throw new Error('unexpected router version');
const request = JSON.parse(readFileSync(0, 'utf8'));
if (!Number.isFinite(request.budget_ms) || request.budget_ms <= 0) throw new Error('finite positive budget required');
const Solver = { topology: AutoroutingPipelineSolver, fanout: AutoroutingPipelineSolver10_BgaFanout }[request.pipeline];
if (!Solver) throw new Error('unknown routing pipeline');
console.log = (...args) => console.error(...args);
const start = performance.now();
const solver = new Solver(structuredClone(request.input), { cacheProvider: null });
while (!solver.solved && !solver.failed && performance.now() - start < request.budget_ms) solver.step();
const status = performance.now() - start >= request.budget_ms ? 'timeout' : solver.solved ? 'candidate' : solver.failed ? 'backend_error' : 'timeout';
const output = {
  schema: 'iot-lab.capacity-route.v1', status, qualified: false,
  input_sha256: request.input_sha256, native_validation_required: true,
  pipeline: request.pipeline, iterations: solver.iterations, elapsed_ms: performance.now() - start,
  error: solver.error ?? null,
  backend: { name: pkg.name, version: pkg.version, node: process.version,
    entry_sha256: createHash('sha256').update(readFileSync(require.resolve(pkg.name))).digest('hex') },
};
if (status === 'candidate') output.output = solver.getOutputSimpleRouteJson();
process.stdout.write(JSON.stringify(output));
