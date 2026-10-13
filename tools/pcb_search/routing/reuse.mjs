// Cheap local routing through exact, already present through-vias. No new via
// search, copper movement, or acceptance certificate. Native gates still apply.
const layer = z => z === 0 ? 'top' : 'bottom';
const orient = (a, b, c) => (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
function projection(p, a, b) {
  const dx=b.x-a.x, dy=b.y-a.y, d=dx*dx+dy*dy;
  const t=d ? Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/d)) : 0;
  return {x:a.x+t*dx,y:a.y+t*dy};
}
const pointDistance = (p,a,b) => { const q=projection(p,a,b);return Math.hypot(p.x-q.x,p.y-q.y); };
function segmentDistance(a,b,c,d) {
  if(Math.max(a.x,b.x)>=Math.min(c.x,d.x)&&Math.max(c.x,d.x)>=Math.min(a.x,b.x)&&
     Math.max(a.y,b.y)>=Math.min(c.y,d.y)&&Math.max(c.y,d.y)>=Math.min(a.y,b.y)&&
     orient(a,b,c)*orient(a,b,d)<=0&&orient(c,d,a)*orient(c,d,b)<=0)return 0;
  return Math.min(pointDistance(a,c,d),pointDistance(b,c,d),pointDistance(c,a,b),pointDistance(d,a,b));
}
function rectDistance(a,b,ob) {
  const angle=(ob.ccwRotationDegrees??0)*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle);
  const local=p=>({x:(p.x-ob.center.x)*cos+(p.y-ob.center.y)*sin,
    y:-(p.x-ob.center.x)*sin+(p.y-ob.center.y)*cos});
  a=local(a);b=local(b);
  if(ob.shape==='circle')return Math.max(0,pointDistance({x:0,y:0},a,b)-ob.width/2);
  const w=ob.width/2,h=ob.height/2;
  if([a,b].some(p=>Math.abs(p.x)<=w&&Math.abs(p.y)<=h))return 0;
  const corners=[{x:-w,y:-h},{x:w,y:-h},{x:w,y:h},{x:-w,y:h}];
  return Math.min(...corners.map((p,i)=>segmentDistance(a,b,p,corners[(i+1)%4])));
}
function inside(p,polygon) {
  let yes=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++) {
    const a=polygon[i],b=polygon[j];
    if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)yes=!yes;
  }
  return yes;
}

export function reuseExistingViaNode(input,node,connMap,{deadline=Infinity,clock=()=>performance.now()}={}) {
  const check=()=>{if(clock()>=deadline)throw new Error('existing-via reuse deadline');};
  const root=n=>connMap?.getNetConnectedToId?.(n)??n;
  const pairs=node.portPointsInPairs;
  if(input.layerCount!==2||!pairs?.length||!pairs.some(([a,b])=>a.z!==b.z))return null;
  if(pairs.flat().some(p=>![0,1].includes(p.z)))return null;
  const bounds={minX:node.center.x-node.width/2,maxX:node.center.x+node.width/2,
    minY:node.center.y-node.height/2,maxY:node.center.y+node.height/2};
  const inNode=p=>p.x>=bounds.minX&&p.x<=bounds.maxX&&p.y>=bounds.minY&&p.y<=bounds.maxY;
  const tracks=[],vias=[];
  for(const trace of input.traces??[]) {
    let last;
    for(const p of trace.route) {
      check();
      if(p.route_type==='via') {
        if(!Number.isFinite(p.via_diameter)||p.via_diameter<=0)return null;
        if(last&&(last.x!==p.x||last.y!==p.y||last.layer!==p.from_layer))return null;
        if(new Set([p.from_layer,p.to_layer]).size!==2 ||
           ![p.from_layer,p.to_layer].every(l=>['top','bottom'].includes(l)))return null;
        vias.push({...p,net:root(trace.connection_name),id:trace.pcb_trace_id});
        last={x:p.x,y:p.y,layer:p.to_layer,width:null};continue;
      }
      if(p.route_type!=='wire')return null;
      if(!Number.isFinite(p.width)||p.width<=0)return null;
      if(last&&(last.layer!==p.layer||(last.width!==null&&last.width!==p.width)))return null;
      if(last&&last.layer===p.layer&&(last.width===null||last.width===p.width))
        tracks.push({a:last,b:p,width:p.width,layer:p.layer,net:root(trace.connection_name)});
      last=p;
    }
  }
  const polygon=input.outline??[
    {x:input.bounds.minX,y:input.bounds.minY},{x:input.bounds.maxX,y:input.bounds.minY},
    {x:input.bounds.maxX,y:input.bounds.maxY},{x:input.bounds.minX,y:input.bounds.maxY}];
  const width=input.minTraceWidth,clearance=input.defaultObstacleMargin,chosen=[];
  function clear(a,b,net) {
    check();
    if(!inNode(a)||!inNode(b)||!inside(a,polygon)||!inside(b,polygon))return false;
    if(polygon.some((p,i)=>segmentDistance(a,b,p,polygon[(i+1)%polygon.length])<input.minBoardEdgeClearance+width/2))return false;
    for(const ob of input.obstacles) {
      check();
      if(!ob.layers.includes(layer(a.z))||ob.connectedTo.some(n=>root(n)===net))continue;
      const gap=ob.isNonPlatedHole?(input.minTraceToHoleEdgeClearance??clearance):clearance;
      if(rectDistance(a,b,ob)<gap+width/2)return false;
    }
    for(const t of tracks) {
      check();
      if(t.layer===layer(a.z)&&t.net!==net&&segmentDistance(a,b,t.a,t.b)<clearance+(width+t.width)/2)return false;
    }
    for(const v of vias)if(v.net!==net&&pointDistance(v,a,b)<clearance+(width+v.via_diameter)/2)return false;
    for(const route of chosen) {
      if(root(route.rootConnectionName)===net)continue;
      for(let i=1;i<route.route.length;i++) {
        const c=route.route[i-1],d=route.route[i];
        if(c.z===a.z&&d.z===a.z&&segmentDistance(a,b,c,d)<clearance+width)return false;
      }
    }
    return true;
  }
  const usedVias=new Set();
  for(const [a,b] of pairs) {
    check();
    const net=root(a.rootConnectionName??a.connectionName);
    if(net!==root(b.rootConnectionName??b.connectionName)||a.connectionName!==b.connectionName)return null;
    const eligible=vias.filter(v=>v.net===net&&inNode(v)&&v.via_diameter===input.minViaPadDiameter&&v.via_hole_diameter===input.minViaHoleDiameter);
    if(!eligible.length)return null;
    const points=[],ids=new Map();
    const add=p=>{
      const key=JSON.stringify([p.x,p.y,p.z]);
      if(!ids.has(key)){ids.set(key,points.length);points.push({x:p.x,y:p.y,z:p.z});}
      return ids.get(key);
    };
    const start=add(a),end=add(b),viaEdges=[];
    for(const v of eligible)viaEdges.push({a:add({...v,z:0}),b:add({...v,z:1}),id:v.id});
    const ownTracks=tracks.filter(t=>t.net===net);
    for(const t of ownTracks) {
      const z=t.layer==='top'?0:1;
      for(const p of [t.a,t.b])if(inNode(p))add({...p,z});
      // Project the requested ports onto existing copper, preserving exact
      // vertices for bends and exact via anchors for layer transitions.
      for(const p of [a,b])if(p.z===z){const q=projection(p,t.a,t.b);if(inNode(q))add({...q,z});}
    }
    const edges=points.map(()=>[]);
    const link=(i,j,cost,via)=>{edges[i].push({to:j,cost,via});edges[j].push({to:i,cost,via});};
    for(const v of viaEdges)link(v.a,v.b,0,v.id);
    for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++) {
      check();
      if(points[i].z===points[j].z&&clear(points[i],points[j],net))
        link(i,j,Math.hypot(points[i].x-points[j].x,points[i].y-points[j].y));
    }
    const distance=points.map(()=>Infinity),previous=points.map(()=>null),done=new Set();distance[start]=0;
    while(!done.has(end)) {
      check();let current=-1;
      for(let i=0;i<points.length;i++)if(!done.has(i)&&Number.isFinite(distance[i])&&(current===-1||distance[i]<distance[current]))current=i;
      if(current===-1)return null;
      done.add(current);
      for(const e of edges[current])if(!done.has(e.to)&&distance[current]+e.cost<distance[e.to]) {
        distance[e.to]=distance[current]+e.cost;previous[e.to]={from:current,via:e.via};
      }
    }
    const path=[],routeVias=[];let current=end;
    while(current!==start) {
      path.push(points[current]);const edge=previous[current];
      if(edge.via){usedVias.add(edge.via);routeVias.push({x:points[current].x,y:points[current].y,zStart:0,zEnd:1});}
      current=edge.from;
    }
    path.push(points[start]);path.reverse();
    chosen.push({connectionName:a.connectionName,rootConnectionName:a.rootConnectionName??a.connectionName,
      traceThickness:width,viaDiameter:input.minViaPadDiameter,route:path,vias:routeVias,
      startPcbPortId:a.pcb_port_id,endPcbPortId:b.pcb_port_id});
  }
  return {routes:chosen,reused_via_ids:[...usedVias],qualified:false};
}

export function retainedCopperPlanningInput(input) {
  if(input.layerCount!==2)throw new Error('retained-copper reuse pipeline supports two layers');
  const result=structuredClone(input),ids=new Set(result.obstacles.map(o=>o.obstacleId));
  const add=ob=>{
    if(ids.has(ob.obstacleId))throw new Error('retained planning obstacle identity collision');
    ids.add(ob.obstacleId);result.obstacles.push(ob);
  };
  for(const trace of input.traces??[]) {
    let last;
    for(const [index,p] of trace.route.entries()) {
      if(p.route_type!=='wire'){
        if(p.route_type!=='via'||trace.route.length!==1)throw new Error('reuse planning requires explicit via-only source traces');
        last=undefined;continue;
      }
      if(!Number.isFinite(p.width)||p.width<=0)throw new Error('invalid retained width');
      const base={type:'rect',connectedTo:[trace.connection_name],layers:[p.layer]};
      add({...base,obstacleId:`retained:${trace.pcb_trace_id}:${index}:end`,
        center:{x:p.x,y:p.y},width:p.width,height:p.width,shape:'circle'});
      if(last) {
        if(last.layer!==p.layer||last.width!==p.width)throw new Error('unsupported retained segment');
        const dx=p.x-last.x,dy=p.y-last.y;
        if(dx||dy)add({...base,obstacleId:`retained:${trace.pcb_trace_id}:${index}:body`,
          center:{x:(p.x+last.x)/2,y:(p.y+last.y)/2},width:Math.hypot(dx,dy),height:p.width,
          ccwRotationDegrees:Math.atan2(dy,dx)*180/Math.PI});
      }
      last=p;
    }
  }
  return result;
}

export function configureReusePipeline(solver,input,deadline) {
  const step=solver.pipelineDef.find(s=>s.solverName==='highDensityRouteSolver');
  if(!step)throw new Error('pinned high-density pipeline interface changed');
  const HD=step.solverClass,report={reused_nodes:[],elapsed_ms:0};
  step.solverClass=class extends HD {
    constructor(params) {
      const start=performance.now(),remaining=[],routes=[];
      for(const node of params.nodePortPoints) {
        const reused=reuseExistingViaNode(input,node,params.connMap,{deadline});
        if(reused){report.reused_nodes.push({node_id:node.capacityMeshNodeId,...reused});routes.push(...reused.routes);}
        else remaining.push(node);
      }
      super({...params,nodePortPoints:remaining});
      this.routes.push(...routes);
      this.stats.reusedNodeCount=report.reused_nodes.length;
      report.elapsed_ms=performance.now()-start;
    }
  };
  // First ask native checks whether the stitched proposal is usable. Optional
  // geometry polishing and repair are later funnel stages, driven by evidence.
  solver.pipelineDef=solver.pipelineDef.filter(s=>!['highDensityForceImproveSolver','highDensityRepairSolver'].includes(s.solverName));
  return report;
}
