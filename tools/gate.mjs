#!/usr/bin/env node
// One gate runner for all boards. It reads hardware-design/boards/<BOARD>/gate.json and runs the standard checks.
//
//   node tools/gate.mjs <BOARD>             run the checks, print the table; exit 1 when a check is not at its target
//   node tools/gate.mjs <BOARD> --ratchet   compare with gate-metrics.json of git HEAD; exit 1 only on a blocked regression
//   node tools/gate.mjs <BOARD> --write     also write <board>/gate-metrics.json (tracked: no time, no absolute path)
//   node tools/gate.mjs <BOARD> --ratchet --baseline FILE   compare with a metrics file in place of git HEAD
//   --strict (with --ratchet): a WARNING also gives exit 1
//   node tools/gate.mjs --list              the boards that have a gate.json
//
// gate.json: {"project": "cad/MC-MAIN/MC-MAIN", "checks": {"erc": true, "drc": true, "planes": "reference-planes.json",
//   "pairs": "diff-pairs.json", "paths": "current-paths.json", "viapads": {"allow": ["U1.9"]},
//   "kicad_happy": {"exempt": "kicad-happy-exempt.json", "grounds": []}, "port_labels": true}}
// Only the listed checks run. Metric levels and targets: tools/lib/gate-core.mjs.
// Waivers: <board>/gate-waivers.json, a list of {metric, to, reason, date}.
// The full tool output goes to <board>/.gate/ (not tracked).

import {execFile, execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync} from 'node:fs';
import {join, relative, dirname, resolve} from 'node:path';
import {root, kicadCli, kicadPython, modernPython} from './lib/env.mjs';
import {METRICS, passes, ratchet, metricsText, countFrom} from './lib/gate-core.mjs';

const run = promisify(execFile);
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const boardsDir = join(root, 'hardware-design/boards');

if (flag('--list')) {
  for (const b of readdirSync(boardsDir)) if (existsSync(join(boardsDir, b, 'gate.json'))) console.log(b);
  process.exit(0);
}
const board = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--baseline');
const dir = join(boardsDir, board ?? '');
if (!board || !existsSync(join(dir, 'gate.json'))) {
  console.error(`usage: node tools/gate.mjs <BOARD> [--ratchet] [--write] | --list   (no gate.json in ${relative(root, dir)})`);
  process.exit(2);
}
const cfg = JSON.parse(readFileSync(join(dir, 'gate.json'), 'utf8'));
const pcb = join(dir, `${cfg.project}.kicad_pcb`);
const sch = join(dir, `${cfg.project}.kicad_sch`);
const logDir = join(dir, '.gate');
mkdirSync(logDir, {recursive: true});
const tool = (name) => join(root, 'tools', name);
const spec = (name) => join(dir, name);
const sha = (file) => (existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null);
// One hash for all the sheets of the project folder (a hierarchical schematic has more than one file).
const shaSheets = (folder) => {
  const h = createHash('sha256');
  for (const f of readdirSync(folder).filter((n) => n.endsWith('.kicad_sch')).sort()) h.update(f).update(readFileSync(join(folder, f)));
  return h.digest('hex');
};

// A tool that exits non-zero still gives its output (the count is in the text). No output = the metric is null.
async function output(id, cmd, cmdArgs) {
  let out = '';
  try {
    out = (await run(cmd, cmdArgs, {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024})).stdout;
  } catch (e) {
    out = `${e.stdout ?? ''}\n[exit ${e.code}] ${String(e.stderr ?? e.message).slice(0, 2000)}`;
  }
  writeFileSync(join(logDir, `${id}.log`), out);
  return out;
}
const json = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const bySeverity = (items, severity) => (items ?? []).filter((v) => v.severity === severity).length;

const c = cfg.checks ?? {};
const jobs = {
  async erc() {
    const file = join(logDir, 'erc.json');
    await output('erc', kicadCli, ['sch', 'erc', '--format', 'json', '--severity-all', '--units', 'mm', '-o', file, sch]);
    const all = json(file)?.sheets?.flatMap((s) => s.violations ?? []);
    return {erc_errors: all ? bySeverity(all, 'error') : null, erc_warnings: all ? bySeverity(all, 'warning') : null};
  },
  async drc() {
    const file = join(logDir, 'drc.json');
    await output('drc', kicadCli, ['pcb', 'drc', '--schematic-parity', '--refill-zones', '--severity-all', '--format', 'json', '--units', 'mm', '-o', file, pcb]);
    const d = json(file);
    if (!d) return {drc_errors: null, drc_parity: null, drc_unconnected: null, drc_warnings: null};
    return {
      drc_errors: bySeverity(d.violations, 'error'),
      drc_parity: (d.schematic_parity ?? []).length,
      drc_unconnected: (d.unconnected_items ?? []).length,
      drc_warnings: bySeverity(d.violations, 'warning'),
    };
  },
  async planes() {
    return {planes_failures: countFrom(await output('planes', kicadPython, [tool('si_planes.py'), pcb, spec(c.planes)]), /(\d+) reference-plane failures/)};
  },
  async pairs() {
    return {pairs_failures: countFrom(await output('pairs', kicadPython, [tool('si_pairs.py'), pcb, spec(c.pairs)]), /si_pairs: \d+ PASS, (\d+) FAIL/)};
  },
  async viapads() {
    const allow = c.viapads?.allow ?? [];
    const out = await output('viapads', kicadPython, [tool('pcbtool.py'), 'viapads', pcb, ...(allow.length ? ['--allow', ...allow] : [])]);
    return {viapads: countFrom(out, /(\d+) vias in SMD pads/)};
  },
  async paths() {
    const out = await output('paths', kicadPython, [tool('pcbtool.py'), 'paths', pcb, spec(c.paths), '--limit', '2']);
    const ran = out.includes('power-path pairs below the design current');
    return {paths_low: ran ? out.split('\n').filter((l) => l.startsWith('LOW')).length : null};
  },
  async kicad_happy() {
    const a = [tool('kicad_happy_gate.py'), pcb, ...(c.kicad_happy?.exempt ? ['--exempt-file', spec(c.kicad_happy.exempt)] : []), ...(c.kicad_happy?.grounds ?? []).flatMap((g) => ['--ground', g])];
    const out = await output('kicad_happy', modernPython, a);
    const findings = countFrom(out, /(\d+) kicad-happy findings/);
    const stale = out.split('\n').filter((l) => l.startsWith('STALE exempt')).length;
    return {kicad_happy_findings: findings === null ? null : findings + stale};
  },
  async port_labels() {
    return {port_label_failures: countFrom(await output('port_labels', kicadPython, [tool('port_labels.py'), pcb]), /port_labels: .* (\d+) failures/)};
  },
};

const unknown = Object.keys(c).filter((k) => !(k in jobs));
if (unknown.length) {
  console.error(`gate: unknown check in gate.json: ${unknown.join(', ')}`);
  process.exit(2);
}
const results = await Promise.all(Object.keys(c).filter((k) => c[k]).map((k) => jobs[k]()));
const metrics = Object.assign({}, ...results);

console.log(`gate ${board}  (${relative(root, pcb)})`);
for (const [name, value] of Object.entries(metrics)) {
  const m = METRICS[name];
  const state = value === null ? 'DID NOT RUN' : m.target === undefined ? 'info' : value <= m.target ? 'ok' : 'open';
  console.log(`  ${name.padEnd(22)} ${String(value ?? '-').padStart(5)}  ${state}`);
}

const metricsFile = join(dir, 'gate-metrics.json');
const text = metricsText({board, pcbSha256: sha(pcb), schSha256: shaSheets(dirname(sch)), metrics});
let exit = 0;
if (flag('--ratchet')) {
  let before = null;
  const baseline = args.indexOf('--baseline');
  try {
    before = baseline >= 0
      ? JSON.parse(readFileSync(resolve(args[baseline + 1]), 'utf8')).metrics
      : JSON.parse(execFileSync('git', ['-C', root, 'show', `HEAD:${relative(root, metricsFile)}`], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']})).metrics;
  } catch {
    console.log('  ratchet: no gate-metrics.json in git HEAD; this run becomes the baseline');
  }
  const waivers = json(join(dir, 'gate-waivers.json')) ?? [];
  const r = ratchet(before, metrics, waivers);
  for (const l of r.improved) console.log(`  better   ${l}`);
  for (const l of r.waived) console.log(`  waived   ${l}`);
  for (const l of r.warnings) console.log(`  WARNING  ${l}`);
  for (const l of r.blocked) console.log(`  BLOCKED  ${l}`);
  // --strict: a soft regression also fails (tools/route_batch.mjs accepts a batch only when no gate is worse).
  if (r.blocked.length || (flag('--strict') && r.warnings.length)) exit = 1;
  console.log(r.blocked.length ? 'gate: regression. Fix it, or add a waiver with a reason to gate-waivers.json' : 'gate: no blocked regression');
} else {
  const p = passes(metrics);
  if (!p.ok) exit = 1;
  console.log(p.ok ? 'gate: PASS (all checks at target)' : `gate: NOT AT TARGET: ${p.open.join(', ')}`);
}
if (flag('--write')) writeFileSync(metricsFile, text);
process.exit(exit);
