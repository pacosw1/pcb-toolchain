import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {stageJob} from '../src/client.ts';

function fixture(t: {after: (fn: ()=>void)=>void}) {
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'job-snapshot-')),root=path.join(parent,'project');
  t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
  const put=(name:string,value:string)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);};
  put('tools/lib/pcb-sources.ts',`import fs from 'node:fs';import path from 'node:path';export function sourceFiles(root){return JSON.parse(fs.readFileSync(path.join(root,'deps.json'),'utf8')).map(p=>path.resolve(root,p));}`);
  put('hardware-design/boards/B/B.kicad_pcb','board');put('tools/target/build','omit');
  return {parent,root,put};
}

test('full snapshot packs declared semantic evidence once and excludes build artifacts',t=>{
  const {root,put}=fixture(t);
  put('hardware-design/registry/datasheets/sensor.pdf','evidence');
  put('hardware-design/registry/cad-assets/part.kicad_sym','symbol');
  put('deps.json',JSON.stringify(['hardware-design/boards/B/B.kicad_pcb','hardware-design/registry/datasheets/sensor.pdf','hardware-design/registry/cad-assets/part.kicad_sym']));
  const stage=stageJob(root,root,'hardware-design/boards/B',[],true);t.after(()=>fs.rmSync(stage,{recursive:true,force:true}));
  assert.equal(fs.readFileSync(path.join(stage,'hardware-design/registry/datasheets/sensor.pdf'),'utf8'),'evidence');
  assert.equal(fs.readFileSync(path.join(stage,'hardware-design/registry/cad-assets/part.kicad_sym'),'utf8'),'symbol');
  assert.ok(!fs.existsSync(path.join(stage,'tools/target')));
});

test('snapshot paths and symlinks cannot escape the submitted project',t=>{
  const {parent,root,put}=fixture(t);fs.writeFileSync(path.join(parent,'outside.json'),'outside');
  put('deps.json',JSON.stringify(['../outside.json']));
  assert.throws(()=>stageJob(root,root,'hardware-design/boards/B',[],true),/outside project/);
  fs.symlinkSync(path.join(parent,'outside.json'),path.join(root,'linked.json'));
  put('deps.json',JSON.stringify(['linked.json']));
  assert.throws(()=>stageJob(root,root,'hardware-design/boards/B',[],true),/symlink escapes/);
});
