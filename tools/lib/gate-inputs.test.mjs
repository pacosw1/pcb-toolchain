import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gateInputs,fingerprint} from './gate-inputs.mjs';
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
test('declared IBIS originals, parser and absent evidence invalidate gates',t=>{
 const r=mkdtempSync(join(tmpdir(),'ibis-inputs-'));t.after(()=>rmSync(r,{recursive:true,force:true}));
 const put=(p,v)=>{mkdirSync(join(r,p,'..'),{recursive:true});writeFileSync(join(r,p),v);};
 put('hardware-design/boards/X/gate.json',JSON.stringify({project:'cad/X'}));
 const file='hardware-design/registry/ibis/Driver/model.ibs';
 const table={parts:{Driver:{ibis:{file}}}};
 put('tools/driver-edges.json',JSON.stringify(table));
 const fp=()=>fingerprint(r,gateInputs(r,'X').files);
 const absent=fp();assert.ok(absent.inputs.some(i=>i.path===file && i.sha256===null));
 assert.ok(absent.inputs.some(i=>i.path==='tools/ibis_ramp.py' && i.sha256===null));
 let last=absent.input_sha256;
 for(const [path,text] of [[file,'[Ramp] initial'],['tools/ibis_ramp.py','parser'],[file+'.source.json','official receipt'],[file,'[Ramp] changed']]) {
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
 put('hardware-design/registry/cad-assets/C123/C123.kicad_mod','pad');put('hardware-design/boards/X/current-paths.json','{}');put('tools/route-features.json','{}');
 const fp=()=>fingerprint(r,gateInputs(r,'X').files,{kicad:'10.0.6'}).input_sha256;let last=fp();
 for(const p of ['hardware-design/boards/X/cad/nested/A.kicad_sch','hardware-design/registry/cad-assets/C123/C123.kicad_mod','hardware-design/boards/X/current-paths.json','tools/route-features.json']) {put(p,'new');const next=fp();assert.notEqual(last,next);last=next;}
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
