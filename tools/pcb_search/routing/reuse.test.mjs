import test from 'node:test';
import assert from 'node:assert/strict';
import { reuseExistingViaNode, retainedCopperPlanningInput, routeLocalNode, detailedEdgeObstacles, centerlinePlanningInput } from './reuse.mjs';
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
test('simple nodes use a direct segment with trace-radius board-edge clearance',()=>{
  const {input,node}=fixture();input.traces=[];
  node.center={x:.6178,y:5};node.width=.15;node.height=1;node.availableZ=[0];
  const a={x:.6178,y:4.5,z:0,connectionName:'signal_1',rootConnectionName:'signal'};
  const b={...a,y:5.5};node.portPoints=[a,b];node.portPointsInPairs=[[a,b]];
  const result=routeLocalNode(input,node);
  assert.deepEqual(result.routes[0].route,[{x:.6178,y:4.5,z:0},{x:.6178,y:5.5,z:0}]);
  assert.deepEqual(result.reused_via_ids,[]);
  // These endpoints are 0.5428 mm from the outline, but the copper edge is
  // only 0.4678 mm away. Checking centerlines alone would incorrectly pass.
  a.x=b.x=.5428;
  assert.equal(routeLocalNode(input,node),null);
});
test('simple routing cannot cross foreign pads or already chosen neighboring copper',()=>{
  const {input,node}=fixture();input.traces=[];
  node.portPointsInPairs[0][1].z=0;node.availableZ=[0];
  input.obstacles=[{type:'rect',center:{x:5,y:5},width:.1,height:1,layers:['top'],connectedTo:['foreign']}];
  assert.equal(routeLocalNode(input,node),null);
  input.obstacles=[];
  const prior={rootConnectionName:'foreign',route:[{x:5,y:4.5,z:0},{x:5,y:5.5,z:0}]};
  assert.equal(routeLocalNode(input,node,undefined,{priorRoutes:[prior]}),null);
});
test('edge barriers derive track and via centerline limits from the same sourced rule',()=>{
  const {input}=fixture(),before=JSON.stringify(input);
  const edge=detailedEdgeObstacles(input)[0];
  assert.equal(edge.height/2+input.defaultObstacleMargin+input.minTraceWidth/2,.575);
  assert.equal(edge.height/2+input.defaultObstacleMargin+input.minViaPadDiameter/2,.8);
  assert.deepEqual(edge.zLayers,[0,1]);assert.equal(JSON.stringify(input),before);
  assert.deepEqual(detailedEdgeObstacles(input,[0])[0].zLayers,[0]);
  assert.equal(detailedEdgeObstacles(input,[0],fixture().node).length,0);
  const nearEdge={center:{x:.6178,y:5},width:.15,height:1};
  assert.equal(detailedEdgeObstacles(input,[0],nearEdge).length,1);
  input.defaultObstacleMargin=.7;
  const outside=detailedEdgeObstacles(input)[0];
  assert.equal(outside.height,input.minTraceWidth);
  assert.equal(outside.center.y+outside.height/2+input.defaultObstacleMargin,input.minBoardEdgeClearance);
  input.outline=[{x:0,y:0},{x:0,y:10},{x:10,y:10},{x:10,y:0}];
  const clockwise=detailedEdgeObstacles(input)[3];
  assert.equal(clockwise.center.y,outside.center.y);
  input.minBoardEdgeClearance=undefined;
  assert.throws(()=>detailedEdgeObstacles(input),/explicit/);
});

test('centerline planning derives a separate envelope without changing source rules or pads',()=>{
  const {input}=fixture(),before=JSON.stringify(input);
  const planning=centerlinePlanningInput(input,input);
  assert.equal(planning.minBoardEdgeClearance,.575);
  assert.equal(input.minBoardEdgeClearance,.5);
  assert.deepEqual(planning.traces,input.traces);
  assert.deepEqual(planning.obstacles,input.obstacles);
  assert.equal(planning.outline.length,4);
  assert.equal(JSON.stringify(input),before);
});

test('global planning reserves fixed-track clearance while preserving terminal pad access',()=>{
  const {input}=fixture();input.traces.push({pcb_trace_id:'fixed',connection_name:'other',route:[
    {route_type:'wire',x:1,y:1,width:.2,layer:'top'},
    {route_type:'wire',x:3,y:1,width:.2,layer:'top'}]});
  input.obstacles=[{type:'rect',obstacleId:'pad',center:{x:4,y:4},width:.5,height:.5,layers:['top'],connectedTo:['signal']}];
  const physical=retainedCopperPlanningInput(input),before=JSON.stringify(physical);
  const planning=centerlinePlanningInput(physical,input);
  const fixed=planning.obstacles.find(o=>o.obstacleId==='retained:fixed:1:body');
  assert.equal(fixed.height,.2+2*(input.defaultObstacleMargin+input.minTraceWidth/2));
  assert.deepEqual(fixed.connectedTo,['other']);
  assert.deepEqual(planning.obstacles[0],input.obstacles[0]);
  assert.equal(JSON.stringify(physical),before);
});
