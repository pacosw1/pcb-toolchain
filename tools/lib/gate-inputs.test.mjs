import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gateInputs,fingerprint,gateTools} from './gate-inputs.mjs';
import {fileURLToPath} from 'node:url';
test('preserved copper policy source changes invalidate evidence',t=>{
 const r=mkdtempSync(join(tmpdir(),'preserved-inputs-'));t.after(()=>rmSync(r,{recursive:true,force:true}));
 const put=(p,v)=>{mkdirSync(join(r,p,'..'),{recursive:true});writeFileSync(join(r,p),v);};
 put('hardware-design/boards/X/gate.json',JSON.stringify({project:'cad/X'}));
 const path='hardware-design/DECISIONS.md';
 put('hardware-design/boards/X/preserved-usb-policy.json',JSON.stringify({sources:[{path}]}));
 put(path,'accepted');const fp=()=>fingerprint(r,gateInputs(r,'X').files).input_sha256;
 const before=fp();put(path,'changed');assert.notEqual(fp(),before);
 put('hardware-design/boards/X/preserved-usb-policy.json',JSON.stringify({sources:[{path:'hardware-design/../secret'}]}));
 assert.throws(()=>gateInputs(r,'X'),/invalid preserved policy source path/);
});
test('driver tables and their exact evidence invalidate gates',t=>{
 const r=mkdtempSync(join(tmpdir(),'driver-inputs-'));t.after(()=>rmSync(r,{recursive:true,force:true}));
 const put=(p,v)=>{mkdirSync(join(r,p,'..'),{recursive:true});writeFileSync(join(r,p),v);};
 put('hardware-design/boards/X/gate.json',JSON.stringify({project:'cad/X'}));
 const evidence='hardware-design/registry/datasheets/driver.pdf';
 put(evidence,'old');put('tools/driver-edges.json',JSON.stringify({parts:{},evidence_files:[{path:evidence}]}));
 const fp=()=>fingerprint(r,gateInputs(r,'X').files).input_sha256;const first=fp();put(evidence,'new');assert.notEqual(fp(),first);
 const second=fp();put('tools/driver-edges.json',JSON.stringify({parts:{updated:{}},evidence_files:[{path:evidence}]}));assert.notEqual(fp(),second);
 const third=fp();put(evidence+'.source.json',JSON.stringify({url:'source changed'}));assert.notEqual(fp(),third);
});
test('pin ratings and declared source evidence invalidate current-capacity gates',t=>{
 const r=mkdtempSync(join(tmpdir(),'pin-inputs-'));t.after(()=>rmSync(r,{recursive:true,force:true}));
 const put=(p,v)=>{mkdirSync(join(r,p,'..'),{recursive:true});writeFileSync(join(r,p),v);};
 put('hardware-design/boards/X/gate.json',JSON.stringify({project:'cad/X'}));
 const fp=()=>fingerprint(r,gateInputs(r,'X').files);
 const absent=fp();assert.ok(absent.inputs.some(i=>i.path==='tools/pin-ratings.json' && i.sha256===null));
 const evidence='hardware-design/registry/datasheets/pin.pdf';
 const table={parts:{Part:{pins:{5:{amps:2.7}}}},evidence_files:[{path:evidence}]};
 put('tools/pin-ratings.json',JSON.stringify(table));let last=fp().input_sha256;assert.notEqual(last,absent.input_sha256);
 table.parts.Part.pins[5].amps=2.6;put('tools/pin-ratings.json',JSON.stringify(table));
 assert.notEqual(fp().input_sha256,last);last=fp().input_sha256;
 for(const [path,text] of [[evidence,'datasheet'],[evidence+'.source.json','source receipt']]) {
  put(path,text);const next=fp().input_sha256;assert.notEqual(next,last);last=next;
 }
 rmSync(join(r,'tools/pin-ratings.json'));assert.equal(fp().input_sha256,absent.input_sha256);
});
test('production pin-rating datasheet and receipt are gate dependencies',t=>{
 const r=mkdtempSync(join(tmpdir(),'production-pin-inputs-'));t.after(()=>rmSync(r,{recursive:true,force:true}));
 const put=(p,v)=>{mkdirSync(join(r,p,'..'),{recursive:true});writeFileSync(join(r,p),v);};
 const table=readFileSync(new URL('../pin-ratings.json',import.meta.url),'utf8');
 put('hardware-design/boards/X/gate.json',JSON.stringify({project:'cad/X'}));put('tools/pin-ratings.json',table);
 const files=gateInputs(r,'X').files;const pdf='hardware-design/registry/datasheets/TPS61023.pdf';
 assert.ok(files.includes(join(r,pdf)));assert.ok(files.includes(join(r,pdf+'.source.json')));
 const before=fingerprint(r,files).input_sha256;put(pdf,'original evidence');
 const after=fingerprint(r,files).input_sha256;assert.notEqual(after,before);
 put(pdf+'.source.json','source provenance');assert.notEqual(fingerprint(r,files).input_sha256,after);
});
test('declared IBIS originals and absent evidence invalidate gates',t=>{
 const r=mkdtempSync(join(tmpdir(),'ibis-inputs-'));t.after(()=>rmSync(r,{recursive:true,force:true}));
 const put=(p,v)=>{mkdirSync(join(r,p,'..'),{recursive:true});writeFileSync(join(r,p),v);};
 put('hardware-design/boards/X/gate.json',JSON.stringify({project:'cad/X'}));
 const file='hardware-design/registry/ibis/Driver/model.ibs';
 const table={parts:{Driver:{ibis:{file}}}};
 put('tools/driver-edges.json',JSON.stringify(table));
 const fp=()=>fingerprint(r,gateInputs(r,'X').files);
 const absent=fp();assert.ok(absent.inputs.some(i=>i.path===file && i.sha256===null));
 let last=absent.input_sha256;
 for(const [path,text] of [[file,'[Ramp] initial'],[file+'.source.json','official receipt'],[file,'[Ramp] changed']]) {
  put(path,text);const next=fp().input_sha256;assert.notEqual(next,last);last=next;
 }
 // An unrelated model must not stand in for the exact declared original.
 put('hardware-design/registry/ibis/Other/model.ibs','unrelated');assert.equal(fp().input_sha256,last);
 for(const invalid of ['hardware-design/registry/datasheets/model.ibs','hardware-design/registry/ibis/../secret.ibs','/tmp/model.ibs','hardware-design/registry/ibis/model.txt','hardware-design/registry/ibis/Driver\\model.ibs']) {
  table.parts.Driver.ibis.file=invalid;put('tools/driver-edges.json',JSON.stringify(table));
  assert.throws(()=>gateInputs(r,'X'),/invalid driver IBIS path/);
 }
});
test('nested sheets, configs, shared targets and tool versions invalidate evidence',t=>{
 const r=mkdtempSync(join(tmpdir(),'gate-inputs-'));t.after(()=>rmSync(r,{recursive:true,force:true}));
 const put=(p,v)=>{mkdirSync(join(r,p,'..'),{recursive:true});writeFileSync(join(r,p),v);};
 put('hardware-design/boards/X/gate.json',JSON.stringify({project:'cad/X',checks:{erc:true,drc:true}}));
 put('hardware-design/boards/X/cad/X.kicad_pcb','C123');put('hardware-design/boards/X/cad/nested/A.kicad_sch','old');
 put('hardware-design/registry/cad-assets/C123/C123.kicad_mod','pad');put('hardware-design/boards/X/current-paths.json','{}');
 const fp=()=>fingerprint(r,gateInputs(r,'X').files,{kicad:'10.0.6'}).input_sha256;let last=fp();
 for(const p of ['hardware-design/boards/X/cad/nested/A.kicad_sch','hardware-design/registry/cad-assets/C123/C123.kicad_mod','hardware-design/boards/X/current-paths.json']) {put(p,'new');const next=fp();assert.notEqual(last,next);last=next;}
 assert.notEqual(last,fingerprint(r,gateInputs(r,'X').files,{kicad:'10.0.7'}).input_sha256);assert.equal(fp(),last);
});
test('referenced library footprints are hashed without unrelated library parts',t=>{
 const r=mkdtempSync(join(tmpdir(),'gate-inputs-'));t.after(()=>rmSync(r,{recursive:true,force:true}));
 const put=(p,v)=>{mkdirSync(join(r,p,'..'),{recursive:true});writeFileSync(join(r,p),v);};
 put('hardware-design/boards/X/gate.json',JSON.stringify({project:'cad/X',checks:{erc:true,drc:true}}));
 put('hardware-design/boards/X/cad/X.kicad_pcb','(footprint "Custom:Used")');
 put('hardware-design/boards/X/cad/fp-lib-table','(fp_lib_table (lib (name "Custom")(type "KiCad")(uri "${KIPRJMOD}/custom.pretty")))');
 put('hardware-design/boards/X/cad/custom.pretty/Used.kicad_mod','used');
 put('hardware-design/boards/X/cad/custom.pretty/Other.kicad_mod','other');
 // Local project assets are conservatively included; an external library
 // directory should include only the actually referenced footprint.
 put('external.pretty/Used.kicad_mod','used');put('external.pretty/Other.kicad_mod','other');
 put('hardware-design/boards/X/cad/fp-lib-table',`(fp_lib_table (lib (name "Custom")(type "KiCad")(uri "${r}/external.pretty")))`);
 const files=gateInputs(r,'X').files;
 assert.ok(files.includes(join(r,'external.pretty/Used.kicad_mod')));
 assert.ok(!files.includes(join(r,'external.pretty/Other.kicad_mod')));
});
test('hierarchical sheets outside the project folder remain dependencies',t=>{
 const r=mkdtempSync(join(tmpdir(),'gate-inputs-'));t.after(()=>rmSync(r,{recursive:true,force:true}));
 const put=(p,v)=>{mkdirSync(join(r,p,'..'),{recursive:true});writeFileSync(join(r,p),v);};
 put('hardware-design/boards/X/gate.json',JSON.stringify({project:'cad/X',checks:{erc:true,drc:true}}));
 put('hardware-design/boards/X/cad/X.kicad_sch','(property "Sheetfile" "../../../shared/PWR.kicad_sch")');
 put('hardware-design/shared/PWR.kicad_sch','power circuit');
 const path=join(r,'hardware-design/shared/PWR.kicad_sch');
 assert.ok(gateInputs(r,'X').files.includes(path));
 const before=fingerprint(r,gateInputs(r,'X').files).input_sha256;put('hardware-design/shared/PWR.kicad_sch','changed');
 assert.notEqual(fingerprint(r,gateInputs(r,'X').files).input_sha256,before);
});
// D-129: only the tools the gate executes are inputs. A viewer or test change must not re-gate a board.
// Reviewed BASE gate entry points, their loaded TS/MJS modules and runtime data.
// Keep an explicit closure instead of a pre-port file-count budget: extra unrelated
// imports and missing production dependencies must both fail this project integration test.
const EXPECTED_BASE_GATE_TOOLS=[
 'driver-edges.json','edge-rates.json','gate.mjs','kicad_happy_gate.ts',
 'lib/board-edit.ts','lib/board-hit.ts','lib/board-items.ts','lib/board-json.ts',
 'lib/board-obstacles.ts','lib/board-types.ts','lib/check-cache.mjs','lib/cli.ts',
 'lib/copper-current.ts','lib/copper-gap.ts','lib/copper-graph.ts','lib/daemon-job.ts',
 'lib/drc-run.ts','lib/drc-summary.ts','lib/env-paths.mjs','lib/env.mjs','lib/explicit-spec.ts','lib/fnmatch.ts',
 'lib/footprint-move.ts','lib/gate-core.mjs','lib/gate-findings.mjs','lib/gate-inputs.mjs',
 'lib/gate-runtime.mjs','lib/grid-search.ts','lib/happy-tar.mjs','lib/iotroute-bin.ts',
 'lib/json-file.ts','lib/kicad-happy-board.ts','lib/kicad-happy-findings.ts',
 'lib/kicad-happy-phases.ts','lib/min-heap.ts','lib/net-islands.ts','lib/pcbtool-cli.ts',
 'lib/pcbtool-corridor.ts','lib/pcbtool-read.ts','lib/pcbtool-suggest.ts','lib/pcbtool-write.ts',
 'lib/pin-ratings.ts','lib/power-graph.ts','lib/power-paths.ts','lib/project-root.mjs',
 'lib/py-compat.mjs','lib/py-math.ts','lib/py-numbers.ts','lib/reference-planes.ts',
 'lib/rf-lines.ts','lib/route-grid.ts','lib/route-spec.ts','lib/seigaiha.ts','lib/sexpr.ts',
 'lib/si-native.ts','lib/stackup-colors.ts','lib/suggest-verify.ts','lib/supply-nets.ts',
 'lib/thermal-spokes.ts','lib/through-vias.ts','lib/via-pads.ts',
 'pcbtool.ts','pin-ratings.json','port_labels.ts','rf_lines.ts','si_pairs.ts','si_planes.ts',
].map(name=>'tools/'+name).sort();
test('a real board fingerprints the executed gate tools and no tests, viewers or routers',()=>{
 const root=fileURLToPath(new URL('../..',import.meta.url)).replace(/\/$/,'');
 const paths=fingerprint(root,gateInputs(root,'BASE-PWR').files).inputs.map(i=>i.path);
 for(const p of ['tools/gate.mjs','tools/lib/gate-core.mjs','tools/si_planes.ts','tools/lib/si-native.ts','tools/pcbtool.ts','tools/edge-rates.json']) assert.ok(paths.includes(p),p);
 for(const p of ['tools/route-features.json','tools/hooks/pre-commit','tools/lib/staged-gates.mjs']) assert.ok(!paths.includes(p),p);
 assert.deepEqual(paths.filter(p=>/(^|\/)test_[^/]*\.py$|\.test\.(mjs|ts)$|\/test-/.test(p)),[]);
 assert.deepEqual(paths.filter(p=>p.startsWith('tools/')).sort(),EXPECTED_BASE_GATE_TOOLS);
});
test('external checker rules and their nested JSON and schematic dependencies invalidate evidence',t=>{
 const r=mkdtempSync(join(tmpdir(),'gate-rules-'));t.after(()=>rmSync(r,{recursive:true,force:true}));
 const put=(p,v)=>{mkdirSync(join(r,p,'..'),{recursive:true});writeFileSync(join(r,p),v);};
 put('hardware-design/boards/X/gate.json',JSON.stringify({project:'cad/X',checks:{planes:'../../shared/planes.json'}}));
 put('hardware-design/shared/planes.json',JSON.stringify({fast_file:'fast.json',schematic:'source.kicad_sch'}));
 put('hardware-design/shared/fast.json','{}');put('hardware-design/shared/source.kicad_sch','schematic');
 const fp=()=>fingerprint(r,gateInputs(r,'X').files);
 let before=fp();assert.ok(before.inputs.some(row=>row.path==='hardware-design/shared/fast.json'));
 assert.ok(before.inputs.some(row=>row.path==='hardware-design/shared/source.kicad_sch'));
 put('hardware-design/shared/fast.json','{"fast":["CLK"]}');assert.notEqual(fp().input_sha256,before.input_sha256);
 before=fp();put('hardware-design/shared/source.kicad_sch','changed schematic');assert.notEqual(fp().input_sha256,before.input_sha256);
});
test('the tool collector follows a new import added to a gate script',t=>{
 const r=mkdtempSync(join(tmpdir(),'gate-tools-'));t.after(()=>rmSync(r,{recursive:true,force:true}));
 const put=(p,v)=>{mkdirSync(join(r,p,'..'),{recursive:true});writeFileSync(join(r,p),v);};
 put('tools/gate.mjs',"import {x} from './lib/gate-core.mjs';\nconst a=[tool('si_planes.py'), tool('pcbtool.py')];");
 put('tools/lib/gate-core.mjs',"import {y} from './gate-runtime.mjs';");put('tools/lib/gate-runtime.mjs','');
 put('tools/si_planes.py','import os\nimport json\n');put('tools/pcbtool.py',"def f():\n    spec_from_file_location('si_planes', 'si_planes.py')\n");
 put('tools/route_live.py','import si_planes');put('tools/test_si_planes.py','import si_planes');put('tools/new_rule.py','import os');
 const rel=()=>gateTools(r).map(p=>p.slice(r.length+1));
 assert.deepEqual(rel(),['tools/gate.mjs','tools/lib/gate-core.mjs','tools/lib/gate-runtime.mjs','tools/pcbtool.py','tools/si_planes.py']);
 put('tools/si_planes.py','import os\nfrom new_rule import check\n');
 assert.ok(rel().includes('tools/new_rule.py'));
 put('hardware-design/boards/X/gate.json',JSON.stringify({project:'cad/X'}));
 const before=fingerprint(r,gateInputs(r,'X').files).input_sha256;
 put('tools/route_live.py','changed viewer');put('tools/test_si_planes.py','changed test');
 assert.equal(fingerprint(r,gateInputs(r,'X').files).input_sha256,before);
 put('tools/new_rule.py','changed rule');assert.notEqual(fingerprint(r,gateInputs(r,'X').files).input_sha256,before);
});
// Audit #802: every supported module syntax is followed; unresolvable dependencies fail closed.
test('double-quoted, backtick, re-export and dynamic imports are gate inputs',t=>{
 const r=mkdtempSync(join(tmpdir(),'gate-tools-quotes-'));t.after(()=>rmSync(r,{recursive:true,force:true}));
 const put=(p,v)=>{mkdirSync(join(r,p,'..'),{recursive:true});writeFileSync(join(r,p),v);};
 put('hardware-design/boards/X/gate.json',JSON.stringify({project:'cad/X'}));
 put('tools/gate.mjs','import {verdict} from "./helper.mjs";\nimport `./side.mjs`;\nexport {x} from "./reexport.mjs";\nconst m=await import("./dynamic.mjs");\n// tool(name) in a comment is ignored\nconst a=[tool("rule.py")];\n');
 for(const f of ['helper.mjs','side.mjs','reexport.mjs','dynamic.mjs']) put(`tools/${f}`,'');
 put('tools/helper.mjs','export const verdict=true;');put('tools/rule.py','');
 const rel=gateTools(r).map(p=>p.slice(r.length+1));
 for(const f of ['helper.mjs','side.mjs','reexport.mjs','dynamic.mjs','rule.py']) assert.ok(rel.includes(`tools/${f}`),f);
 const fp=()=>fingerprint(r,gateInputs(r,'X').files).input_sha256;
 const before=fp();put('tools/helper.mjs','export const verdict=false;');assert.notEqual(fp(),before);
 for(const bad of ['const m=await import(name);','import x from "../../outside.mjs";','import x from "/abs/x.mjs";','import x from "pkg";','import(`./x${n}.mjs`);','const a=tool(name);']) {
  put('tools/gate.mjs',bad);assert.throws(()=>gateTools(r),/gate tool/,bad);
 }
 put('tools/gate.mjs',"const a=[tool('dq.py')];");put('tools/dq.py','import os\nspec_from_file_location("loaded", "loaded.py")\n');put('tools/loaded.py','');
 assert.ok(gateTools(r).map(p=>p.slice(r.length+1)).includes('tools/loaded.py'));
 put('tools/dq.py','from .sibling import f\n');assert.throws(()=>gateTools(r),/relative import/);
});
