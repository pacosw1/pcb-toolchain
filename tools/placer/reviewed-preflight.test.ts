import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {sha256} from '../lib/kicad-population.mjs';
import {reconstructSnapshot} from '../lib/reviewed-population.ts';
import {preflightSnapshot} from './reviewed-preflight.ts';

test('staged producer checks population and never treats preflight as approval',t=>{
 const root=mkdtempSync(join(tmpdir(),'reviewed-orchestrator-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const project='hardware-design/boards/X/cad/PROJECT';
 const put=(file:string,text:string)=>{const path=join(root,file);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text);};
 put(project+'.kicad_sch',`(kicad_sch (uuid "ROOT") (lib_symbols (symbol "Fixture:Part" (symbol "Part_1_1" (pin input line (name "VCC") (number "1")))))
   (symbol (uuid "symbol-uuid") (lib_id "Fixture:Part") (unit 1) (in_bom yes) (on_board yes) (dnp no)
   (property "Reference" "U1") (property "Footprint" "Fixture:Part") (property "MPN" "PART") (property "LCSC" "C123")
   (instances (project "PROJECT" (path "/ROOT" (reference "U1") (unit 1))))))`);
 put(project+'.kicad_pcb',`(kicad_pcb (footprint "Fixture:Part" (property "Reference" "U1") (property "MPN" "PART") (property "LCSC" "C123")
   (path "/symbol-uuid") (attr smd) (at 10 10) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "VCC"))))`);
 const sources=Object.fromEntries([project+'.kicad_sch',project+'.kicad_pcb'].map(p=>[p,sha256(readFileSync(join(root,p)))]));
 const reconstructed=reconstructSnapshot(root,project,sources);
 const native=reconstructed.parts.U1;
 const canonical=(v:any):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v && typeof v==='object'?
   '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
 put('hardware-design/boards/X/gate.json',JSON.stringify({project:'cad/PROJECT'}));
 put('hardware-design/boards/X/spec.md','spec'); put('review.md','review'); put('doc.pdf','synthetic');
 const spec={path:'hardware-design/boards/X/spec.md',sha256:sha256('spec'),section:'use'};
 const doc={path:'doc.pdf',sha256:sha256('synthetic'),page:1,document_id:'D',revision:'A'};
 const evidence={path:'review.md',sha256:sha256('review'),section:'review'};
 const manifest:any={schema:'iot-lab.part-use.v1',board:'X',revision:'A',project,spec,
   parts:[{reference:'U1',mpn:'PART',lcsc:'C123',manufacturer:'M',package:{name:'QFN',variant:'A'},unresolved:[],native:{...native,non_electrical_pads:[]},layout_constraints:[],datasheets:[doc],assembly_dependencies:[],
     ratings:[{id:'V',quantity:'voltage',limit:{min:0,max:10,unit:'V',source:doc},required:{min:0,max:5,unit:'V',source:spec},conditions:[]}]}],
   budgets:[{net:'VCC',limit:{min:0,max:2,unit:'A',source:spec},loads:[{reference:'U1',required:{min:0,max:1,unit:'A',source:spec}}]}]};
 manifest.review={verdict:'passed',reviewer:'synthetic',reviewed_at_utc:'2026-01-01T00:00:00Z',facts_sha256:sha256(canonical(manifest)),evidence};
 put('manifest.json',JSON.stringify(manifest));
 const inputs={...sources,'hardware-design/boards/X/gate.json':sha256(readFileSync(join(root,'hardware-design/boards/X/gate.json'))),
   'manifest.json':sha256(readFileSync(join(root,'manifest.json'))),
   'hardware-design/boards/X/spec.md':sha256('spec'),'review.md':sha256('review'),'doc.pdf':sha256('synthetic')};
 const units=[{name:'U1',refs:['U1'],x:1,y:2,fixed:false}]; const outline=[[0,0],[10,0],[10,10]];
 const core={schema:'iot-lab.engineering-constraints.v1',root:'/original',board:'X',manifest:'/original/manifest.json',
   native:'/original/'+project+'.kicad_pcb',inputs,rules:[],geometry:reconstructed.geometry,bindings:[]};
 const engineering={...core,where:{U1:0},review_sha256:sha256(canonical(core)),model_anchor_sha256:sha256(canonical({units,outline}))};
 put('model.json',JSON.stringify({units,board:{outline},board_file:core.native,engineering}));
 const bin=join(root,'stub');writeFileSync(bin,'#!/bin/sh\nexit 3\n');chmodSync(bin,0o700);
 assert.equal(preflightSnapshot(root,project,join(root,'model.json'),bin),3);
 if (process.env.IOTPLACE_BIN) {
   assert.equal(preflightSnapshot(root,project,join(root,'model.json'),process.env.IOTPLACE_BIN),3);
   if (process.env.IOTPLACE_TEST_PDFINFO) {
     const tool=process.env.IOTPLACE_TEST_PDFINFO;
     assert.throws(()=>preflightSnapshot(root,project,join(root,'model.json'),process.env.IOTPLACE_BIN!,
       {path:tool,sha256:sha256(readFileSync(tool))}),/native preflight rejected/);
   }
 }
 const model=JSON.parse(readFileSync(join(root,'model.json'),'utf8'));
 model.engineering.geometry.refs.U1.origin=[999,999];
 put('model.json',JSON.stringify(model));
 assert.throws(()=>preflightSnapshot(root,project,join(root,'model.json'),bin),/geometry differs/);
 model.engineering.geometry=reconstructed.geometry;
 put('model.json',JSON.stringify(model));
 assert.throws(()=>preflightSnapshot(root,project,'/etc/passwd',bin),/outside staged snapshot/);
 writeFileSync(bin,'#!/bin/sh\nexit 0\n');
 assert.throws(()=>preflightSnapshot(root,project,join(root,'model.json'),bin),/did not report incomplete/);
});
