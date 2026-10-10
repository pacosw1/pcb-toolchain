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
 for(const p of ['tools/gate.mjs','tools/lib/env.mjs','tools/lib/gate-core.mjs','tools/lib/gate-runtime.mjs','tools/lib/gate-inputs.mjs']) {mkdirSync(join(root,p,'..'),{recursive:true});copyFileSync(join(source,p),join(root,p));}
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
 else {fs.writeFileSync(out,JSON.stringify({violations:[],schematic_parity:[],unconnected_items:[]}));
  if(process.env.GATE_TEST_MUTATE) fs.writeFileSync(a.at(-1),'changed PCB');
  if(process.env.GATE_TEST_DRC_FAIL) process.exit(2);
 }process.exit(0);
}
const script=path.basename(a[0]);
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
 const env={...process.env,KICAD_CLI:join(root,'bin/fake-tool'),KICAD_PYTHON:join(root,'bin/fake-tool'),PYTHON_MODERN:join(root,'bin/fake-tool'),KICAD_HAPPY_DIR:join(root,'happy'),KRT_DIR:join(root,'absent'),KRPT_DIR:join(root,'absent'),KICAD_CONFIG_HOME:join(root,'config')};
 const run=extra=>{try{execFileSync(process.execPath,[join(root,'tools/gate.mjs'),'X','--write'],{cwd:root,env:{...env,...extra},stdio:'pipe'});return 0;}catch(error){return error.status;}};
 const result=()=>{const dir=join(root,base,'.gate');const latest=JSON.parse(readFileSync(join(dir,'latest.json')));return JSON.parse(readFileSync(join(dir,latest.run,'result.json')));};
 return {root,put,base,run,result};
}
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
