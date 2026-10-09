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
 put('hardware-design/registry/cad-assets/C123/C123.kicad_mod','pad');put('hardware-design/boards/X/current-paths.json','{}');put('tools/route-features.json','{}');
 const fp=()=>fingerprint(r,gateInputs(r,'X').files,{kicad:'10.0.6'}).input_sha256;let last=fp();
 for(const p of ['hardware-design/boards/X/cad/nested/A.kicad_sch','hardware-design/registry/cad-assets/C123/C123.kicad_mod','hardware-design/boards/X/current-paths.json','tools/route-features.json']) {put(p,'new');const next=fp();assert.notEqual(last,next);last=next;}
 assert.notEqual(last,fingerprint(r,gateInputs(r,'X').files,{kicad:'10.0.7'}).input_sha256);assert.equal(fp(),last);
});
