import assert from 'node:assert/strict';
import {test} from 'node:test';
import {clipSilk,freeRuns,fracture} from './silk-clip.ts';
import {Outline} from './copper-graph.ts';
import {parseMask} from './silk-mask.ts';
import {iotrouteMissing} from './iotroute-bin.ts';
import {kids,parse} from './sexpr.ts';
const mask=new Outline([[-.5,-.5],[.5,-.5],[.5,.5],[-.5,.5]]);
const masks={F:[mask],B:[]};
const board=(shape:string,pose='0 0 0')=>`(kicad_pcb (footprint "F" (at ${pose}) (layer "F.Cu") (pad "1" smd rect (at 0 0) (layers "F.Cu" "F.Mask")) ${shape}))`;
const line='(fp_line (start -2 0) (end 2 0) (stroke (width .15) (type default)) (layer "F.SilkS") (uuid "line"))';
test('line clipping preserves two free pieces and its first UUID',()=>{
 const result=clipSilk(board(line),masks);assert.equal(result.cut,1);assert.equal(result.pieces,2);assert.equal(result.gone,0);assert.match(result.text,/uuid "line"/);
 assert.equal((result.text.match(/\(fp_line/g)??[]).length,2);
 const end=Number(result.text.match(/\(end ([\d.-]+) 0\)/)![1]);assert.ok(end<-.75);
});
test('local coordinates of a rotated footprint are clipped in board space',()=>{
 const result=clipSilk(board(line,'0 0 90'),masks);assert.equal(result.cut,1);assert.equal(result.pieces,2);
 assert.match(result.text,/\(at 0 0 90\)/);
});
test('ambiguous item identities refuse clipping',()=>{
 assert.throws(()=>clipSilk(board(line+line),masks),/duplicate UUID/);
});
test('far silk and opposite-side silk are byte-identical',()=>{
 const source=board(line,'10 10 0');assert.equal(clipSilk(source,masks).text,source);
 const back=board(line.replace('F.SilkS','B.SilkS'));assert.equal(clipSilk(back,masks).text,back);
});
test('free runs keep a reserve between samples for thin openings',()=>{
 const thin=new Outline([[.009,-1],[.011,-1],[.011,1],[.009,1]]);
 assert.deepEqual(freeRuns([[0,0],[.02,0]],[thin],0),[]);
});
test('a dot is moved clear or removed, never converted into an unfilled arc',()=>{
 const dot='(fp_circle (center .65 0) (end .75 0) (stroke (width .15) (type default)) (fill solid) (layer "F.SilkS") (uuid "dot"))';
 const result=clipSilk(board(dot),masks);assert.equal(result.cut,1);assert.match(result.text,/fill solid/);assert.ok(Number(result.text.match(/\(center ([\d.-]+) /)![1])>.85);
});
test('orphan holes and Beziers fail before a text result exists',()=>{
 const poly='(fp_poly (pts (xy -2 -2) (xy 2 -2) (xy 2 2) (xy -2 2)) (fill yes) (stroke (width 0)) (layer "F.SilkS") (uuid "poly"))';
 assert.throws(()=>clipSilk(board(poly),masks,(op)=>op==='offset'?[[[-1,-1],[1,-1],[1,1],[-1,1]]]:[[[-.5,-.5],[-.5,.5],[.5,.5],[.5,-.5]]]),/hole has no exterior/);
 assert.throws(()=>clipSilk(board(line.replace('fp_line','fp_curve')),masks),/Bezier/);
});
test('fractured filled polygons retain two holes and their exterior',()=>{
 const result=fracture([[[-3,-3],[3,-3],[3,3],[-3,3]],[[-2,-1],[-2,1],[-1,1],[-1,-1]],[[1,-1],[1,1],[2,1],[2,-1]]]);
 assert.equal(result.length,1);const shape=new Outline(result[0]!);
 assert.equal(shape.locate([0,0]),1);assert.equal(shape.locate([-1.5,0]),-1);assert.equal(shape.locate([1.5,0]),-1);assert.equal(shape.locate([4,0]),-1);
});
test('curved region interpolation and oversized circular masks are refused',()=>{
 assert.throws(()=>parseMask('%FSLAX46Y46*%\n%MOMM*%\nG36*\nG02X100Y100I50J0D01*\nG37*'),/curved Gerber/);
 assert.throws(()=>parseMask('%MOMM*%\n%ADD10C,11*%'),/10 mm/);
});
test('Gerber mask Y coordinates are converted to KiCad board coordinates',()=>{
 const mask=parseMask('%FSLAX46Y46*%\n%MOMM*%\n%ADD10R,1X1*%\nD10*\nX10000000Y-20000000D03*\nM02*')[0]!;
 assert.equal(mask.minX,9.5);assert.equal(mask.minY,19.5);assert.equal(mask.maxY,20.5);
});
test('a circle cut across zero degrees stays one arc around the free side',()=>{
 const circle='(fp_circle (center 0 0) (end 1 0) (stroke (width .15)) (layer "F.SilkS") (uuid "circle"))';
 const result=clipSilk(board(circle),{F:[new Outline([[.8,-.2],[1.2,-.2],[1.2,.2],[.8,.2]])],B:[]});
 assert.equal(result.cut,1);assert.equal(result.pieces,1);assert.doesNotMatch(result.text,/fp_circle/);
 const arc=kids(kids(parse(result.text),'footprint')[0]!,'fp_arc')[0]!;
 assert.ok(Number(kids(arc,'mid')[0]![1])<-.9);
});
test('Rust polygon subtraction keeps the clipped hole open', {skip:iotrouteMissing()},()=>{
 const poly='(fp_poly (pts (xy -2 -2) (xy 2 -2) (xy 2 2) (xy -2 2)) (fill solid) (stroke (width 0)) (layer "F.SilkS") (uuid "poly"))';
 const result=clipSilk(board(poly),masks),form=kids(kids(parse(result.text),'footprint')[0]!,'fp_poly')[0]!;
 const points=kids(kids(form,'pts')[0]!,'xy').map(p=>[Number(p[1]),Number(p[2])] as const),shape=new Outline(points);
 assert.equal(result.polygons,1);assert.equal(shape.locate([0,0]),-1);assert.equal(shape.locate([.65,0]),-1);assert.equal(shape.locate([1.5,1.5]),1);
});
