import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {maskOpenings} from './silk-mask.ts';
const g='%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,1*%\nD10*\nX000000Y000000D03*\nM02*';
test('mask plot binds source and optional sidecars and rejects unreadable Gerbers',t=>{
 const dir=mkdtempSync(join(tmpdir(),'silk-mask-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const p=join(dir,'board.kicad_pcb'),pro=join(dir,'board.kicad_pro');writeFileSync(p,'board');writeFileSync(pro,'project');
 assert.equal(maskOpenings(p,(_p,sidecars)=>{assert.deepEqual(sidecars,[pro]);return {F:g,B:g}}).F.length,1);
 assert.throws(()=>maskOpenings(p,()=>{writeFileSync(pro,'changed');return {F:g,B:g}}),/sidecars changed/);
 assert.throws(()=>maskOpenings(p,()=>({F:g+'\n%LPC*%',B:g})),/clear polarity/);
});

test('mask plot refuses custom mask expansion rules',t=>{
 const dir=mkdtempSync(join(tmpdir(),'silk-mask-rule-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const p=join(dir,'board.kicad_pcb');writeFileSync(p,'board');writeFileSync(join(dir,'board.kicad_dru'),'(rule x (constraint solder_mask_expansion (min 0.15mm)))');
 assert.throws(()=>maskOpenings(p,()=>({F:g,B:g})),/cannot verify custom solder-mask/);
});
