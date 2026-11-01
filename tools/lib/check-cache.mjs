import {createHash, randomUUID} from 'node:crypto';
import {copyFileSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {basename, delimiter, dirname, isAbsolute, join, resolve} from 'node:path';
import {CHECK_METRICS, countFrom, pathFailures} from './gate-core.mjs';
import {fingerprint, gateTools} from './gate-inputs.mjs';
import {checkedText, readReport, readHappyResult} from './gate-runtime.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const encode = value => JSON.stringify(value);
const counts = (stage, metrics) => metrics && Object.keys(metrics).length === CHECK_METRICS[stage]?.length &&
  CHECK_METRICS[stage].every(name => Number.isSafeInteger(metrics[name]) && metrics[name] >= 0);
const safeName = name => typeof name === 'string' && name === basename(name) && /^[A-Za-z0-9_.-]+$/.test(name);
const requiredArtifacts = stage => [`${stage}.log`, ...(['erc','drc','kicad_happy'].includes(stage) ? [`${stage}.json`] : [])];

function artifactMetrics(folder, stage) {
  const log=readFileSync(join(folder,`${stage}.log`),'utf8');
  const footer=log.match(/\n\[exit (\d+)\]\s*$/);
  if (!footer) throw new Error('tool log has no completed exit footer');
  const result={code:Number(footer[1]),stdout:log.slice(0,footer.index),stderr:''};
  if (stage==='erc' || stage==='drc') {
    const report=readReport(join(folder,`${stage}.json`),stage,result);
    if (!report) throw new Error('invalid native report');
    const count=(items,severity)=>(items ?? []).filter(row=>row.severity===severity).length;
    if (stage==='erc') { const all=report.sheets.flatMap(sheet=>sheet.violations);return {erc_errors:count(all,'error'),erc_warnings:count(all,'warning')}; }
    return {drc_errors:count(report.violations,'error'),drc_warnings:count(report.violations,'warning'),drc_parity:report.schematic_parity.length,drc_unconnected:report.unconnected_items.length};
  }
  if (stage==='kicad_happy') return {kicad_happy_findings:readHappyResult(join(folder,'kicad_happy.json'),result)};
  const text=checkedText(result);
  const parsers={planes:()=>({planes_failures:countFrom(text,/(\d+) reference-plane failures/)}),
    pairs:()=>({pairs_failures:countFrom(text,/si_pairs: \d+ PASS, (\d+) FAIL/)}),
    viapads:()=>({viapads:countFrom(text,/(\d+) vias in SMD pads/)}),paths:()=>({paths_low:pathFailures(text)}),
    rf:()=>({rf_failures:countFrom(text,/rf_lines: \d+ PASS, (\d+) FAIL/)}),
    port_labels:()=>({port_label_failures:countFrom(text,/port_labels: .* (\d+) failures/)})};
  return parsers[stage]();
}

// Keep unrelated Python checker implementations out of a check's key. Shared
// gate adapters and all their JS imports remain conservative dependencies.
export function checkInputs(root, files, stage, script, repositories = []) {
  const allTools = new Set(gateTools(root));
  const selected = new Set(gateTools(root, script ? [join(root,'tools',script)] : []));
  return files.filter(file => {
    if (allTools.has(file) && file.endsWith('.py') && !selected.has(file)) return false;
    if (stage !== 'kicad_happy' && repositories.some(repo => file === repo || file.startsWith(repo + '/'))) return false;
    if (stage === 'erc' && (/\.kicad_(pcb|mod|dru)$/.test(file) || basename(file) === 'fp-lib-table')) return false;
    return true;
  });
}

const executableHashes = new Map();
function executable(command) {
  const candidate = command.includes('/') ? resolve(command) : (process.env.PATH ?? '').split(delimiter).map(p => join(p,command)).find(existsSync);
  if (!candidate) return {command, missing:true};
  const path = realpathSync(candidate);
  const stat = statSync(path);
  const identity = `${path}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  if (!executableHashes.has(identity)) executableHashes.set(identity, {path,sha256:digest(readFileSync(path))});
  return executableHashes.get(identity);
}

export function checkKey({root,files,stage,config,versions,externalRoots,commands}) {
  const inputs = fingerprint(root,files,versions,externalRoots);
  // Native library resolution, Python import resolution and subprocess lookup
  // are executable inputs too. Never key on elapsed time or evidence paths.
  // The checkout path is not an input (the commit hook gates a temporary snapshot): file contents are keyed above.
  const rawEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(KICAD|IOT_LAB$|PYTHON|PATH$|LANG$|LC_|DYLD_|LD_LIBRARY_PATH$)/.test(key)).sort(([a],[b]) => a.localeCompare(b)));
  // Paths are compared in real form (macOS /var vs /private/var), part by part for PATH-like values.
  const real = path => {
    if (!isAbsolute(path)) return path;
    let base = path, rest = '';
    while (!existsSync(base) && dirname(base) !== base) { rest = join(basename(base), rest); base = dirname(base); }
    return existsSync(base) ? join(realpathSync(base), rest) : path;
  };
  const realRoot = real(root);
  // Whole path components only: /tmp/a-modules must not alias to <root>-modules for root /tmp/a.
  const unroot = value => value.split(delimiter).map(part => {
    const path = real(part);
    return path === realRoot ? '<root>' : path.startsWith(realRoot + '/') ? '<root>' + path.slice(realRoot.length) : path;
  }).join(delimiter);
  const environment = Object.fromEntries(Object.entries(rawEnvironment).map(([key,value]) => [key,unroot(value)]));
  const executables = commands.map(executable).map(e => e.path ? {...e,path:unroot(e.path)} : e);
  const descriptor = {schema_version:1,stage,config,inputs,environment,executables};
  return {key:digest(encode(descriptor)),descriptor};
}

function receiptAt(folder, stage, key) {
  const text = readFileSync(join(folder,'receipt.json'),'utf8');
  if (readFileSync(join(folder,'receipt.sha256'),'utf8').trim() !== digest(text)) throw new Error('receipt hash mismatch');
  const receipt = JSON.parse(text);
  if (receipt.schema_version !== 1 || receipt.completed !== true || receipt.stage !== stage || receipt.key !== key ||
      !counts(stage,receipt.metrics) || !Array.isArray(receipt.artifacts)) throw new Error('incomplete or incompatible receipt');
  if (digest(encode(receipt.descriptor)) !== key) throw new Error('receipt input key mismatch');
  const names = receipt.artifacts.map(a => a.name);
  if (new Set(names).size !== names.length || requiredArtifacts(stage).some(name => !names.includes(name))) throw new Error('missing required artifact');
  for (const artifact of receipt.artifacts) {
    if (!safeName(artifact.name)) throw new Error('invalid artifact path');
    const bytes = readFileSync(join(folder,artifact.name));
    if (bytes.length !== artifact.bytes || digest(bytes) !== artifact.sha256) throw new Error(`artifact hash mismatch: ${artifact.name}`);
  }
  const derived=artifactMetrics(folder,stage);
  if (!counts(stage,derived) || CHECK_METRICS[stage].some(name=>derived[name]!==receipt.metrics[name])) throw new Error('artifact verdict does not match receipt');
  return receipt;
}

export function restoreCheck(cacheDir, stage, key, evidenceDir) {
  const folder = join(cacheDir,stage,key);
  if (!existsSync(folder)) return {hit:false,reason:'no completed receipt'};
  try {
    const receipt = receiptAt(folder,stage,key);
    for (const artifact of receipt.artifacts) copyFileSync(join(folder,artifact.name),join(evidenceDir,artifact.name),constants.COPYFILE_EXCL);
    return {hit:true,metrics:receipt.metrics,receipt:join(folder,'receipt.json')};
  } catch (error) { return {hit:false,rejected:true,reason:error.message}; }
}

// Publication happens only after the gate confirms its inputs stayed stable.
// A nonzero findings count is completed evidence; null/blocked metrics are not.
export function storeCheck(cacheDir, stage, {key,descriptor}, metrics, evidenceDir) {
  if (!counts(stage,metrics)) return {stored:false,reason:'check did not complete'};
  const parent = join(cacheDir,stage);mkdirSync(parent,{recursive:true});
  const pending = join(parent,`.pending-${randomUUID()}`);mkdirSync(pending);
  const target = join(parent,key);
  try {
    const artifacts = requiredArtifacts(stage).map(name => {
      const bytes = readFileSync(join(evidenceDir,name));
      writeFileSync(join(pending,name),bytes);
      return {name,bytes:bytes.length,sha256:digest(bytes)};
    });
    const text = encode({schema_version:1,completed:true,stage,key,descriptor,metrics,artifacts}) + '\n';
    writeFileSync(join(pending,'receipt.json'),text);writeFileSync(join(pending,'receipt.sha256'),digest(text)+'\n');
    receiptAt(pending,stage,key);
    if (existsSync(target)) {
      try { receiptAt(target,stage,key); return {stored:false,reason:'receipt already published'}; }
      catch { rmSync(target,{recursive:true,force:true}); }
    }
    renameSync(pending,target);
    return {stored:true,receipt:join(target,'receipt.json')};
  } catch (error) { return {stored:false,reason:error.message}; }
  finally { rmSync(pending,{recursive:true,force:true}); }
}
