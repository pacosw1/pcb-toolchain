import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import test from 'node:test';
import {copyVerificationWorkspace,semanticChecks} from './sprint-native.ts';

test('a candidate under .gate is copied, while nested evidence and build artifacts are excluded',t=>{
  const dir=mkdtempSync(join(tmpdir(),'sprint-copy-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const root=join(dir,'.gate','run','workspace'),out=join(dir,'verify');mkdirSync(out,{recursive:true});
  const put=(p:string,text:string)=>{const file=join(root,p);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text);};
  put('tools/gate.mjs','gate');put('tools/router/core/target/binary','omit');
  put('hardware-design/boards/ENV/cad/ENV.kicad_pcb','board');put('hardware-design/boards/ENV/.gate/old','omit');
  copyVerificationWorkspace(root,out);
  assert.equal(readFileSync(join(out,'tools/gate.mjs'),'utf8'),'gate');
  assert.equal(readFileSync(join(out,'hardware-design/boards/ENV/cad/ENV.kicad_pcb'),'utf8'),'board');
  assert.ok(!existsSync(join(out,'hardware-design/boards/ENV/.gate')));assert.ok(!existsSync(join(out,'tools/router/core/target')));
});

test('semantic hooks receive the normal operation evidence directory',t=>{
  const dir=mkdtempSync(join(tmpdir(),'sprint-hooks-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const hooks=semanticChecks([{stage:'layout',run:['node','check','--json','{operation}/board-check.json']}],dir,'candidate.pcb',process.execPath,process.env);
  const out=hooks[0]!.command.at(-1)!;
  assert.equal(out,join(dir,'operation/board-check.json'));assert.ok(existsSync(dirname(out)));
  assert.throws(()=>semanticChecks([{stage:'../escape',run:['true']}],dir,'candidate.pcb',process.execPath,process.env),/stage name/);
});
