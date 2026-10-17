import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,chmodSync,existsSync,readdirSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

function fixture(t) {
 const root=mkdtempSync(join(tmpdir(),'gate-cli-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(p,v)=>{mkdirSync(join(root,p,'..'),{recursive:true});writeFileSync(join(root,p),v);};
 const source=fileURLToPath(new URL('../..',import.meta.url));
 for(const p of ['tools/gate.mjs','tools/lib/env.mjs','tools/lib/env-paths.mjs','tools/lib/gate-core.mjs','tools/lib/gate-runtime.mjs','tools/lib/gate-inputs.mjs','tools/lib/check-cache.mjs','tools/lib/gate-findings.mjs']) {mkdirSync(join(root,p,'..'),{recursive:true});copyFileSync(join(source,p),join(root,p));}
 const base='hardware-design/boards/X/';
 put(base+'gate.json',JSON.stringify({project:'cad/X',checks:{erc:true,drc:true,paths:'current-paths.json',viapads:{},kicad_happy:{},port_labels:true}}));
 put(base+'cad/X.kicad_pcb','original PCB');put(base+'cad/X.kicad_sch','original SCH');
 put(base+'current-paths.json','{}');
 put('bin/fake-tool',`#!${process.execPath}
import fs from 'node:fs';import path from 'node:path';
const a=process.argv.slice(2);
if(a.includes('--version') || a[0]==='-c'){console.log('10.0.6');process.exit(0);}
if(a[0]==='sch' || a[0]==='pcb') {
 const out=a[a.indexOf('-o')+1];
 if(a[0]==='sch') fs.writeFileSync(out,JSON.stringify({sheets:[{violations:[]}]}));
 else {fs.writeFileSync(out,JSON.stringify({violations:process.env.GATE_TEST_DRC_OPEN ? [{type:'clearance',severity:'error',description:'clearance open',items:[]}] : [],schematic_parity:process.env.GATE_TEST_PARITY ? [{type:'missing_footprint',description:'missing U1'}] : [],unconnected_items:[]}));
  if(process.env.GATE_TEST_MUTATE) fs.writeFileSync(a.at(-1),'changed PCB');
  if(process.env.GATE_TEST_MUTATE_TOOL) fs.appendFileSync(process.argv[1],'\\n// runtime changed during check');
  if(process.env.GATE_TEST_DRC_FAIL) process.exit(2);
 }process.exit(0);
}
const script=path.basename(a[0]);
if(script==='si_planes.py'){console.log('WARN unproved-fastest-edge F.Cu /SIG: missing source\\n0 reference-plane failures');process.exit(0);}
if(script==='kicad_happy_gate.py') {fs.writeFileSync(a[a.indexOf('--result')+1],JSON.stringify({schema_version:1,completed:true,findings:0,stale_exemptions:0,exit:0}));process.exit(0);}
if(script==='port_labels.py'){console.log('port_labels: 0 checked, 0 failures');process.exit(0);}
if(a[1]==='viapads'){console.log('0 vias in SMD pads');process.exit(0);}
if(a[1]==='paths'){console.log('0 power-path pairs below the design current\\n0 supply nets not covered');process.exit(0);}
process.exit(2);
`);
 chmodSync(join(root,'bin/fake-tool'),0o755);
 mkdirSync(join(root,'happy'),{recursive:true});
 const git=args=>execFileSync('git',['-C',join(root,'happy'),...args],{stdio:'ignore'});
 git(['init','-q']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','fixture']);
 const pin=execFileSync('git',['-C',join(root,'happy'),'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const envModule=join(root,'tools/lib/env.mjs');writeFileSync(envModule,readFileSync(envModule,'utf8').replace("commit: 'a6bba1a'",`commit: '${pin}'`));
 const env={...process.env,KICAD_CLI:join(root,'bin/fake-tool'),KICAD_PYTHON:join(root,'bin/fake-tool'),PYTHON_MODERN:join(root,'bin/fake-tool'),KICAD_HAPPY_DIR:join(root,'happy'),KRT_DIR:join(root,'absent'),KRPT_DIR:join(root,'absent'),KICAD_CONFIG_HOME:join(root,'config')};
 const run=extra=>{try{execFileSync(process.execPath,[join(root,'tools/gate.mjs'),'X','--write'],{cwd:root,env:{...env,...extra},stdio:'pipe'});return 0;}catch(error){return error.status;}};
 const result=()=>{const dir=join(root,base,'.gate');const latest=JSON.parse(readFileSync(join(dir,'latest.json')));return JSON.parse(readFileSync(join(dir,latest.run,'result.json')));};
 return {root,put,base,run,result,env};
}
test('CLI shows report-only timing warnings without increasing plane failures',t=>{
 const {root,put,base,env,result}=fixture(t);
 const cfg=JSON.parse(readFileSync(join(root,base,'gate.json')));
 cfg.checks.planes='reference-planes.json';put(base+'gate.json',JSON.stringify(cfg));put(base+'reference-planes.json','{}');
 const out=execFileSync(process.execPath,[join(root,'tools/gate.mjs'),'X','--write'],{cwd:root,env,encoding:'utf8'});
 assert.match(out,/WARN unproved-fastest-edge/);
 assert.equal(result().metrics.planes_failures,0);
 const latest=JSON.parse(readFileSync(join(root,base,'.gate/latest.json')));
 assert.match(readFileSync(join(root,base,'.gate',latest.run,'planes.log'),'utf8'),/WARN unproved-fastest-edge/);
});
test('CLI rejects failed fresh DRC even when stale and newly written reports look clean',t=>{
 const {root,put,base,run,result}=fixture(t);
 put(base+'.gate/drc.json',JSON.stringify({violations:[],schematic_parity:[],unconnected_items:[]}));
 assert.equal(run({GATE_TEST_DRC_FAIL:'1'}),1);assert.equal(result().metrics.drc_errors,null);
 assert.equal(run(),0);assert.equal(result().metrics.drc_errors,0);
 assert.equal(readdirSync(join(root,base,'.gate')).filter(n=>n.startsWith('run-')).length,2);
});
test('CLI invalidates changed inputs and preserves prior tracked metrics',t=>{
 const {root,put,base,run,result}=fixture(t);
 put(base+'gate-metrics.json','prior evidence');
 assert.equal(run({GATE_TEST_MUTATE:'1'}),1);assert.equal(result().changedDuringRun,true);
 assert.equal(readFileSync(join(root,base,'gate-metrics.json'),'utf8'),'prior evidence');
});
test('CLI cannot skip DRC at the default layout stage',t=>{
 const {root,put,base,run}=fixture(t);
 put(base+'gate.json',JSON.stringify({project:'cad/X',checks:{erc:true}}));
 assert.equal(run(),2);assert.equal(existsSync(join(root,base,'gate-metrics.json')),false);
});
test('CLI does not probe or fingerprint unused optional repository versions',t=>{
 const {run,result,env}=fixture(t);
 // Point both optional tools at an existing git repo: an accidental probe would
 // succeed and appear in provenance rather than silently fail as absent.
 assert.equal(run({KRT_DIR:env.KICAD_HAPPY_DIR,KRPT_DIR:env.KICAD_HAPPY_DIR}),0);
 assert.equal(result().provenance.tools.KiCadRoutingTools,undefined);
 assert.equal(result().provenance.tools.KiCadRoutingPlacementTools,undefined);
 assert.ok(result().provenance.tools['kicad-happy']);
});
test('isolated evidence preserves tracked metrics and the latest pointer',t=>{
 const {root,put,base,env}=fixture(t);
 put(base+'gate-metrics.json','prior metrics');put(base+'.gate/latest.json','prior latest');
 const evidence=join(root,'isolated-evidence');
 execFileSync(process.execPath,[join(root,'tools/gate.mjs'),'--evidence-dir',evidence,'X'],{cwd:root,env,stdio:'pipe'});
 assert.equal(JSON.parse(readFileSync(join(evidence,'result.json'))).exit,0);
 assert.equal(readFileSync(join(root,base,'gate-metrics.json'),'utf8'),'prior metrics');
 assert.equal(readFileSync(join(root,base,'.gate/latest.json'),'utf8'),'prior latest');
 const events=readFileSync(join(evidence,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(events[0].type,'gate.start');assert.equal(events.at(-1).type,'gate.end');
 assert.ok(events.some(e=>e.type==='check.end' && e.stage==='drc' && e.status==='passed'));
});
test('isolated evidence rejects publishing metrics and reusing evidence',t=>{
 const {root,put,base,env}=fixture(t);
 put(base+'gate-metrics.json','prior metrics');put(base+'.gate/latest.json','prior latest');
 const evidence=join(root,'isolated-evidence');
 assert.throws(()=>execFileSync(process.execPath,[join(root,'tools/gate.mjs'),'X','--evidence-dir',evidence,'--write'],{cwd:root,env,stdio:'pipe'}),error=>error.status===2);
 assert.equal(existsSync(evidence),false);
 mkdirSync(evidence);writeFileSync(join(evidence,'sentinel'),'prior evidence');
 assert.throws(()=>execFileSync(process.execPath,[join(root,'tools/gate.mjs'),'X','--evidence-dir',evidence],{cwd:root,env,stdio:'pipe'}));
 assert.deepEqual(readdirSync(evidence),['sentinel']);
 assert.equal(readFileSync(join(root,base,'gate-metrics.json'),'utf8'),'prior metrics');
 assert.equal(readFileSync(join(root,base,'.gate/latest.json'),'utf8'),'prior latest');
});
test('CLI fingerprints library tables in the versioned configuration directory',t=>{
 const {root,put,base,run,result}=fixture(t);
 put(base+'cad/X.kicad_sch','(lib_id "Shared:Part")');
 const asset='shared-symbols.kicad_sym';put(asset,'source symbol');
 put('config/10.0/sym-lib-table',`(sym_lib_table (lib (name "Shared")(type "KiCad")(uri "${realpathSync(join(root,asset))}")))`);
 // A stale table at the base path must not substitute for KiCad's active table.
 put('config/sym-lib-table','stale base table');
 assert.equal(run(),0);let evidence=result().provenance;
 assert.ok(evidence.inputs.some(x=>x.path==='external/kicad_config/sym-lib-table'));
 assert.ok(evidence.inputs.some(x=>x.path===asset));const before=evidence.input_sha256;
 put(asset,'changed source symbol');assert.equal(run(),0);
 assert.notEqual(result().provenance.input_sha256,before);
});

function isolatedRunner(fixture) {
 let index=0;
 return (flags=[],extra={})=>{
  const evidence=join(fixture.root,`evidence-${++index}`);
  let code=0;
  try {execFileSync(process.execPath,[join(fixture.root,'tools/gate.mjs'),'X',...flags,'--evidence-dir',evidence],{cwd:fixture.root,env:{...fixture.env,...extra},stdio:'pipe'});}
  catch(error){code=error.status;}
  return {code,evidence,result:existsSync(join(evidence,'result.json')) ? JSON.parse(readFileSync(join(evidence,'result.json'))) : null,
   events:existsSync(join(evidence,'events.jsonl')) ? readFileSync(join(evidence,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse) : []};
 };
}
test('native reports finish before dependent tools; malformed reports and parity block dependent work',t=>{
 const f=fixture(t),go=isolatedRunner(f);
 const complete=go();assert.equal(complete.code,0);
 const nativeEnd=Math.max(...complete.events.map((event,index)=>event.type==='check.end' && ['erc','drc'].includes(event.stage) ? index : -1));
 const firstDependent=complete.events.findIndex(event=>event.type==='tool.start' && !['erc','drc'].includes(event.stage));
 assert.ok(firstDependent>nativeEnd);
 for(const extra of [{GATE_TEST_DRC_FAIL:'1'},{GATE_TEST_PARITY:'1'}]) {
  const run=go([],extra);assert.equal(run.code,1);
  assert.equal(run.events.filter(e=>e.type==='tool.start' && !['erc','drc'].includes(e.stage)).length,0);
  assert.equal(run.result.metrics.paths_low,null);assert.equal(run.result.checks.paths.status,'blocked');
  assert.ok(run.events.some(e=>e.type==='dependency.blocked'));
 }
});
test('default and ratchet continue unfinished DRC opens while editing stops expensive dependents',t=>{
 const f=fixture(t),go=isolatedRunner(f);
 const full=go([],{GATE_TEST_DRC_OPEN:'1'});assert.equal(full.code,1);assert.equal(full.result.metrics.paths_low,0);
 const baseline=join(f.root,'baseline.json');writeFileSync(baseline,JSON.stringify({metrics:full.result.metrics}));
 const ratchet=go(['--ratchet','--baseline',baseline],{GATE_TEST_DRC_OPEN:'1'});
 assert.equal(ratchet.code,0);assert.equal(ratchet.result.checks.paths.status,'passed');
 const editing=go(['--changed'],{GATE_TEST_DRC_OPEN:'1'});
 assert.equal(editing.code,1);assert.equal(editing.result.metrics.paths_low,null);
 assert.equal(editing.result.checks.paths.status,'blocked');
});
test('cheap missing-input preflight launches no native or expensive tools',t=>{
 const f=fixture(t);rmSync(join(f.root,f.base,'current-paths.json'));
 const run=isolatedRunner(f)();assert.equal(run.code,1);
 assert.equal(run.events.some(e=>e.type==='tool.start' || e.type==='preflight.probe'),false);
 assert.match(run.result.preflightErrors.join(' '),/current-paths.json/);assert.equal(run.result.metrics.drc_errors,null);
});
test('editing reuses only completed checks; fresh defaults bypass cache; checker edits invalidate scoped results',t=>{
 const f=fixture(t),go=isolatedRunner(f);
 f.put('tools/port_labels.py','first implementation');
 const first=go(['--changed']);assert.equal(first.code,0);assert.equal(first.result.cache.hits,0);
 assert.equal(first.events.filter(e=>e.type==='cache.store').length,6);
 const second=go(['--changed']);assert.equal(second.code,0);assert.equal(second.result.cache.hits,6);
 assert.equal(second.events.filter(e=>e.type==='tool.start').length,0);
 f.put('tools/port_labels.py','changed implementation');
 const scoped=go(['--changed']);assert.equal(scoped.code,0);assert.equal(scoped.result.cache.hits,5);
 assert.deepEqual(scoped.events.filter(e=>e.type==='tool.start').map(e=>e.stage),['port_labels']);
 for(const flags of [[],['--fresh']]) {
  const fresh=go(flags);assert.equal(fresh.code,0);assert.equal(fresh.result.cache.enabled,false);
  assert.equal(fresh.events.filter(e=>e.type==='tool.start').length,6);
 }
 const rejected=go(['--changed','--fresh']);assert.equal(rejected.code,2);
});
test('corrupted cached reports rerun the check and findings delta uses only explicit prior evidence',t=>{
 const f=fixture(t),go=isolatedRunner(f);
 const first=go(['--changed']);assert.equal(first.code,0);
 const cache=join(f.root,f.base,'.gate/check-cache/drc',first.result.checks.drc.cache_key);
 writeFileSync(join(cache,'drc.json'),'corrupt');
 const second=go(['--changed','--findings-baseline',first.evidence]);assert.equal(second.code,0);
 assert.equal(second.result.cache.hits,5);assert.equal(second.result.cache.rejected,1);
 assert.deepEqual(second.events.filter(e=>e.type==='tool.start').map(e=>e.stage),['drc']);
 const findings=JSON.parse(readFileSync(join(second.evidence,'findings.json')));
 assert.equal(findings.delta.baseline,join(first.evidence,'findings.json'));assert.deepEqual(findings.delta.new,[]);
 const original=JSON.parse(readFileSync(join(first.evidence,'findings.json')));assert.equal('delta' in original,false);
});
test('editing rejects a tool binary changed during execution and never publishes its cache',t=>{
 const f=fixture(t),go=isolatedRunner(f);
 const run=go(['--changed'],{GATE_TEST_MUTATE_TOOL:'1'});
 assert.equal(run.code,1);assert.equal(run.result.changedDuringRun,true);
 assert.equal(existsSync(join(f.root,f.base,'.gate/check-cache')),false);
 const findings=JSON.parse(readFileSync(join(run.evidence,'findings.json')));
 assert.equal(findings.inputs_valid,false);assert.equal(findings.complete,false);
});
test('release gates and metric publishing cannot opt into editing cache',t=>{
 const f=fixture(t),go=isolatedRunner(f);
 assert.equal(go(['--changed','--write']).code,2);
 const cfg=JSON.parse(readFileSync(join(f.root,f.base,'gate.json')));cfg.stage='G5';f.put(f.base+'gate.json',JSON.stringify(cfg));
 assert.equal(go(['--changed']).code,2);
});
test('native-only gates require no happy clone; enabled happy checks retain the pin requirement',t=>{
 const f=fixture(t),go=isolatedRunner(f);
 const absent={KICAD_HAPPY_DIR:join(f.root,'missing-happy')};
 const required=go([],absent);assert.equal(required.code,1);
 assert.match(required.result.preflightErrors.join(' '),/required repository unavailable/);
 const modulePath=join(f.root,'tools/lib/env.mjs'),original=readFileSync(modulePath,'utf8');
 writeFileSync(modulePath,original.replace(/commit: '[a-f0-9]+'/,"commit: '0000000'"));
 const mismatched=go();assert.equal(mismatched.code,1);assert.match(mismatched.result.preflightErrors.join(' '),/not at pinned commit/);
 writeFileSync(modulePath,original);
 f.put(f.base+'gate.json',JSON.stringify({stage:'G3',project:'cad/X',checks:{erc:true,drc:true}}));
 const native=go([],absent);assert.equal(native.code,0);
 assert.equal('kicad-happy' in native.result.provenance.tools,false);
 assert.equal(native.result.provenance.inputs.some(row=>row.path.startsWith('external/kicad-happy/')),false);
 assert.deepEqual(native.events.filter(row=>row.type==='preflight.probe').map(row=>row.tool),['kicad']);
});
