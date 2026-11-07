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
//   --evidence-dir NEW_DIR   isolated evidence; do not publish the board's latest pointer
//   --changed       editing only: reuse completed checks with matching hashed inputs
//   --fresh         explicitly require fresh checks (the default); conflicts with --changed and --cache-dir
//   --cache-dir DIR commit hook: reuse and store completed checks whose per-check hashed inputs match (any mode
//                   but G5 and --fresh); a check reruns only when one of its own inputs changed
//   --findings-baseline FILE_OR_DIR   compare findings with explicit prior evidence
//
// gate.json: {"project": "cad/MC-MAIN/MC-MAIN", "checks": {"erc": true, "drc": true, "planes": "reference-planes.json",
//   "pairs": "diff-pairs.json", "paths": "current-paths.json", "viapads": {"allow": ["U1.9"]},
//   "kicad_happy": {"exempt": "kicad-happy-exempt.json", "grounds": []}, "port_labels": true, "rf": "rf-lines.json"}}
// Only the listed checks run. Metric levels and targets: tools/lib/gate-core.mjs.
// Ratchet waivers: {metric, from, to, reason, owner, date, expires, revision, inputFingerprint}.
// Waivers cannot make a target gate pass. Full tool output goes to isolated .gate/run-* directories.

import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, existsSync, readdirSync, renameSync, mkdirSync} from 'node:fs';
import {join, relative, dirname, resolve} from 'node:path';
import {root, kicadCli, kicadPython, happyRuntime, kicadShared, kicadConfig, pinnedRepos, TS_NODE} from './lib/env.mjs';
import {METRICS, CHECK_METRICS, passes, ratchet, metricsText, countFrom, validateConfig, expectedMetrics, pathFailures, BOARD_JSON_CHECKS, gateNeedsPcbnew} from './lib/gate-core.mjs';
import {runDirectory, runTool, readReport, checkedText, readHappyResult, gateEvent, measuredSpan} from './lib/gate-runtime.mjs';
import {gateChecks, gateInputs, fingerprint} from './lib/gate-inputs.mjs';
import {checkInputs, checkKey, restoreCheck, storeCheck} from './lib/check-cache.mjs';
import {loadFindingsBaseline, findingsDocument} from './lib/gate-findings.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const boardsDir = join(root, 'hardware-design/boards');

if (flag('--list')) {
  for (const b of readdirSync(boardsDir)) if (existsSync(join(boardsDir, b, 'gate.json'))) console.log(b);
  process.exit(0);
}
const board = args.find((a, i) => !a.startsWith('--') && !['--baseline','--config','--evidence-dir','--findings-baseline','--cache-dir'].includes(args[i - 1]));
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
const incremental = flag('--changed');
if (incremental && (flag('--fresh') || flag('--write') || cfg.stage === 'G5')) {
  console.error('gate: --changed is for editing; cannot combine with --fresh, --write or a G5 release gate'); process.exit(2);
}
const cacheDirArg = args.includes('--cache-dir') ? args[args.indexOf('--cache-dir') + 1] : null;
if (args.includes('--cache-dir') && (!cacheDirArg || cacheDirArg.startsWith('--') || flag('--fresh') || cfg.stage === 'G5')) {
  console.error('gate: --cache-dir needs a directory and cannot combine with --fresh or a G5 release gate'); process.exit(2);
}
// Hashed check reuse: --changed (editing, board cache) or --cache-dir (commit hook, given cache).
const reuse = incremental || Boolean(cacheDirArg);
const pcb = join(dir, `${cfg.project}.kicad_pcb`);
const sch = join(dir, `${cfg.project}.kicad_sch`);
const isolated = args.includes('--evidence-dir');
const evidenceArg = args[args.indexOf('--evidence-dir') + 1];
if (isolated && (!evidenceArg || evidenceArg.startsWith('--') || flag('--write'))) {
  console.error('gate: --evidence-dir requires a new directory and cannot use --write'); process.exit(2);
}
const logDir = isolated ? resolve(evidenceArg) : runDirectory(join(dir, '.gate'));
if (isolated) mkdirSync(logDir); // Refuse existing evidence, even an empty directory.
console.log(`gate evidence: ${relative(root, logDir)}`);
gateEvent(logDir, 'gate.start', {board, project: cfg.project, stage: 'preflight'});
const preflightSpan=measuredSpan('preflight','preflight');
gateEvent(logDir,'stage.start',preflightSpan.fields);
const tool = (name) => join(root, 'tools', name);
const spec = (name) => join(dir, name);
const sha = (file) => (existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null);
// One hash for all the sheets of the project folder (a hierarchical schematic has more than one file).
const shaSheets = (folder) => {
  if (!existsSync(folder)) return null;
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

const c = {...gateChecks(dir, cfg.checks)};
// Checks that read the board through board-json: they need no pcbnew, and their verdict follows the reader.
const boardChecks = BOARD_JSON_CHECKS;
const boardReader = join(process.env.PCB_TOOLCHAIN_ROOT || root, 'bin/iotroute-linux-x86_64');
// planes and pairs are checked by this binary, so a new one is a new key. A host that cannot find it gets a failed check, not a key.
const nativeChecker = k => {
  if (k!=='planes' && k!=='pairs') return [];
  if (process.env.IOTROUTE_BIN) return [process.env.IOTROUTE_BIN];
  try { return [execFileSync(process.execPath,[...TS_NODE,tool('lib/iotroute-bin.ts')],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()]; }
  catch { return []; }
};
const required = expectedMetrics(cfg);
const environment={configDir:kicadConfig,variables:{KICAD10_FOOTPRINT_DIR:join(kicadShared,'footprints'),KICAD10_SYMBOL_DIR:join(kicadShared,'symbols')},repositories:c.kicad_happy ? pinnedRepos.filter(r=>r.needed==='gate').map(r=>r.dir) : []};
const externalRoots={kicad:kicadShared,kicad_config:kicadConfig,...Object.fromEntries(pinnedRepos.map(r=>[r.name,r.dir]))};
const preflightErrors = [];
let findingsBaseline;
if (flag('--findings-baseline')) {
  const path=args[args.indexOf('--findings-baseline')+1];
  try {
    if (!path || path.startsWith('--')) throw new Error('a prior findings file or evidence directory is required');
    findingsBaseline=loadFindingsBaseline(path,board,cfg.project);
  } catch (error) { preflightErrors.push(`findings baseline: ${error.message}`); }
}
for (const [enabled,file] of [[c.erc,sch],[c.drc,pcb],...['planes','pairs','paths','rf','placement'].map(k=>[c[k],c[k] && spec(c[k])]),
  ...['exempt','return_planes'].map(k=>[c.kicad_happy?.[k],c.kicad_happy?.[k] && spec(c.kicad_happy[k])])]) {
  if (enabled && !existsSync(file)) preflightErrors.push(`missing required input: ${relative(root,file)}`);
}
let inputs;
try { inputs=gateInputs(root,board,configName,environment); }
catch (error) { preflightErrors.push(`input evidence: ${error.message}`);inputs={files:[]}; }
const versions = {};
const probes=[['kicad',kicadCli,['--version']],
  ...(gateNeedsPcbnew(c) ? [['pcbnew',kicadPython,['-c','import pcbnew; print(pcbnew.Version())']]] : [])];
for (const [name,cmd,args] of preflightErrors.length ? [] : probes) {
  gateEvent(logDir,'preflight.probe',{stage:'preflight',tool:name});
  const probeSpan=measuredSpan(`probe:${name}`,'startup');
  gateEvent(logDir,'stage.start',probeSpan.fields);
  try { versions[name] = execFileSync(cmd,args,{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(); }
  catch (error) { versions[name] = null;preflightErrors.push(`${name} version probe failed: ${error.message}`);break; }
  finally { gateEvent(logDir,'stage.end',probeSpan.end(versions[name]===null ? 'failed' : 'passed')); }
}
versions.node=process.version;
if(c.kicad_happy && !preflightErrors.length) {
  try{versions.kicad_happy_runtime=happyRuntime();}
  catch(error){preflightErrors.push(`kicad-happy runtime probe failed: ${error.message}`);}
}
// Optional router/advisory repositories are not executed by this gate. Probing
// them adds unrelated latency/failures and invalidates otherwise identical runs.
for(const repo of preflightErrors.length || !c.kicad_happy ? [] : pinnedRepos.filter(r=>r.needed==='gate')) {
  try{versions[repo.name]=execFileSync('git',['-C',repo.dir,'rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore'],env:Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_')))}).trim();}
  catch{versions[repo.name]=null;preflightErrors.push(`required repository unavailable: ${repo.name}`);}
  if (versions[repo.name] && !versions[repo.name].startsWith(repo.commit)) preflightErrors.push(`${repo.name} is not at pinned commit ${repo.commit}`);
}
gateEvent(logDir,'preflight.end',{stage:'preflight',status:preflightErrors.length ? 'failed' : 'passed',errors:preflightErrors});
gateEvent(logDir,'stage.end',preflightSpan.end(preflightErrors.length ? 'failed' : 'passed'));
const start = fingerprint(root,inputs.files,versions,externalRoots);
const jobs = {
  async placement() {
    return {placement_failures: countFrom(await output('placement', process.execPath, [...TS_NODE, tool('placement-check.ts'), board, spec(c.placement), pcb, join(logDir, 'placement-constraints.json')]), /placement: (\d+) FAIL/)};
  },
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
    const out = await output('planes', process.execPath, [...TS_NODE, tool('si_planes.ts'), pcb, spec(c.planes)]);
    for (const line of out.split('\n').filter(line => line.startsWith('WARN '))) console.log(`  ${line}`);
    return {planes_failures: countFrom(out, /(\d+) reference-plane failures/)};
  },
  async pairs() {
    return {pairs_failures: countFrom(await output('pairs', process.execPath, [...TS_NODE, tool('si_pairs.ts'), pcb, spec(c.pairs)]), /si_pairs: \d+ PASS, (\d+) FAIL/)};
  },
  async viapads() {
    const allow = c.viapads?.allow ?? [];
    const out = await output('viapads', process.execPath, [...TS_NODE, tool('pcbtool.ts'), 'viapads', pcb, ...(allow.length ? ['--allow', ...allow] : []),
      ...(c.viapads?.filled ? ['--filled'] : [])]);   // filled + capped via-in-pad (JLC POFV, 6+ layers; user 2026-10-29)
    return {viapads: countFrom(out, /(\d+) vias in SMD pads/)};
  },
  async paths() {
    const out = await output('paths', process.execPath, [...TS_NODE, tool('pcbtool.ts'), 'paths', pcb, spec(c.paths), '--limit', '2']);
    return {paths_low: pathFailures(out)};
  },
  async kicad_happy() {
    const file = join(logDir, 'kicad_happy.json');
    const a = [...TS_NODE, tool('kicad_happy_gate.ts'), pcb, '--result', file, ...(c.kicad_happy?.exempt ? ['--exempt-file', spec(c.kicad_happy.exempt)] : []), ...(c.kicad_happy?.grounds ?? []).flatMap((g) => ['--ground', g]), ...(c.kicad_happy?.return_planes ? ['--planes', spec(c.kicad_happy.return_planes)] : [])];
    const result = await runTool(logDir, 'kicad_happy', process.execPath, a);
    return {kicad_happy_findings: readHappyResult(file, result)};
  },
  // RF line rule (tools/rf_lines.ts + <board>/rf-lines.json, first used on CELLULAR 2026-10-09): GCPW width/gap, no via,
  // length, coplanar and reference ground, ground via fence.
  async rf() {
    return {rf_failures: countFrom(await output('rf', process.execPath, [...TS_NODE, tool('rf_lines.ts'), pcb, spec(c.rf)]), /rf_lines: \d+ PASS, (\d+) FAIL/)};
  },
  async port_labels() {
    return {port_label_failures: countFrom(await output('port_labels', process.execPath, [...TS_NODE, tool('port_labels.ts'), pcb]), /port_labels: .* (\d+) failures/)};
  },
};

const unknown = Object.keys(c).filter((k) => !(k in jobs));
if (unknown.length) {
  console.error(`gate: unknown check in gate.json: ${unknown.join(', ')}`);
  process.exit(2);
}
const checks = {};
const cache = {enabled:reuse,hits:0,misses:0,rejected:0};
const pendingCache = [];
const cacheDir = cacheDirArg ? resolve(cacheDirArg) : join(dir,'.gate/check-cache');
const scripts = {placement:'placement-check.ts',planes:'si_planes.ts',pairs:'si_pairs.ts',viapads:'pcbtool.ts',paths:'pcbtool.ts',kicad_happy:'kicad_happy_gate.ts',rf:'rf_lines.ts',port_labels:'port_labels.ts'};
function keyFor(k,files) {
  const names=['node','kicad',...(k==='kicad_happy' ? ['kicad_happy_runtime','kicad-happy'] : ['erc','drc','port_labels',...boardChecks].includes(k) ? [] : ['pcbnew'])];
  return checkKey({root,stage:k,files:checkInputs(root,files,k,scripts[k],environment.repositories),
    config:{project:cfg.project,stage:cfg.stage ?? 'G4',options:c[k]},externalRoots,
    versions:Object.fromEntries(names.filter(name=>name in versions).map(name=>[name,versions[name]])),
    commands:['erc','drc'].includes(k) ? [kicadCli] : k==='kicad_happy' ? [process.execPath,'git'] : k==='port_labels' ? [process.execPath] : boardChecks.includes(k) ? [process.execPath,kicadCli,...(existsSync(boardReader) ? [boardReader] : []),...nativeChecker(k)] : [kicadPython,kicadCli]});
}
async function execute(k) {
  let metrics,key,hit=false;
  if (reuse) {
    key=keyFor(k,inputs.files);
    const restored=restoreCheck(cacheDir,k,key.key,logDir);
    hit=restored.hit;
    if (hit) { metrics=restored.metrics;cache.hits++; }
    else { cache.misses++;if(restored.rejected) cache.rejected++; }
    gateEvent(logDir,hit ? 'cache.hit' : restored.rejected ? 'cache.reject' : 'cache.miss',
      {stage:k,key:key.key,...(restored.reason ? {cause:restored.reason} : {})});
  }
  if (!hit) metrics=await jobs[k]();
  const valid=CHECK_METRICS[k].every(name=>Number.isSafeInteger(metrics[name]) && metrics[name]>=0);
  const verdict=passes(metrics,CHECK_METRICS[k]);
  checks[k]={status:!valid ? 'error' : verdict.ok ? 'passed' : 'failed',metrics,cached:hit,
    ...(!valid ? {cause:'checker did not complete with valid evidence'} : {}),...(key ? {cache_key:key.key} : {})};
  gateEvent(logDir,'check.end',{stage:k,...checks[k],findings:verdict.open});
  if (reuse && valid && !hit) pendingCache.push({stage:k,key,metrics});
}
function block(k,cause) {
  const metrics=Object.fromEntries(CHECK_METRICS[k].map(name=>[name,null]));
  checks[k]={status:'blocked',metrics,cached:false,cause};
  gateEvent(logDir,'dependency.blocked',{stage:k,cause});
  gateEvent(logDir,'check.end',{stage:k,...checks[k],findings:[cause]});
}
const enabled=Object.keys(c).filter(k=>c[k]);
if (preflightErrors.length) for (const k of enabled) block(k,`preflight failed: ${preflightErrors.join('; ')}`);
else {
  await Promise.all(enabled.filter(k=>['erc','drc'].includes(k)).map(execute));
  const reasons=[];
  for (const k of ['erc','drc']) if (checks[k]?.status==='error') reasons.push(`${k}: invalid native report or failed invocation`);
  if (checks.drc?.metrics.drc_parity>0) reasons.push(`drc: ${checks.drc.metrics.drc_parity} schematic parity defects`);
  if (incremental && checks.drc?.metrics.drc_errors>0) reasons.push(`drc: ${checks.drc.metrics.drc_errors} errors block dependent editing checks`);
  const dependent=enabled.filter(k=>!['erc','drc'].includes(k));
  if (reasons.length) for (const k of dependent) block(k,reasons.join('; '));
  else await Promise.all(dependent.map(execute));
}
const metrics=Object.assign({},...enabled.map(k=>checks[k].metrics));
let finalFiles=inputs.files;
try { finalFiles=gateInputs(root,board,configName,environment).files; }
catch (error) { preflightErrors.push(`final input evidence: ${error.message}`); }
const provenance = fingerprint(root,finalFiles,versions,externalRoots);
const checkInputsChanged=reuse && Object.entries(checks).some(([stage,check])=>check.cache_key && keyFor(stage,finalFiles).key!==check.cache_key);
const changedDuringRun = provenance.input_sha256 !== start.input_sha256 || checkInputsChanged;
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
  // --strict: a soft regression also fails.
  if (r.blocked.length || (flag('--strict') && r.warnings.length)) exit = 1;
  console.log(r.blocked.length ? 'gate: regression. Fix it, or add a waiver with a reason to gate-waivers.json' : 'gate: no blocked regression');
} else {
  const p = passes(metrics,required);
  if (!p.ok) exit = 1;
  console.log(p.ok ? 'gate: PASS (all checks at target)' : `gate: NOT AT TARGET: ${p.open.join(', ')}`);
}
if (changedDuringRun || preflightErrors.length || Object.values(versions).some(v=>v===null) ||
    Object.values(checks).some(check=>check.status==='blocked' || check.status==='error') || checks.drc?.metrics.drc_parity>0) exit=1;
if (reuse && !changedDuringRun && !preflightErrors.length && !Object.values(versions).some(v=>v===null)) {
  for (const item of pendingCache) {
    const stored=storeCheck(cacheDir,item.stage,item.key,item.metrics,logDir);
    gateEvent(logDir,stored.stored ? 'cache.store' : 'cache.skip',{stage:item.stage,key:item.key.key,...stored});
  }
}
const findings=findingsDocument({board,project:cfg.project,evidenceDir:logDir,checks,baseline:findingsBaseline,preflightErrors,
  inputsValid:!changedDuringRun && !preflightErrors.length,inputSha256:provenance.input_sha256});
writeFileSync(join(logDir,'findings.json'),JSON.stringify(findings,null,2)+'\n');
writeFileSync(join(logDir,'gate-metrics.json'),text);
writeFileSync(join(logDir,'result.json'),JSON.stringify({exit,changedDuringRun,metrics,provenance,checks,cache,findings:'findings.json',preflightErrors},null,2)+'\n');
const atomicWrite = (file,content) => { const temp=`${file}.${process.pid}.tmp`; writeFileSync(temp,content); renameSync(temp,file); };
if (flag('--write') && !changedDuringRun && !preflightErrors.length) atomicWrite(metricsFile,text);
if (!isolated) atomicWrite(join(dir,'.gate/latest.json'),JSON.stringify({run:relative(join(dir,'.gate'),logDir),exit},null,2)+'\n');
gateEvent(logDir, 'gate.end', {exit, changedDuringRun, metrics});
process.exit(exit);
