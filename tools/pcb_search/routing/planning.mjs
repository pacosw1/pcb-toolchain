// A local planning witness, not a routability proof or a native DRC substitute.
// Check exact straight-track capsules; never substitute a diagonal's AABB.
export function boardEdgePortConflicts(input,nodes) {
  const polygon=input.outline??[
    {x:input.bounds.minX,y:input.bounds.minY},{x:input.bounds.maxX,y:input.bounds.minY},
    {x:input.bounds.maxX,y:input.bounds.maxY},{x:input.bounds.minX,y:input.bounds.maxY}];
  const required=input.minBoardEdgeClearance+input.minTraceWidth/2,conflicts=[];
  for(const node of nodes)for(const point of node.portPoints) {
    let distance=Infinity,nearest,edgeIndex,inside=false;
    for(let i=0;i<polygon.length;i++) {
      const a=polygon[i],b=polygon[(i+1)%polygon.length];
      if((a.y>point.y)!==(b.y>point.y)&&point.x<(b.x-a.x)*(point.y-a.y)/(b.y-a.y)+a.x)inside=!inside;
      const dx=b.x-a.x,dy=b.y-a.y,length2=dx*dx+dy*dy;
      const t=length2?Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/length2)):0;
      const q={x:a.x+t*dx,y:a.y+t*dy},d=Math.hypot(point.x-q.x,point.y-q.y);
      if(d<distance){distance=d;nearest=q;edgeIndex=i;}
    }
    if(!inside||distance<required)conflicts.push({type:'planned_port_board_edge_clearance',
      node_id:node.capacityMeshNodeId,connection:point.connectionName,port_id:point.portPointId,
      point:{x:point.x,y:point.y,z:point.z},edge_index:edgeIndex,nearest,inside,
      centerline_distance_mm:distance,required_centerline_distance_mm:required,unroutable_proven:false});
  }
  return conflicts;
}

export function retainedTrackPortConflicts(input, nodes, connMap) {
  const root = name => connMap?.getNetConnectedToId?.(name) ?? name;
  const segments = [];
  for (const trace of input.traces ?? []) {
    let previous;
    for (const point of trace.route) {
      if (point.route_type !== 'wire') { previous = undefined; continue; }
      if (previous && previous.layer === point.layer && previous.width === point.width) {
        segments.push({ a: previous, b: point, net: root(trace.connection_name),
          trace_id: trace.pcb_trace_id, width: point.width, layer: point.layer });
      }
      previous = point;
    }
  }
  const conflicts = [];
  for (const node of nodes) {
    for (const point of node.portPoints) {
      const net = root(point.rootConnectionName ?? point.connectionName);
      const layer = point.z === 0 ? 'top' : point.z === input.layerCount - 1 ? 'bottom' : `inner${point.z}`;
      for (const segment of segments) {
        if (segment.net === net || segment.layer !== layer) continue;
        const { a, b } = segment;
        const dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy;
        const t = length2 === 0 ? 0 : Math.max(0, Math.min(1,
          ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2));
        const nearest = { x: a.x + t * dx, y: a.y + t * dy };
        const distance = Math.hypot(point.x - nearest.x, point.y - nearest.y);
        const required = (input.minTraceWidth + segment.width) / 2 + input.defaultObstacleMargin;
        if (distance < required) {
          conflicts.push({ type: 'planned_port_retained_track_clearance',
            node_id: node.capacityMeshNodeId, connection: point.connectionName,
            root_connection: point.rootConnectionName ?? null, port_id: point.portPointId,
            point: { x: point.x, y: point.y, z: point.z }, layer,
            retained_trace_id: segment.trace_id, retained_net: segment.net,
            nearest, centerline_distance_mm: distance, required_centerline_distance_mm: required,
            unroutable_proven: false });
          // One exact blocker per port suffices to invalidate this plan.
          break;
        }
      }
    }
  }
  return conflicts;
}

export function solverWork(solver) {
  const chain = [], seen = new Set();
  let current = solver;
  // Diagnostic size bound only; it has no effect on search/design rules.
  while (current && !seen.has(current) && chain.length < 8) {
    seen.add(current);
    chain.push({ name: current.getSolverName?.() ?? current.constructor?.name ?? null,
      iterations: current.iterations ?? null,
      connection: current.activeConnection?.connectionName ?? null });
    current = current.activeSubSolver;
  }
  const hd = solver?.highDensityRouteSolver;
  return { chain, node_id: hd?.activeNode?.capacityMeshNodeId ?? null,
    solved_nodes: hd?.stats?.solvedNodeCount ?? null, total_nodes: hd?.stats?.nodeCount ?? null,
    fallback_reason: hd?.activeFallbackReason ?? null };
}
