import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gateInputs,fingerprint} from './gate-inputs.mjs';
test('nested sheets, configs, shared targets and tool versions invalidate evidence',t=>{
 const r=mkdtempSync(join(tmpdir(),'gate-inputs-'));t.after(()=>rmSync(r,{recursive:true,force:true}));
 const put=(p,v)=>{mkdirSync(join(r,p,'..'),{recursive:true});writeFileSync(join(r,p),v);};
 put('hardware-design/boards/X/gate.json',JSON.stringify({project:'cad/X',checks:{erc:true,drc:true}}));
 put('hardware-design/boards/X/cad/X.kicad_pcb','C123');put('hardware-design/boards/X/cad/nested/A.kicad_sch','old');
 put('hardware-design/registry/cad-assets/C123/C123.kicad_mod','pad');put('hardware-design/boards/X/current-paths.json','{}');put('tools/route-features.json','{}');put('tools/pin-ratings.json','{}');put('tools/driver-edges.json','{}');
 const fp=()=>fingerprint(r,gateInputs(r,'X').files,{kicad:'10.0.6'}).input_sha256;let last=fp();
 for(const p of ['hardware-design/boards/X/cad/nested/A.kicad_sch','hardware-design/registry/cad-assets/C123/C123.kicad_mod','hardware-design/boards/X/current-paths.json','tools/route-features.json','tools/pin-ratings.json','tools/driver-edges.json']) {put(p,'new');const next=fp();assert.notEqual(last,next);last=next;}
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
