// Offline analysis of completed #1389/#1399 records. Never submits a job or reads active trials.
// node tools/router/benchmarks/1410-timings.mjs SNAPSHOT_ROOT > report.json
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
if (!root) throw Error('completed snapshot root required');
const inputs = new Map();
function text(relative) {
  const bytes = fs.readFileSync(path.join(root, relative));
  inputs.set(relative, { path: relative, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
  return bytes.toString('utf8');
}
const json = p => JSON.parse(text(p));
const lines = p => text(p).trim().split('\n').map(JSON.parse);
const sum = rows => rows.reduce((a, b) => a + b, 0);
const rounded = n => Math.round(n * 1e6) / 1e6;
const difference = (a, b) => (Date.parse(a) - Date.parse(b)) / 1000;
function outer(base) {
  const job = json(`${base}/results/job.json`), submission = json(`${base}/submission.json`);
  assert.ok(['failed', 'succeeded', 'cancelled', 'timed_out'].includes(job.state), 'requires terminal job');
  const attempt = job.attempts.at(-1);
  assert.ok(attempt.endedAt && attempt.trimmed, 'requires completed, trimmed attempt');
  const bench = json(`${base}/results/out/benchmark/result.json`);
  assert.ok(Math.abs((bench.cpu_end.usage_usec - bench.cpu_start.usage_usec) / 1e6 - bench.cgroup_cpu_s) < 1e-6);
  const client = text(`${base}/client.log`);
  return {
    job: job.id, mode: bench.mode, cpus: submission.cpus, mem_gb: submission.mem_gb,
    queue_s: difference(attempt.startedAt, job.createdAt), container_wall_s: difference(attempt.endedAt, attempt.startedAt),
    operation_wall_s: bench.elapsed_s, operation_cgroup_cpu_s: bench.cgroup_cpu_s,
    container_minus_operation_s: difference(attempt.endedAt, attempt.startedAt) - bench.elapsed_s,
    client_observed_s: submission.client_elapsed_s, client_stream_interrupted: /daemon unreachable/.test(client),
    cache: client.match(/^pcb-job: cache: (.*)$/m)?.[1] ?? null,
    pack_upload_wall_s: null, pack_upload_cpu_s: null,
    official_status: bench.status, error: bench.error, source_sha256: bench.source_sha256, binary_sha256: bench.binary_sha256,
    bench,
  };
}
function single(label, base) {
  const o = outer(base), { bench, ...out } = o;
  const folder = `${base}/results/out/route/ESP32-CORE.kicad_pcb.iotroute`;
  const rec = json(`${folder}/result.json`), log = text(`${folder}/ref-r2/route.log`);
  assert.equal(rec.input_sha256, bench.source_sha256);
  assert.equal(rec.stages.ref_gate.rounds.length, 2);
  assert.equal(rec.stages.ref_gate.rounds[0].next_core.iters, 22);
  assert.equal(text(`${folder}/route.log`), log, 'selected log overwrites the initial log in these records');
  let previous = 0;
  const passes = [...log.matchAll(/^iter\s+(\d+):.*?, ([\d.]+) s\s+hard:/gm)].map(m => {
    const elapsed = Number(m[2]), delta = rounded(elapsed - previous); previous = elapsed;
    return { pass: Number(m[1]), cumulative_s: elapsed, delta_from_previous_logged_boundary_s: delta, cpu_s: null };
  });
  assert.equal(passes.length, 22);
  const core2 = Number(log.match(/^ROUTE PASS .*? (\d+) s ->/m)[1]);
  const recovery = Number(log.match(/^length recovery:.*? ([\d.]+) s$/m)[1]);
  const native = bench.stages.find(s => s.label === 'native'), gate = bench.stages.find(s => s.label === 'gate');
  const core1 = rec.stages.core.seconds;
  const gateEvents = lines(`${base}/results/out/benchmark/gate/events.jsonl`);
  const checks = gateEvents.filter(e => e.type === 'tool.exit').map(e => ({ stage: e.stage, wall_s: e.duration_s, cpu_s: null }));
  return {
    label, ...out, candidate_sha256: rec.board_sha256, native_counts: [rec.drc_errors, rec.unconnected, rec.parity],
    native: { wall_s: native.elapsed_s, owned_child_cpu_s: native.childCpuS },
    gate: { wall_s: gate.elapsed_s, owned_child_cpu_s: gate.childCpuS, checks, check_wall_sum_non_additive_s: sum(checks.map(c => c.wall_s)) },
    harness_residual: { wall_s: bench.elapsed_s - native.elapsed_s - gate.elapsed_s, cpu_s: bench.cgroup_cpu_s - native.childCpuS - gate.childCpuS },
    first_core: { wall_s: core1, precision_s: 0.1, cpu_s: null, passes: rec.stages.core.claim.iters, pass_times_available: false },
    feedback_core: { wall_s: core2, precision_s: 1, cpu_s: null, passes, negotiation_through_last_boundary_s: previous,
      length_recovery_s: recovery, other_core_wall_approx_s: rounded(core2 - previous - recovery) },
    two_core_wall_approx_s: rounded(core1 + core2), two_core_fraction_approx: (core1 + core2) / bench.elapsed_s,
    native_noncore_residual_approx_s: rounded(native.elapsed_s - core1 - core2),
    reference_feedback: rec.stages.ref_gate.rounds,
    model_write_refill_planes_final_drc_split_available: false,
    checkpointing: { requested: false, wall_s: null, cpu_s: null },
  };
}

const singles = [single('1389-after-fix-4GiB-gate-OOM', '1389/after-fix'), single('1399-calibration', 'calibration-1399'), single('1399-single-a', 'single-a')];
assert.equal(singles[1].binary_sha256, singles[2].binary_sha256);
assert.equal(singles[1].candidate_sha256, singles[2].candidate_sha256);
const base = 'sprint-a', { bench, ...sprint } = outer(base);
const folder = `${base}/results/out/route/ESP32-CORE.kicad_pcb.iotroute/portfolio`;
const stages = json(`${folder}/owned-stages.json`), events = lines(`${folder}/events.jsonl`), portfolio = json(`${folder}/result.json`);
const groups = { preparation: [], core_slices: [], native_finish: [], configured_gate: [] };
const checkpoint = [], lengthRecovery = [];
for (const stage of stages) {
  const kind = stage.command[1] === 'sprint-prepare' ? 'preparation' : stage.command[1] === 'sprint-finish' ? 'native_finish'
    : stage.log.endsWith('/gate.log') ? 'configured_gate' : 'core_slices';
  groups[kind].push(stage);
  if (kind === 'core_slices') {
    const relative = stage.log.slice(stage.log.indexOf('/portfolio/') + '/portfolio/'.length);
    const log = text(`${folder}/${relative}`);
    const found = log.match(/^checkpoint: (\d+) writes, ([\d.]+) s,/m);
    if (found) checkpoint.push({ log: relative, writes: Number(found[1]), wall_s: Number(found[2]) });
    const recovery = log.match(/^length recovery:.*? ([\d.]+) s$/m);
    if (recovery) lengthRecovery.push({ log: relative, wall_s: Number(recovery[1]) });
  }
}
const stageGroups = Object.fromEntries(Object.entries(groups).map(([k, ss]) => [k, { count: ss.length,
  child_wall_sum_non_additive_s: sum(ss.map(s => s.wall_s)), owned_child_cpu_s: sum(ss.map(s => s.childCpuS)) }]));
assert.ok(Math.abs(stageGroups.core_slices.owned_child_cpu_s - portfolio.cpu_s) < 1e-6);
const verification = events.filter(e => e.type === 'sprint.verify.end').map(end => {
  const start = events.find(e => e.type === 'sprint.verify.start' && e.variant === end.variant);
  return { variant: end.variant, start_s: start.elapsed_s, end_s: end.elapsed_s, wall_s: end.elapsed_s - start.elapsed_s, passed: end.passed };
});
console.log(JSON.stringify({
  schema: 'pcb.esp32-timing-1410.v1', snapshot_scope: 'three completed single operations and completed sprint-a only; no new board runs',
  snapshot_provenance: json('SOURCES.json'),
  singles, sprint: { label: '1399-sprint-a', ...sprint, controller_status: portfolio.status, reason: portfolio.reason,
    phase_groups: stageGroups, verification, progress_checkpoint_logged: checkpoint,
    progress_checkpoint_logged_wall_sum_s: sum(checkpoint.map(c => c.wall_s)), resumable_checkpoint_save_load_s: null,
    terminal_length_recovery: lengthRecovery, core_slice_cpu_fraction: portfolio.cpu_s / bench.cgroup_cpu_s,
    cpu_residual_s: bench.cgroup_cpu_s - sum(stages.map(s => s.childCpuS)),
    first_slice_start_s: events.find(e => e.type === 'sprint.slice.start').elapsed_s,
  },
  accounting: { cpu: 'whole operation cgroup delta; disjoint owned children use wait4 including reaped descendants; nested scopes must not be added',
    wall: 'parallel child/check wall durations overlap; only parent wall is end-to-end',
    pass_deltas: 'from rounded cumulative core clocks; first delta includes core setup; not isolated maze-expansion time',
    unavailable: ['pack/upload phase timers', 'single model and preflight split', 'single writer/refill and final native DRC split',
      'single reference-screen durations', 'first single-core pass log (overwritten)', 'single core per-phase CPU', 'sprint resumable checkpoint save/load duration'] },
  inputs: [...inputs.values()].sort((a, b) => a.path.localeCompare(b.path)),
}, null, 2));
