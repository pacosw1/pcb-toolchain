import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
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

test('pad-only plot source removes other mask contributors without changing source pads',async()=>{
 const {padsOnlyBoard}=await import('./silk-mask.ts');
 const source='(kicad_pcb (version 1) (layers (0 "F.Cu" signal)) (footprint "x" (layer "F.Cu") (property "Reference" "U1" (layer "F.Mask")) (fp_line (layer "F.Mask")) (pad "1" smd circle (layers "F.Cu" "F.Mask"))) (via (at 0 0)) (gr_rect (layer "F.Mask")))';
 const out=padsOnlyBoard(source);assert.match(out,/\(pad "1"/);assert.doesNotMatch(out,/\(fp_line|\(property|\(via|\(gr_rect/);assert.match(out,/\(layers \(0/);
});

test('pad mask plotting uses a disposable pad-only board and checks original source drift',async t=>{
 const {padMaskOpenings}=await import('./silk-mask.ts');
 const dir=mkdtempSync(join(tmpdir(),'silk-pads-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const p=join(dir,'board.kicad_pcb'),source='(kicad_pcb (version 1) (footprint "x" (layer "F.Cu") (pad "1" smd circle (layers "F.Cu" "F.Mask"))) (via (at 0 0)))';writeFileSync(p,source);
 assert.equal(padMaskOpenings(p,copy=>{assert.notEqual(copy,p);assert.doesNotMatch(readFileSync(copy,'utf8'),/\(via/);return {F:g,B:g}}).F.length,1);
 assert.throws(()=>padMaskOpenings(p,()=>{writeFileSync(p,source+' ');return {F:g,B:g}}),/changed during pad mask plot/);
});
