#!/usr/bin/env node
// Unattended routing batches for a board on the gate runner. No model is in the loop: Freerouting proposes,
// the gate decides, git keeps only what passes.
//
//   node tools/route_batch.mjs <BOARD> [--size 8] [--batches 10] [--layers F.Cu,B.Cu] [--timeout 00:03:30]
//                                      [--max-mm 40] [--local] [--dry-run]
//
// One batch:
//   1. node tools/gate.mjs + tools/route_plan.mjs give the open SLOW nets, shortest first. Power nets and fast
//      nets are never routed here (they need width, pairs and reference planes: hand work).
//   2. Freerouting routes the next --size nets on the Hetzner box (tools/remote.sh; --local uses this computer).
//   3. tools/import_nets.py puts the new copper of these nets on the board. The gate runs with
//      --ratchet --strict against git HEAD. Accept = no gate is worse and fewer connections are open.
//   4. Accept: git commit (board + gate-metrics.json). Reject: git checkout the board, then bisect the net list
//      with the same candidate (no new router run). A net that fails alone goes to the failed list.
// State: <board>/.gate/route-batch.json (failed nets; delete the file to try them again).
// Log: <board>/.gate/route-batch.log, one line per decision.
// Stop: no slow net left under --max-mm, --batches reached, or 2 batches in sequence with no accepted net.
// Start from a clean board file (git status). The script commits on the current branch; it does not push.

import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, appendFileSync, existsSync, mkdtempSync, copyFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {tmpdir} from 'node:os';
import {root, kicadPython} from './lib/env.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const flag = (name) => args.includes(name);
const valued = ['--size', '--batches', '--layers', '--timeout', '--max-mm'];
const board = args.find((a, i) => !a.startsWith('--') && !valued.includes(args[i - 1]));
const dir = join(root, 'hardware-design/boards', board ?? '');
if (!board || !existsSync(join(dir, 'gate.json'))) {
  console.error('usage: node tools/route_batch.mjs <BOARD> [--size 8] [--batches 10] [--layers F.Cu,B.Cu] [--timeout 00:03:30] [--max-mm 40] [--local] [--dry-run]');
  process.exit(2);
}
const size = Number(opt('--size', 8));
const batches = Number(opt('--batches', 10));
const layers = opt('--layers', 'F.Cu,B.Cu');
const timeout = opt('--timeout', '00:03:30');
const maxMm = Number(opt('--max-mm', 40));
const cfg = JSON.parse(readFileSync(join(dir, 'gate.json'), 'utf8'));
const pcb = join(dir, `${cfg.project}.kicad_pcb`);
const pcbRel = relative(root, pcb);
const boardRel = relative(root, dir);
const metricsRel = join(boardRel, 'gate-metrics.json');
const stateFile = join(dir, '.gate/route-batch.json');
const logFile = join(dir, '.gate/route-batch.log');

const sh = (cmd, a, o = {}) => execFileSync(cmd, a, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, ...o});
const ok = (cmd, a, o) => {
  try {
    sh(cmd, a, o);
    return true;
  } catch {
    return false;
  }
};
const log = (line) => {
  const text = `${new Date().toISOString().slice(0, 19)} ${line}`;
  console.log(text);
  appendFileSync(logFile, `${text}\n`);
};
const git = (...a) => sh('git', a);
const metrics = () => JSON.parse(readFileSync(join(root, metricsRel), 'utf8')).metrics;
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {failed: []};
const saveState = () => writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);

if (git('status', '--porcelain', '--', pcbRel, metricsRel).trim()) {
  console.error(`route_batch: ${pcbRel} or gate-metrics.json has uncommitted changes. Commit or restore them first.`);
  process.exit(2);
}

// The open slow nets, shortest first, without the failed ones. Runs the gate first (fresh drc.json).
function plan() {
  ok('node', ['tools/gate.mjs', board]);
  const list = JSON.parse(sh('node', ['tools/route_plan.mjs', board, '--json']));
  // Ground nets connect through plane vias (gnd_pad_vias.py, pcbtool stitch), not through routed tracks.
  return list.filter((n) => n.cls === 'slow' && !/GND/.test(n.name) && n.mm <= maxMm && !state.failed.includes(n.name));
}

// Freerouting on the listed nets. Returns the candidate board path, or null.
function route(nets, work) {
  const cand = join(work, 'cand.kicad_pcb');
  const fr = ['tools/freeroute.py', pcbRel, flag('--local') ? cand : 'out/cand.kicad_pcb', '--no-live', '--layers', layers, '--timeout', timeout, '--nets', nets.join(',')];
  if (flag('--local')) return ok(kicadPython, fr) && existsSync(cand) ? cand : null;
  const env = {...process.env, REMOTE_MEM: process.env.REMOTE_MEM ?? '8g', REMOTE_CPUS: process.env.REMOTE_CPUS ?? '8', REMOTE_TIMEOUT: process.env.REMOTE_TIMEOUT ?? '900'};
  ok('bash', ['tools/remote.sh', boardRel, '--results', work, '--', 'python3', ...fr], {env});
  return existsSync(cand) ? cand : null;
}

// Try to keep the candidate copper of `nets`. Returns the accepted net names. Bisects on a reject.
function accept(nets, cand, before) {
  // pcbnew SaveBoard also rewrites the .kicad_pro: restore the project file too, and never commit it here.
  const restore = () => git('checkout', '--', pcbRel, metricsRel, pcbRel.replace(/\.kicad_pcb$/, '.kicad_pro'));
  let reason = 'import failed';
  if (ok(kicadPython, ['tools/import_nets.py', pcb, cand, pcb, '--nets', nets.join(',')])) {
    const gateOk = ok('node', ['tools/gate.mjs', board, '--ratchet', '--strict', '--write']);
    const now = metrics();
    if (gateOk && now.drc_unconnected < before.drc_unconnected) {
      git('add', '--', pcbRel, metricsRel);
      git('checkout', '--', pcbRel.replace(/\.kicad_pcb$/, '.kicad_pro'));
      // --no-verify: the same gate ran on this exact board a moment ago.
      git('commit', '-q', '--no-verify', '-m', `${board} route_batch: ${nets.length} slow nets, open ${before.drc_unconnected} -> ${now.drc_unconnected}\n\nFreerouting (${layers}), accepted by tools/gate.mjs --ratchet --strict.\nNets: ${nets.join(', ')}\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`);
      log(`ACCEPT ${nets.length} nets, open ${before.drc_unconnected} -> ${now.drc_unconnected}: ${nets.join(' ')}`);
      return nets;
    }
    reason = gateOk ? 'no fewer open connections' : 'a gate is worse';
  }
  restore();
  if (nets.length === 1) {
    log(`REJECT ${nets[0]} (${reason})`);
    state.failed.push(nets[0]);
    saveState();
    return [];
  }
  const half = Math.ceil(nets.length / 2);
  const first = accept(nets.slice(0, half), cand, before);
  const second = accept(nets.slice(half), cand, first.length ? metrics() : before);
  return [...first, ...second];
}

let empty = 0;
for (let b = 1; b <= batches && empty < 2; b += 1) {
  const todo = plan();
  if (!todo.length) {
    log('STOP no open slow net left under the length limit (failed nets are in route-batch.json)');
    break;
  }
  const nets = todo.slice(0, size).map((n) => n.name);
  const before = metrics();
  log(`BATCH ${b}/${batches}: ${nets.length} of ${todo.length} slow nets, open ${before.drc_unconnected}`);
  if (flag('--dry-run')) {
    log(`dry run, nets: ${nets.join(' ')}`);
    break;
  }
  const work = mkdtempSync(join(tmpdir(), 'route-batch-'));
  const cand = route(nets, work);
  if (!cand) {
    log(`ROUTER FAILED (see ${work}/job.log)`);
    empty += 1;
    continue;
  }
  const kept = accept(nets, cand, before);
  empty = kept.length ? 0 : empty + 1;
}
const end = metrics();
log(`END open ${end.drc_unconnected}, failed list ${state.failed.length} nets`);
