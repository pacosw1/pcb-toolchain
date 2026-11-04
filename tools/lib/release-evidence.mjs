import {readFileSync,readdirSync,lstatSync,existsSync} from 'node:fs';
import {join,resolve,relative,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {gateInputs,fingerprint,gateTools} from './gate-inputs.mjs';
import {passes,expectedMetrics,validateConfig} from './gate-core.mjs';
import {readReport} from './gate-runtime.mjs';
import {readPopulation,parseNative,children,single,properties} from './kicad-population.mjs';
import {parseCsv} from './csv.mjs';
import {gateConfigPath,releaseRecipe,requireRelease} from './board-release.mjs';

export {gateConfigPath,releaseRecipe,requireRelease};

export const sha256 = value => createHash('sha256').update(value).digest('hex');
const need=(condition,message)=>{if(!condition)throw new Error(message);};
const json=path=>JSON.parse(readFileSync(path,'utf8'));
export function probeReleaseTools(paths) {
 const probe=(cmd,args)=>execFileSync(cmd,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:15000}).trim();
 const tools={kicad:probe(paths.kicadCli,['--version']),pcbnew:probe(paths.kicadPython,['-c','import pcbnew; print(pcbnew.Version())']),python:probe(paths.modernPython,['--version']),node:process.version};
 for(const repo of paths.pinnedRepos.filter(r=>r.needed==='gate'))tools[repo.name]=probe('git',['-C',repo.dir,'rev-parse','HEAD']);
 return tools;
}

// Validate the actual completed invocation, current native/tool inputs and parsed
// reports. A clean report without a successful process is never release evidence.
function completedGate(root,board,gateDir,environment={},externalRoots={},currentTools,release=true) {
 need(/^[A-Z0-9-]+$/.test(board??''),'board required');
 const input=gateInputs(root,board,'gate.json',environment),cfg=input.cfg;
 need(!validateConfig(cfg).length,'invalid gate configuration');
 const result=json(join(gateDir,'result.json'));
 need([0,1].includes(result.exit) && result.changedDuringRun===false && result.metrics && typeof result.metrics==='object','gate invocation is incomplete or inputs changed');
 if(release)need(result.exit===0 && passes(result.metrics,expectedMetrics(cfg)).ok,'gate is not at release targets');
 need(result.provenance?.tools && Object.values(result.provenance.tools).every(v=>typeof v==='string' && v.length),'gate tool provenance missing');
 if(currentTools)need(JSON.stringify(Object.entries(currentTools).sort())===JSON.stringify(Object.entries(result.provenance.tools).sort()),'gate tool versions changed or are incomplete');
 const current=fingerprint(root,input.files,result.provenance.tools,externalRoots);
 need(current.input_sha256===result.provenance.input_sha256,'gate inputs have changed; run the gate again');
 const events=readFileSync(join(gateDir,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 const start=events.find(e=>e.type==='gate.start'),end=events.at(-1);
 need(start?.board===board && start.project===cfg.project && end?.type==='gate.end' && end.exit===result.exit && end.changedDuringRun===false,'gate lifecycle evidence is incomplete or belongs to another project');
 let processesClean=true;
 for(const [stage,enabled] of Object.entries(cfg.checks))if(enabled) {
  const checks=events.filter(e=>e.type==='check.end' && e.stage===stage),exits=events.filter(e=>e.type==='tool.exit' && e.stage===stage);
  const clean=checks.length===1 && checks[0].status==='passed' && exits.length===1 && exits[0].code===0;
  if(release)need(clean,`gate stage ${stage} did not complete successfully`);
  else need(checks.length===1 && exits.length===1 && ['passed','failed','error'].includes(checks[0].status),`gate stage ${stage} observation incomplete`);
  processesClean=processesClean && clean;
 }
 const erc=readReport(join(gateDir,'erc.json'),'erc',{code:0}),drc=readReport(join(gateDir,'drc.json'),'drc',{code:0});
 need(erc && drc,'missing or malformed native gate reports');
 const violations=erc.sheets.flatMap(s=>s.violations);
 need(violations.filter(v=>v.severity==='error').length===result.metrics.erc_errors &&
  drc.violations.filter(v=>v.severity==='error').length===result.metrics.drc_errors &&
  drc.schematic_parity.length===result.metrics.drc_parity && drc.unconnected_items.length===result.metrics.drc_unconnected,'native reports disagree with gate metrics');
 const reports=Object.fromEntries(['result.json','erc.json','drc.json','events.jsonl'].map(p=>[p,sha256(readFileSync(join(gateDir,p)))]));
 return {board,project:cfg.project,input_sha256:current.input_sha256,reports,token:sha256(JSON.stringify({board,project:cfg.project,input:current.input_sha256,reports})),result,
  at_targets:result.exit===0 && processesClean && passes(result.metrics,expectedMetrics(cfg)).ok};
}

export function verifyReleaseGate(...args) {return completedGate(...args);}
// Diagnostic reuse preserves the failed verdict. It cannot satisfy the release
// entrypoint or the board audit's `ok` condition; unchanged checks are not rerun.
export function readGateObservation(root,board,gateDir,environment={},externalRoots={},currentTools) {
 need(currentTools,'diagnostic observation requires current tool version checks');
 return completedGate(root,board,gateDir,environment,externalRoots,currentTools,false);
}

export function fileHashes(directory) {
 const files={};
 function walk(dir) {for(const name of readdirSync(dir).sort()) {
  const path=join(dir,name),stat=lstatSync(path);need(!stat.isSymbolicLink(),'release artifacts may not be symbolic links');
  if(stat.isDirectory())walk(path);else {need(stat.isFile(),'unsupported release artifact');files[relative(directory,path)]=sha256(readFileSync(path));}
 }}walk(directory);return files;
}

const BOARD_CHECKS={
 // A board audit report: {board, ok, passed, total, checks[]}, every check ok.
 audit:(board,c,stage)=>{const report=json(join(stage,c.report));
  return report.board===board && report.ok===true && report.passed===report.total && report.total>0 &&
   report.checks?.length===report.total && report.checks.every(x=>x.ok===true) ? {checks:report.total} : null;},
 // A layout check JSON report with an empty fails list.
 no_fails:(board,c,stage)=>{const report=json(join(stage,c.report));return Array.isArray(report.fails) && !report.fails.length ? {} : null;},
 // A log that holds every required text and no line that matches forbid.
 log:(board,c,stage)=>{const log=readFileSync(join(stage,c.report),'utf8');
  return (c.require??[]).every(t=>log.includes(t)) && !(c.forbid && new RegExp(c.forbid,'m').test(log)) ? {} : null;},
};
// Board-specific staged evidence, as the "board_checks" list of the release recipe names it.
export function verifyBoardChecks(board,stage,root) {
 need(root,'verifyBoardChecks needs the project root');
 const checks=requireRelease(root,board).board_checks??[];
 if(!checks.length)return {status:'covered_by_existing_board_workflow'};
 let extra={};const reports={};
 for(const c of checks) {
  const fn=BOARD_CHECKS[c.kind];need(fn,`${board} release board_checks: unknown kind ${c.kind}`);
  const result=fn(board,c,stage);need(result,`${board} board-specific ${c.label} is incomplete or failed`);
  extra={...extra,...result};reports[c.report]=sha256(readFileSync(join(stage,c.report)));
 }
 return {status:'passed',...extra,reports};
}

export function releaseInputs(root,board) {
 const recipe=requireRelease(root,board);
 const files=['tools/fab-workflow.sh','tools/release-recipe.mjs','tools/check-release-gate.mjs','tools/check-release-fab.mjs','tools/lib/release-evidence.mjs',
  'tools/lib/kicad-population.mjs','tools/lib/csv.mjs','tools/gerber_netcheck.py','tools/check-fab-zip.mjs','tools/pack-fab.py','tools/publish-release.py','tools/pcb_timing.py',recipe.maker,...(recipe.inputs??[])];
 // The board gate configuration holds the recipe, so it is a release input too.
 const closure=[...gateTools(root,files.map(p=>join(root,p))),gateConfigPath(root,board)];
 return Object.fromEntries(closure.sort().map(p=>[relative(root,p),existsSync(p)?sha256(readFileSync(p)):null]));
}

export function verifyFab(root,board,fab) {
 const recipe=requireRelease(root,board);
 const dir=join(root,'hardware-design/boards',board),cfg=json(join(dir,'gate.json'));
 const project=relative(root,resolve(dir,cfg.project)),name=basename(project),native=readPopulation(root,project);
 const tree=parseNative(readFileSync(join(root,project+'.kicad_pcb'),'utf8'));
 const poses=new Map(children(tree,'footprint').map(n=>{const at=single(n,'at'),attrs=single(n,'attr')?.slice(1)??[];
  return [properties(n).Reference,{x:Number(at?.[1]),y:-Number(at?.[2]),rotation:((Number(at?.[3]??0)%360)+360)%360,
   side:single(n,'layer')?.[1]==='F.Cu'?'Top':'Bottom',no_pos:attrs.includes('exclude_from_pos_files')}];}));
 const copperNames=recipe.copper??single(tree,'layers').slice(1).filter(x=>Array.isArray(x)&&x[2]==='signal').map(x=>x[1].replaceAll('.','_'));
 for(const layer of [...copperNames,'F_Mask','B_Mask','F_Paste','B_Paste','F_Silkscreen','B_Silkscreen','Edge_Cuts']) {
  // KiCad normalizes SilkS output names to Silkscreen (older versions lower case).
  const candidates=[`${name}-${layer}.gbr`,`${name}-${layer.toLowerCase()}.gbr`];
  const path=candidates.map(p=>join(fab,'gerber',p)).find(existsSync);
  need(path && readFileSync(path).length>0,`missing/empty fabrication layer ${layer}`);
 }
 for(const suffix of ['PTH.drl','NPTH.drl'])need(existsSync(join(fab,'gerber',`${name}-${suffix}`)),`missing ${suffix}`);
 need(existsSync(join(fab,`${name}-gerber.zip`)), 'missing fabrication ZIP');
 const variants=recipe.variants?json(join(dir,'variants.json')):null;
 if(variants)need(JSON.stringify(variants.variants)===JSON.stringify(recipe.variants),'variant names differ from release recipe');
 const populations={};
 for(const population of recipe.variants??['DEFAULT']) {
  const stem=name+(population==='DEFAULT'?'':'-'+population),bomPath=join(fab,stem+'-BOM-JLC.csv'),cplPath=join(fab,stem+'-CPL-JLC.csv');
  const bom=parseCsv(readFileSync(bomPath,'utf8')),cpl=parseCsv(readFileSync(cplPath,'utf8'));
  need(bom.shift()?.join('|')==='Comment|Designator|Footprint|LCSC Part #','invalid assembly BOM header');
  need(cpl.shift()?.join('|')==='Designator|Mid X|Mid Y|Layer|Rotation','invalid CPL header');
  const expected=new Map([...native.symbols].filter(([ref,p])=>p.in_bom && p.on_board && p.footprint && (variants?(variants.fit[ref]??[]).includes(population):!p.dnp)));
  const seen=new Map();
  for(const row of bom) {
   need(row.length===4 && /^C\d+$/.test(row[3]),'BOM rows require one exact LCSC and land identity; heterogeneous grouped rows are invalid');
   for(const ref of row[1].split(',').map(s=>s.trim())) {
    const part=expected.get(ref),pcb=native.footprints.get(ref);
    need(part && !seen.has(ref) && part.lcsc===row[3] && part.footprint===row[2] && pcb?.lcsc===part.lcsc && pcb.footprint===part.footprint && !pcb.excluded && pcb.dnp===part.dnp,`BOM/native identity or population mismatch: ${population}/${ref}`);
    seen.set(ref,row[3]);
   }
  }
  need(seen.size===expected.size && seen.size>0,`BOM missing fitted population: ${population}`);
  const placed=new Set();
  for(const row of cpl) {
   const [ref,x,y,side,angle]=row,p=poses.get(ref);
   const numeric=v=>/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:mm)?$/.test(v??'')?Number.parseFloat(v):NaN;
   need(row.length===5 && seen.has(ref) && !placed.has(ref) && p && !p.no_pos,`CPL extra/duplicate/nonplaced reference: ${population}/${ref}`);
   // Existing exporters use 0.001 mm precision. This is a serialization tolerance,
   // not a new electrical or mechanical acceptance threshold.
   need(Math.abs(numeric(x)-p.x)<=0.001 && Math.abs(numeric(y)-p.y)<=0.001 && side===p.side &&
    Number.isFinite(numeric(angle)) && numeric(angle)>=0 && numeric(angle)<360 && Math.abs(numeric(angle)-p.rotation)<=0.001,`CPL pose/side/rotation differs from native PCB: ${population}/${ref}`);
   placed.add(ref);
  }
  need([...seen.keys()].every(ref=>placed.has(ref)),`CPL missing fitted placements: ${population}`);
  populations[population]={bom:basename(bomPath),bom_sha256:sha256(readFileSync(bomPath)),cpl:basename(cplPath),cpl_sha256:sha256(readFileSync(cplPath)),references:Object.fromEntries(seen),placements:placed.size};
 }
 return {board,revision:recipe.revision??null,project,native_sources:native.sources,populations,
  rotation_scope:'CPL matches KiCad pose only; supplier package orientation requires attributable assembly review'};
}
