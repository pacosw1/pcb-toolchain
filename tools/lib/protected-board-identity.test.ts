import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import {test} from 'node:test';
import {allowedPoursDigest,verifyProtectedBoardIdentity} from './protected-board-identity.ts';
import {createHash} from 'node:crypto';
test('permits routing geometry but detects protected board identity changes',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pcb-identity-')),source=path.join(dir,'source.kicad_pcb'),candidate=path.join(dir,'candidate.kicad_pcb');
 try {
  const board='(kicad_pcb (version 20240108) (general (thickness 1.6)))'; fs.writeFileSync(source,board);fs.writeFileSync(candidate,board.replace(')))', ')) (segment (start 0 0) (end 1 1)))'));
  const routing=verifyProtectedBoardIdentity(source,candidate); assert.equal(routing.identityPreserved,true); assert.notEqual(routing.sourceSha256,routing.candidateSha256);
  fs.writeFileSync(candidate,board.replace('1.6','1.7'));assert.equal(verifyProtectedBoardIdentity(source,candidate).identityPreserved,false);
  fs.unlinkSync(candidate);fs.symlinkSync(source,candidate);assert.throws(()=>verifyProtectedBoardIdentity(source,candidate));
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('only exact policy-authorized named pours are exempted and duplicate pours fail',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pcb-pour-')),source=path.join(dir,'source'),candidate=path.join(dir,'candidate');
 try {
  const zone='(zone (name "GND") (net 1) (layer "B.Cu") (priority 1))';
  fs.writeFileSync(source,`(kicad_pcb ${zone})`);fs.writeFileSync(candidate,`(kicad_pcb ${zone.replace('priority 1','priority 2')})`);
  const allowed=new Set([JSON.stringify(['GND','1','B.Cu'])]);
  assert.equal(verifyProtectedBoardIdentity(source,candidate).identityPreserved,false);
  assert.equal(verifyProtectedBoardIdentity(source,candidate,allowed).identityPreserved,true);
  assert.equal(allowedPoursDigest(new Set()),createHash('sha256').update('pcb.allowed-pours.v1\0').update('[]').digest('hex'));
  fs.writeFileSync(candidate,`(kicad_pcb ${zone} ${zone})`);assert.throws(()=>verifyProtectedBoardIdentity(source,candidate,allowed),/duplicate/);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
