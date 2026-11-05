import test from 'node:test';
import assert from 'node:assert/strict';
import {reconstructGeometry} from './reviewed-native-geometry.ts';

test('reconstructs quarter-turn pad and courtyard geometry',()=>{
 const board=`(kicad_pcb (gr_rect (start 0 0) (end 20 20) (layer "Edge.Cuts"))
 (footprint "X" (property "Reference" "U1") (at 10 10 90)
 (pad "1" smd rect (at 1 2 90) (size 2 1) (layers "F.Cu"))
 (fp_rect (start -2 -1) (end 2 1) (layer "F.CrtYd"))))`;
 assert.deepEqual(reconstructGeometry(board),{bounds:[0,0,20,20],refs:{U1:{origin:[10,10],quarter:1,
   pads:{'1':[{center:[12,9],shape:'rect',size:[1,2],axis_aligned:true,layers:['F.Cu'],kind:'smd'}]},
   courtyard:[9,8,11,12],locked:false}}});
 assert.throws(()=>reconstructGeometry(board.replace('(at 10 10 90)','(at 10 10 45)')),/non-quarter/);
});
