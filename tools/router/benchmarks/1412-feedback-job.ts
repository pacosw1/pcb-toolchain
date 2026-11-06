// Controlled #1412 native experiment. Run only after #1399 releases the host.
// No acceptance exception: the configured gate's real exit code remains visible.
import fs from 'node:fs';
import path from 'node:path';
import { startOwned, type OwnedResult } from '../../lib/owned-stage.ts';
import { copyVerificationWorkspace, semanticChecks, digest } from '../sprint-native.ts';

const [board, mode] = process.argv.slice(2);
if (!['ESP32-CORE', 'NET-CORE', 'ENV-SENSE'].includes(board ?? '') || !['baseline', 'scoped'].includes(mode ?? '')) throw Error('BOARD baseline|scoped required');
const root = process.cwd(), bin = path.resolve(process.env.IOTROUTE_BIN ?? 'in/iotroute-linux-x86_64');
const config = JSON.parse(fs.readFileSync(`hardware-design/boards/${board}/gate.json`, 'utf8'));
const source = path.resolve(`hardware-design/boards/${board}/${config.project}.kicad_pcb`);
const out = path.resolve(`out/route/${board}.kicad_pcb`), directory = path.resolve('out/feedback-benchmark');
fs.mkdirSync(directory, { recursive: true });
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const cpu = () => {
  try { return Object.fromEntries(fs.readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8').trim().split('\n').map(line => { const [key, value] = line.split(' '); return [key!, Number(value)]; })); }
  catch { return null; }
};
const inputSha = digest(source), began = performance.now(), cpuStart = cpu();
const env = { ...process.env, IOTROUTE_BIN: bin, OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', RAYON_NUM_THREADS: '1' };
const stages: ({ label: string; command: string[]; wall_s: number } & OwnedResult)[] = [];
const abort = new AbortController();
const seconds = board === 'ENV-SENSE' ? 120 : board === 'NET-CORE' ? 660 : 21600;
const timer = setTimeout(() => abort.abort('existing operational deadline'), (seconds - 3) * 1000);
const stop = () => abort.abort('signal'); process.once('SIGINT', stop); process.once('SIGTERM', stop);
async function owned(command: string[], label: string, cwd = root, extra = env): Promise<OwnedResult> {
  if (abort.signal.aborted) throw Error('deadline exhausted');
  const fd = fs.openSync(path.join(directory, `${label}.log`), 'w');
  let stage; try { stage = startOwned(command, { cwd, env: extra, stdout: fd, stderr: fd }); } finally { fs.closeSync(fd); }
  const cancel = () => { void stage.cancel(); }; abort.signal.addEventListener('abort', cancel, { once: true });
  const at = performance.now();
  try { const result = await stage.settled; stages.push({ label, command, wall_s: (performance.now() - at) / 1000, ...result });
    if (!result.cleanup.complete) throw Error(`${label}: cleanup unconfirmed`); return result;
  } finally { abort.signal.removeEventListener('abort', cancel); }
}
let status = 'ERROR', error: string | null = null, native: unknown = null, gate: unknown = null;
try {
  const args = [bin, 'run', board!, out, '--pcb', source, '--iters', '80', '--json'];
  if (board === 'NET-CORE') args.push('--max-time', '600');
  else args.push('--lock-from', source, '--return-exempt', '--seed', '0', ...(board === 'ENV-SENSE' ? ['--max-time', '90'] : []));
  if (mode === 'scoped') args.push('--ref-reuse');
  const result = await owned(args, 'native');
  const record = read(`${out}.iotroute/result.json`); native = record;
  if (result.returncode !== 0 || record.status !== 'PASS' || record.drc_errors !== 0 || record.unconnected !== 0 || record.parity !== 0 || record.board_sha256 !== digest(out)) throw Error('native candidate rejected');
  const workspace = path.join(directory, 'workspace'); fs.mkdirSync(workspace); copyVerificationWorkspace(root, workspace);
  const candidate = path.join(workspace, path.relative(root, source)); fs.copyFileSync(out, candidate);
  const verifyEnv = { ...env, IOT_LAB: workspace }, evidence = path.join(directory, 'gate');
  const checked = await owned([process.execPath, path.join(workspace, 'tools/gate.mjs'), board!, '--fresh', '--evidence-dir', evidence], 'gate', workspace, verifyEnv);
  gate = read(path.join(evidence, 'result.json'));
  const g = gate as { exit: number; changedDuringRun: boolean };
  if (checked.returncode !== 0 || g.exit !== 0 || g.changedDuringRun) throw Error('configured gate rejected; inspect actual findings and stale records separately');
  for (const hook of semanticChecks(config.post_verify, directory, candidate, process.execPath, verifyEnv)) {
    if ((await owned(hook.command, hook.stage, workspace, hook.env as typeof env)).returncode !== 0) throw Error(`${hook.stage} rejected`);
  }
  if (digest(candidate) !== record.board_sha256) throw Error('verification changed candidate');
  status = 'PASS';
} catch (cause) { error = String(cause); console.error(error); }
finally {
  clearTimeout(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  const cpuEnd = cpu();
  const report = { schema: 'pcb.ref-feedback-benchmark.v1', board, mode, status, error, operation_wall_s: (performance.now() - began) / 1000,
    cgroup_cpu_s: cpuStart && cpuEnd ? (cpuEnd.usage_usec - cpuStart.usage_usec) / 1e6 : null, cpu_start: cpuStart, cpu_end: cpuEnd,
    input_sha256: inputSha, source_unchanged: digest(source) === inputSha, binary_sha256: digest(bin), node: process.version, stages, native, gate };
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}
process.exitCode = status === 'PASS' ? 0 : 2;
