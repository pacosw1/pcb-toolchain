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
   (path "/symbol-uuid") (attr smd) (pad "1" smd rect (net 1 "VCC"))))`);
 const sources=Object.fromEntries([project+'.kicad_sch',project+'.kicad_pcb'].map(p=>[p,sha256(readFileSync(join(root,p)))]));
 const native=reconstructSnapshot(root,project,sources).parts.U1;
 put('manifest.json',JSON.stringify({parts:[{reference:'U1',mpn:'PART',lcsc:'C123',native:{...native,non_electrical_pads:[]}}]}));
 put('model.json',JSON.stringify({engineering:{root:'/original',manifest:'/original/manifest.json',inputs:sources}}));
 const bin=join(root,'stub');writeFileSync(bin,'#!/bin/sh\nexit 3\n');chmodSync(bin,0o700);
 assert.equal(preflightSnapshot(root,project,join(root,'model.json'),bin),3);
 assert.throws(()=>preflightSnapshot(root,project,'/etc/passwd',bin),/outside staged snapshot/);
 writeFileSync(bin,'#!/bin/sh\nexit 0\n');
 assert.throws(()=>preflightSnapshot(root,project,join(root,'model.json'),bin),/did not report incomplete/);
});
