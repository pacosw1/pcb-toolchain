import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {spawnSync} from 'node:child_process';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';import {test} from 'node:test';
const runner=fileURLToPath(new URL('../pcb-protected-verifier.ts',import.meta.url));
test('verifier runner rejects altered policy and board-path mismatch before invoking a gate',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pcb-verifier-')),snapshot=path.join(root,'snapshot'),out=path.join(root,'out');
 try{
  fs.mkdirSync(path.join(snapshot,'__pcb_verify'),{recursive:true});fs.mkdirSync(path.join(snapshot,'hardware-design/boards/X'),{recursive:true});fs.mkdirSync(out);
  const source=path.join(snapshot,'__pcb_verify/source.kicad_pcb'),policyFile=path.join(snapshot,'__pcb_verify/policy.json');fs.writeFileSync(source,'(kicad_pcb)');fs.writeFileSync(path.join(snapshot,'other.kicad_pcb'),'(kicad_pcb)');
  fs.writeFileSync(path.join(snapshot,'hardware-design/boards/X/gate.json'),JSON.stringify({project:'cad/X',checks:{erc:true}}));
  const policy=Buffer.from(JSON.stringify({schema:'pcb.verification-policy.v1',board_path:'other.kicad_pcb',gate_board:'X',gate_project:'cad/X',required_checks:['erc'],tool_versions:{kicad:'10'},allowed_pours:[]}));fs.writeFileSync(policyFile,policy);
  const run=(sha:string)=>spawnSync(process.execPath,['--no-warnings','--experimental-strip-types',runner,snapshot,source,policyFile,sha,out],{encoding:'utf8'});
  const badHash=run('f'.repeat(64));assert.equal(badHash.status,2);assert.match(badHash.stderr,/policy hash mismatch/);
  const mismatch=run(createHash('sha256').update(policy).digest('hex'));assert.equal(mismatch.status,2);assert.match(mismatch.stderr,/gate board path/);
  assert.deepEqual(fs.readdirSync(out),[]);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
