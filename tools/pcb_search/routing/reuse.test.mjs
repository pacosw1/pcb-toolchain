import test from 'node:test';
import assert from 'node:assert/strict';
import { reuseExistingViaNode, retainedCopperPlanningInput } from './reuse.mjs';
function fixture() {
  const a={x:4.8,y:5,z:0,connectionName:'signal_1',rootConnectionName:'signal'};
  const b={...a,x:5.2,z:1};
  const input={layerCount:2,minTraceWidth:.15,defaultObstacleMargin:.15,minBoardEdgeClearance:.5,
    minViaPadDiameter:.6,minViaHoleDiameter:.3,bounds:{minX:0,maxX:10,minY:0,maxY:10},obstacles:[],
    traces:[{pcb_trace_id:'existing',connection_name:'signal',route:[
      {route_type:'via',x:5,y:5,from_layer:'top',to_layer:'bottom',via_diameter:.6,via_hole_diameter:.3}]}]};
  const node={center:{x:5,y:5},width:.6,height:.6,portPoints:[a,b],portPointsInPairs:[[a,b]]};
  return {input,node};
}
test('joins opposite layers through the exact existing via in a sub-grid window',()=>{
  const {input,node}=fixture(),before=JSON.stringify({input,node});
  const result=reuseExistingViaNode(input,node);
  assert.deepEqual(result.reused_via_ids,['existing']);
  assert.deepEqual(result.routes[0].route,[{x:4.8,y:5,z:0},{x:5,y:5,z:0},{x:5,y:5,z:1},{x:5.2,y:5,z:1}]);
  assert.equal(result.qualified,false);assert.equal(JSON.stringify({input,node}),before);
});
test('never invents a transition or borrows a foreign-net via',()=>{
  const {input,node}=fixture();input.traces[0].connection_name='other';
  assert.equal(reuseExistingViaNode(input,node),null);
  input.traces=[];assert.equal(reuseExistingViaNode(input,node),null);
});
test('foreign copper and hole clearance can reject stubs',()=>{
  const {input,node}=fixture();
  input.traces.push({pcb_trace_id:'wall',connection_name:'other',route:[
    {route_type:'wire',x:4.9,y:4.7,width:.15,layer:'top'},
    {route_type:'wire',x:4.9,y:5.3,width:.15,layer:'top'}]});
  assert.equal(reuseExistingViaNode(input,node),null);
  input.traces.pop();input.minTraceToHoleEdgeClearance=.4;
  input.obstacles.push({type:'rect',center:{x:4.8,y:4.7},width:.05,height:.05,layers:['top','bottom'],connectedTo:[],isNonPlatedHole:true});
  assert.equal(reuseExistingViaNode(input,node),null);
});
test('same-net aliases are reusable but changed via geometry is not',()=>{
  const {input,node}=fixture();input.traces[0].connection_name='alias';
  const map={getNetConnectedToId:n=>['alias','signal'].includes(n)?'net1':n};
  assert.ok(reuseExistingViaNode(input,node,map));
  input.traces[0].route[0].via_hole_diameter=.2;
  assert.equal(reuseExistingViaNode(input,node,map),null);
});
test('deadline discards all partial work',()=>{
  const {input,node}=fixture();
  assert.throws(()=>reuseExistingViaNode(input,node,undefined,{deadline:1,clock:()=>1}),/deadline/);
});
test('embedded via-to-wire copper remains a foreign obstruction',()=>{
  const {input,node}=fixture();
  input.traces.push({pcb_trace_id:'wall',connection_name:'other',route:[
    {route_type:'via',x:4.9,y:4.7,from_layer:'bottom',to_layer:'top',via_diameter:.6,via_hole_diameter:.3},
    {route_type:'wire',x:4.9,y:5.3,width:.15,layer:'top'}]});
  assert.equal(reuseExistingViaNode(input,node),null);
  assert.throws(()=>retainedCopperPlanningInput(input),/via-only source traces/);
});
test('planning keeps diagonal centerlines and exact rotated bodies',()=>{
  const {input}=fixture();input.traces.push({pcb_trace_id:'diagonal',connection_name:'other',route:[
    {route_type:'wire',x:1,y:1,width:.2,layer:'top'},
    {route_type:'wire',x:3,y:3,width:.2,layer:'top'}]});
  const before=JSON.stringify(input),result=retainedCopperPlanningInput(input);
  assert.equal(JSON.stringify(input),before);
  assert.deepEqual(result.traces,input.traces);
  const body=result.obstacles.find(o=>o.obstacleId.endsWith(':body'));
  assert.equal(body.height,.2);assert.equal(body.ccwRotationDegrees,45);
  assert.deepEqual(body.connectedTo,['other']);
  assert.equal(result.obstacles.length,3);
});
test('unsupported width transitions and missing via geometry abstain',()=>{
  const {input,node}=fixture();input.traces[0].route[0].via_diameter=undefined;
  assert.equal(reuseExistingViaNode(input,node),null);
  const other=fixture();other.input.traces.push({pcb_trace_id:'taper',connection_name:'other',route:[
    {route_type:'wire',x:4.9,y:4.7,width:.15,layer:'top'},
    {route_type:'wire',x:4.9,y:5.3,width:.25,layer:'top'}]});
  assert.equal(reuseExistingViaNode(other.input,other.node),null);
  assert.throws(()=>retainedCopperPlanningInput(other.input),/unsupported retained segment/);
});
