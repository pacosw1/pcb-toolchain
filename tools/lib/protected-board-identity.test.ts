import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import {test} from 'node:test';
import {verifyProtectedBoardIdentity} from './protected-board-identity.ts';
test('permits routing geometry but detects protected board identity changes',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pcb-identity-')),source=path.join(dir,'source.kicad_pcb'),candidate=path.join(dir,'candidate.kicad_pcb');
 try {
  const board='(kicad_pcb (version 20240108) (general (thickness 1.6)))'; fs.writeFileSync(source,board);fs.writeFileSync(candidate,board.replace(')))', ')) (segment (start 0 0) (end 1 1)))'));
  const routing=verifyProtectedBoardIdentity(source,candidate); assert.equal(routing.identityPreserved,true); assert.notEqual(routing.sourceSha256,routing.candidateSha256);
  fs.writeFileSync(candidate,board.replace('1.6','1.7'));assert.equal(verifyProtectedBoardIdentity(source,candidate).identityPreserved,false);
  fs.unlinkSync(candidate);fs.symlinkSync(source,candidate);assert.throws(()=>verifyProtectedBoardIdentity(source,candidate));
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
