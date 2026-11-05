import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import {gerberInputs,gerberRuntime} from './gerber-runtime.mjs';

test('Gerber release provenance binds runtime, reader, board, sidecars and Gerber bytes',t=>{
 const root=mkdtempSync(join(tmpdir(),'gerber-runtime-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(p,s)=>{mkdirSync(join(root,p,'..'),{recursive:true});writeFileSync(join(root,p),s)};
 put('tools/router/core/proto/PIN','at commit '+ 'a'.repeat(40));put('bin/iotroute-linux-x86_64','reader');
 put('hardware-design/boards/X/gate.json',JSON.stringify({project:'cad/X'}));
 for(const ext of ['kicad_pcb','kicad_pro','kicad_dru','kicad_sch'])put('hardware-design/boards/X/cad/X.'+ext,ext);
 put('fab/X-gerber.zip','archive');put('fake-cli','#!/bin/sh\necho 10.0.6\n');chmodSync(join(root,'fake-cli'),0o755);
 const options={cli:join(root,'fake-cli'),toolchain:root};
 const runtime=gerberRuntime(options), inputs=gerberInputs(root,'X',join(root,'fab/X-gerber.zip'),root);
 assert.equal(runtime.reader.kicad_commit,'a'.repeat(40)); assert.equal(runtime.reader.image_identity,'unattested');
 assert.equal(inputs.schema,'iot-lab.gerber-inputs.v1');
 for(const [file,key] of [['hardware-design/boards/X/cad/X.kicad_pcb','pcb'],['hardware-design/boards/X/cad/X.kicad_pro','project'],['hardware-design/boards/X/cad/X.kicad_dru','rules'],['hardware-design/boards/X/cad/X.kicad_sch','schematic'],['fab/X-gerber.zip','gerber'],['bin/iotroute-linux-x86_64','reader']]){
  put(file,'changed-'+key);assert.notEqual(gerberInputs(root,'X',join(root,'fab/X-gerber.zip'),root)[key],inputs[key]);put(file,key==='reader'?'reader':key==='gerber'?'archive':'kicad_'+(key==='pcb'?'pcb':key==='project'?'pro':key==='rules'?'dru':'sch'));
 }
 put('bin/iotroute-linux-x86_64','new reader');assert.notDeepEqual(gerberRuntime(options),runtime);
});
