import {test} from 'node:test';import assert from 'node:assert/strict';
import {Outline} from './copper-graph.ts';import {blockedByMask,clipSilkSegment} from './silk-clip-geometry.ts';
const pad=new Outline([[0,0],[1,0],[1,1],[0,1]]);
test('mask clearance blocks interior and near edges, but not distant points',()=>{
 assert.equal(blockedByMask([.5,.5],[pad],.16),true);assert.equal(blockedByMask([1.1,.5],[pad],.16),true);assert.equal(blockedByMask([1.2,.5],[pad],.16),false);
});
test('segment sampler keeps clear strokes, splits overlaps and drops short fragments',()=>{
 assert.deepEqual(clipSilkSegment([-1,-1],[2,-1],[pad],.15),{changed:false,runs:[[[-1,-1],[2,-1]]]});
 const cut=clipSilkSegment([-1,.5],[2,.5],[pad],.15);assert.equal(cut.changed,true);assert.equal(cut.runs.length,2);assert.ok(cut.runs[0]![1][0]<-.23);assert.ok(cut.runs[1]![0][0]>1.23);
 assert.deepEqual(clipSilkSegment([-.1,.5],[1.1,.5],[pad],.15),{changed:true,runs:[]});
});
test('a keyholed opening preserves its hole and rejects nonfinite clearance',()=>{
 const keyhole=new Outline([[0,0],[4,0],[4,4],[0,4],[0,0],[1,1],[1,3],[3,3],[3,1],[1,1],[0,0]]);
 assert.equal(blockedByMask([2,2],[keyhole],.1),false);
 assert.throws(()=>blockedByMask([0,0],[pad],NaN),/invalid silk clearance/);
});
