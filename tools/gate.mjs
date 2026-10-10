#!/usr/bin/env node
// One gate runner for all boards. It reads hardware-design/boards/<BOARD>/gate.json and runs the standard checks.
//
//   node tools/gate.mjs <BOARD>             run the checks, print the table; exit 1 when a check is not at its target
//   node tools/gate.mjs <BOARD> --ratchet   compare with gate-metrics.json of git HEAD; exit 1 only on a blocked regression
//   node tools/gate.mjs <BOARD> --write     also write <board>/gate-metrics.json (tracked: no time, no absolute path)
//   node tools/gate.mjs <BOARD> --ratchet --baseline FILE   compare with a metrics file in place of git HEAD
//   --strict (with --ratchet): a WARNING also gives exit 1
//   --config NAME    use <board>/NAME in place of gate.json (for example gate-6layer.json for a candidate)
//   node tools/gate.mjs --list              the boards that have a gate.json
//
// gate.json: {"project": "cad/MC-MAIN/MC-MAIN", "checks": {"erc": true, "drc": true, "planes": "reference-planes.json",
//   "pairs": "diff-pairs.json", "paths": "current-paths.json", "viapads": {"allow": ["U1.9"]},
//   "kicad_happy": {"exempt": "kicad-happy-exempt.json", "grounds": []}, "port_labels": true, "rf": "rf-lines.json"}}
// Only the listed checks run. Metric levels and targets: tools/lib/gate-core.mjs.
// Ratchet waivers: {metric, from, to, reason, owner, date, expires, revision, inputFingerprint}.
// Waivers cannot make a target gate pass. Full tool output goes to isolated .gate/run-* directories.

import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, existsSync, readdirSync, renameSync} from 'node:fs';
import {join, relative, dirname, resolve} from 'node:path';
import {root, kicadCli, kicadPython, modernPython, kicadShared, kicadConfig, pinnedRepos} from './lib/env.mjs';
import {METRICS, passes, ratchet, metricsText, countFrom, validateConfig, expectedMetrics, pathFailures} from './lib/gate-core.mjs';
import {runDirectory, runTool, readReport, checkedText, readHappyResult} from './lib/gate-runtime.mjs';
import {gateInputs, fingerprint} from './lib/gate-inputs.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const boardsDir = join(root, 'hardware-design/boards');

if (flag('--list')) {
  for (const b of readdirSync(boardsDir)) if (existsSync(join(boardsDir, b, 'gate.json'))) console.log(b);
  process.exit(0);
}
const board = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--baseline' && args[i - 1] !== '--config');
// --config NAME: another gate file in the board folder (a candidate with another stackup). Default gate.json.
const configName = args.includes('--config') ? args[args.indexOf('--config') + 1] : 'gate.json';
const dir = join(boardsDir, board ?? '');
if (!board || !existsSync(join(dir, configName))) {
  console.error(`usage: node tools/gate.mjs <BOARD> [--ratchet] [--write] | --list   (no gate.json in ${relative(root, dir)})`);
  process.exit(2);
}
const cfg = JSON.parse(readFileSync(join(dir, configName), 'utf8'));
const configErrors = validateConfig(cfg);
if (configErrors.length) { console.error(configErrors.join('\n')); process.exit(2); }
const pcb = join(dir, `${cfg.project}.kicad_pcb`);
const sch = join(dir, `${cfg.project}.kicad_sch`);
const logDir = runDirectory(join(dir, '.gate'));
console.log(`gate evidence: ${relative(root, logDir)}`);
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
async function output(id, cmd, cmdArgs) { return checkedText(await runTool(logDir,id,cmd,cmdArgs)); }
const json = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const bySeverity = (items, severity) => (items ?? []).filter((v) => v.severity === severity).length;

const c = cfg.checks ?? {};
const required = expectedMetrics(cfg);
const environment={configDir:kicadConfig,variables:{KICAD10_FOOTPRINT_DIR:join(kicadShared,'footprints'),KICAD10_SYMBOL_DIR:join(kicadShared,'symbols')},repositories:pinnedRepos.filter(r=>r.needed==='gate').map(r=>r.dir)};
const externalRoots={kicad:kicadShared,kicad_config:kicadConfig,...Object.fromEntries(pinnedRepos.map(r=>[r.name,r.dir]))};
const inputs = gateInputs(root,board,configName,environment);
const versions = {};
for (const [name,cmd,args] of [['kicad',kicadCli,['--version']],['pcbnew',kicadPython,['-c','import pcbnew; print(pcbnew.Version())']],['python',modernPython,['--version']]]) {
  try { versions[name] = execFileSync(cmd,args,{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(); }
  catch { versions[name] = null; }
}
versions.node=process.version;
for(const repo of pinnedRepos) {
  try{versions[repo.name]=execFileSync('git',['-C',repo.dir,'rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore'],env:Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_')))}).trim();}
  catch{if(repo.needed==='gate') versions[repo.name]=null;}
}
const start = fingerprint(root,inputs.files,versions,externalRoots);
const jobs = {
  async erc() {
    const file = join(logDir, 'erc.json');
    const result = await runTool(logDir,'erc', kicadCli, ['sch', 'erc', '--format', 'json', '--severity-all', '--units', 'mm', '-o', file, sch]);
    const all = readReport(file,'erc',result)?.sheets.flatMap(s=>s.violations);
    return {erc_errors: all ? bySeverity(all, 'error') : null, erc_warnings: all ? bySeverity(all, 'warning') : null};
  },
  async drc() {
    const file = join(logDir, 'drc.json');
    const result = await runTool(logDir,'drc', kicadCli, ['pcb', 'drc', '--schematic-parity', '--refill-zones', '--severity-all', '--format', 'json', '--units', 'mm', '-o', file, pcb]);
    const d = readReport(file,'drc',result);
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
    return {paths_low: pathFailures(out)};
  },
  async kicad_happy() {
    const file = join(logDir, 'kicad_happy.json');
    const a = [tool('kicad_happy_gate.py'), pcb, '--result', file, ...(c.kicad_happy?.exempt ? ['--exempt-file', spec(c.kicad_happy.exempt)] : []), ...(c.kicad_happy?.grounds ?? []).flatMap((g) => ['--ground', g])];
    const result = await runTool(logDir, 'kicad_happy', modernPython, a);
    return {kicad_happy_findings: readHappyResult(file, result)};
  },
  // RF line rule (tools/rf_lines.py + <board>/rf-lines.json, first used on CELLULAR 2026-10-09): GCPW width/gap, no via,
  // length, coplanar and reference ground, ground via fence.
  async rf() {
    return {rf_failures: countFrom(await output('rf', kicadPython, [tool('rf_lines.py'), pcb, spec(c.rf)]), /rf_lines: \d+ PASS, (\d+) FAIL/)};
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
const provenance = fingerprint(root,gateInputs(root,board,configName,environment).files,versions,externalRoots);
const changedDuringRun = provenance.input_sha256 !== start.input_sha256;
if (changedDuringRun) console.error('gate: inputs changed during run; evidence is invalid');

console.log(`gate ${board}  (${relative(root, pcb)})`);
for (const [name, value] of Object.entries(metrics)) {
  const m = METRICS[name];
  const state = value === null ? 'DID NOT RUN' : m.target === undefined ? 'info' : value <= m.target ? 'ok' : 'open';
  console.log(`  ${name.padEnd(22)} ${String(value ?? '-').padStart(5)}  ${state}`);
}

const metricsFile = join(dir, 'gate-metrics.json');
const text = metricsText({board, pcbSha256: sha(pcb), schSha256: shaSheets(dirname(sch)), metrics, provenance});
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
  const r = ratchet(before, metrics, waivers, {required,revision:cfg.project,inputFingerprint:provenance.input_sha256});
  for (const l of r.improved) console.log(`  better   ${l}`);
  for (const l of r.waived) console.log(`  waived   ${l}`);
  for (const l of r.warnings) console.log(`  WARNING  ${l}`);
  for (const l of r.blocked) console.log(`  BLOCKED  ${l}`);
  // --strict: a soft regression also fails (tools/route_batch.mjs accepts a batch only when no gate is worse).
  if (r.blocked.length || (flag('--strict') && r.warnings.length)) exit = 1;
  console.log(r.blocked.length ? 'gate: regression. Fix it, or add a waiver with a reason to gate-waivers.json' : 'gate: no blocked regression');
} else {
  const p = passes(metrics,required);
  if (!p.ok) exit = 1;
  console.log(p.ok ? 'gate: PASS (all checks at target)' : `gate: NOT AT TARGET: ${p.open.join(', ')}`);
}
if (changedDuringRun || Object.values(versions).some(v=>v===null)) exit=1;
writeFileSync(join(logDir,'gate-metrics.json'),text);
writeFileSync(join(logDir,'result.json'),JSON.stringify({exit,changedDuringRun,metrics,provenance},null,2)+'\n');
const atomicWrite = (file,content) => { const temp=`${file}.${process.pid}.tmp`; writeFileSync(temp,content); renameSync(temp,file); };
if (flag('--write') && !changedDuringRun) atomicWrite(metricsFile,text);
atomicWrite(join(dir,'.gate/latest.json'),JSON.stringify({run:relative(join(dir,'.gate'),logDir),exit},null,2)+'\n');
process.exit(exit);
