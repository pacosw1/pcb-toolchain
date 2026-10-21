"""Bounded grid proposals with CPU A* and optional Metal cost-to-go ordering.

Grid failure is not proof of native unroutability. Independent native import and
fresh board gates remain compulsory. GPU guidance never removes a search state.
"""
import copy
import heapq
import math
import time

from .model import fingerprint


def astar(width, height, blocked, start, target, *, field=None, deadline=None):
    """Four-neighbour graph, unit costs; relaxed fields order equally safe work."""
    count = width * height
    if not all(type(v) is int and 0 <= v < count for v in (start, target)):
        raise ValueError('grid endpoints outside finite grid')
    obstacles = set(blocked)
    if start in obstacles or target in obstacles:
        return None
    if field is not None and len(field) != count:
        raise ValueError('cost field shape differs from graph')
    tx, ty = target % width, target // width

    def heuristic(index):
        # Manhattan is admissible regardless of custom/native obstacles. GPU
        # values are only a secondary queue order, never a pruning bound.
        return abs(index % width - tx) + abs(index // width - ty)

    def guidance(index):
        return field[index] if field is not None else heuristic(index)

    queue = [(heuristic(start), guidance(start), 0, start)]
    costs, parent = {start: 0}, {}
    while queue:
        if deadline is not None and time.monotonic() >= deadline:
            return None
        _, _, distance, current = heapq.heappop(queue)
        if costs[current] != distance:
            continue
        if current == target:
            path = [current]
            while current in parent:
                current = parent[current]
                path.append(current)
            return list(reversed(path))
        x, y = current % width, current // width
        for neighbor in ((current-1 if x else -1), (current+1 if x+1 < width else -1),
                         (current-width if y else -1), (current+width if y+1 < height else -1)):
            if neighbor < 0 or neighbor in obstacles or distance+1 >= costs.get(neighbor, math.inf):
                continue
            costs[neighbor] = distance+1
            parent[neighbor] = current
            heapq.heappush(queue, (distance+1+heuristic(neighbor), guidance(neighbor), distance+1, neighbor))
    return None


def _inside(x, y, polygon):
    result = False
    j = len(polygon)-1
    for i, p in enumerate(polygon):
        q = polygon[j]
        if (p['y'] > y) != (q['y'] > y) and x < (q['x']-p['x'])*(y-p['y'])/(q['y']-p['y'])+p['x']:
            result = not result
        j = i
    return result


def _segment_distance(x, y, a, b):
    dx, dy = b['x']-a['x'], b['y']-a['y']
    denominator = dx*dx+dy*dy
    t = 0 if not denominator else min(1, max(0, ((x-a['x'])*dx+(y-a['y'])*dy)/denominator))
    return math.hypot(x-a['x']-t*dx, y-a['y']-t*dy)


def route_srj(srj, *, compute=None, backend='cpu', budget_s=30, emit=None, pitch_mm=.1, max_cells=250000,
              allowed_layers=('top', 'bottom'), search_halo_mm=2.):
    """Connect native-disconnected terminal groups without adding vias.

    Retain all original traces. Fields guide the conservative raster search;
    they cannot establish native legality or physical impossibility.
    """
    emit = emit or (lambda *a, **k: None)
    if not math.isfinite(budget_s) or budget_s <= 0:
        raise ValueError('positive finite local route budget required')
    if not math.isfinite(pitch_mm) or pitch_mm <= 0:
        raise ValueError('positive finite grid pitch required')
    if not math.isfinite(search_halo_mm) or search_halo_mm <= 0:
        raise ValueError('positive finite local search halo required')
    deadline = time.monotonic()+budget_s
    result = dict(schema='iot-lab.engine-local-route.v1', input_sha256=fingerprint(srj),
                  qualified=False, status='blocked', native_validation_required=True,
                  changed_fields=[], output=copy.deepcopy(srj), reason='')
    board_bounds = srj['bounds']
    endpoints = [p for c in srj['connections'] for p in c['pointsToConnect']]
    if not endpoints:
        result['reason'] = 'no selected terminals'
        return result
    # This bounds search effort only. It is never interpreted as clearance or
    # proof that paths outside the local region cannot exist.
    bounds = dict(minX=max(board_bounds['minX'], min(p['x'] for p in endpoints)-search_halo_mm),
                  maxX=min(board_bounds['maxX'], max(p['x'] for p in endpoints)+search_halo_mm),
                  minY=max(board_bounds['minY'], min(p['y'] for p in endpoints)-search_halo_mm),
                  maxY=min(board_bounds['maxY'], max(p['y'] for p in endpoints)+search_halo_mm))
    nx = int(math.ceil((bounds['maxX']-bounds['minX'])/pitch_mm))+1
    ny = int(math.ceil((bounds['maxY']-bounds['minY'])/pitch_mm))+1
    if nx <= 0 or ny <= 0 or nx*ny > max_cells:
        result['reason'] = 'bounded local grid size exceeded; broader routing remains available'
        return result
    point = lambda index: dict(x=bounds['minX']+(index % nx)*pitch_mm, y=bounds['minY']+(index // nx)*pitch_mm)
    index = lambda p: round((p['y']-bounds['minY'])/pitch_mm)*nx+round((p['x']-bounds['minX'])/pitch_mm)
    routed = 0
    tasks, roots, occupancy_cache, snapshots = [], {}, {}, {}
    def find(net, item):
        while roots[net][item] != item:
            roots[net][item] = roots[net][roots[net][item]]
            item = roots[net][item]
        return item
    def union(net, a, b):
        roots[net][find(net, a)] = find(net, b)
    for connection in sorted(srj['connections'], key=lambda c: c['name']):
        terminals, name = connection['pointsToConnect'], connection['name']
        if len(terminals) < 2 or len(terminals) > 64 or name in roots:
            result['reason'] = 'distinct selected nets with at least two terminals required'
            return result
        ids = [p.get('pointId', str(i)) for i, p in enumerate(terminals)]
        if len(set(ids)) != len(ids):
            result['reason'] = 'ambiguous terminal identity'
            return result
        roots[name] = {i: i for i in range(len(terminals))}
        for group in connection.get('externallyConnectedPointIds', []):
            if not group or any(item not in ids for item in group):
                result['reason'] = 'native connected group contains an unknown terminal'
                return result
            for item in group[1:]:
                union(name, ids.index(group[0]), ids.index(item))
        edges = []
        for a, p in enumerate(terminals):
            for b in range(a+1, len(terminals)):
                q = terminals[b]
                common = set(p['layers']) & set(q['layers']) & set(allowed_layers)
                if common:
                    edges.append((math.hypot(p['x']-q['x'], p['y']-q['y']), a, b, sorted(common)))
        # This is a bounded topology portfolio: failed shortest edges do not
        # rule out alternate endpoint pairings between disconnected groups.
        tasks.extend((connection, a, b, layers) for _, a, b, layers in sorted(edges))
        if len(tasks) > 2048:
            result['reason'] = 'bounded local topology frontier exceeded'
            return result
    for connection, terminal_a, terminal_b, common in tasks:
        name = connection['name']
        if find(name, terminal_a) == find(name, terminal_b):
            continue
        terminals = [connection['pointsToConnect'][terminal_a], connection['pointsToConnect'][terminal_b]]
        name = connection['name']
        width = max(connection.get('nominalTraceWidth', 0), srj['minTraceWidth'])
        margin = srj.get('defaultObstacleMargin', 0) + width/2
        edge = srj.get('minBoardEdgeClearance', 0)+width/2
        start, target = map(index, terminals)
        for layer in sorted(common):
            mask_key = (name, layer)
            cached = mask_key in occupancy_cache
            blocked = occupancy_cache.get(mask_key, set())
            # Growing by half a cell diagonal conservatively covers graph edges
            # between samples; the exact terminal tails remain native-checked.
            sampling_margin = pitch_mm/math.sqrt(2)
            for cell in (() if cached else range(nx*ny)):
                if cell % 1024 == 0 and time.monotonic() >= deadline:
                    result['reason'] = 'bounded local routing deadline; no impossibility claim'
                    return result
                p = point(cell)
                x, y = p['x'], p['y']
                polygon = srj.get('outline') or [dict(x=board_bounds['minX'], y=board_bounds['minY']),
                    dict(x=board_bounds['maxX'], y=board_bounds['minY']), dict(x=board_bounds['maxX'], y=board_bounds['maxY']),
                    dict(x=board_bounds['minX'], y=board_bounds['maxY'])]
                if not _inside(x, y, polygon) or any(_segment_distance(x, y, polygon[i-1], polygon[i]) < edge+sampling_margin for i in range(len(polygon))):
                    blocked.add(cell)
                    continue
                for obstacle in srj.get('obstacles', []):
                    if layer not in obstacle['layers'] or name in obstacle.get('connectedTo', []):
                        continue
                    extra = srj.get('minTraceToHoleEdgeClearance', margin) + width/2 if obstacle.get('isNonPlatedHole') else margin
                    cx, cy = obstacle['center']['x'], obstacle['center']['y']
                    # Euclidean distance to the obstacle rectangle, as native clearance: the
                    # grown zone has round corners. It still contains every rounded pad shape.
                    if math.hypot(max(abs(x-cx)-obstacle['width']/2, 0), max(abs(y-cy)-obstacle['height']/2, 0)) <= extra+sampling_margin:
                        blocked.add(cell)
                        break
                if cell in blocked:
                    continue
                for trace in result['output'].get('traces', []):
                    if trace.get('connection_name') == name:
                        continue
                    route = trace['route']
                    for i, a in enumerate(route):
                        if a['route_type'] == 'via':
                            if math.hypot(x-a['x'], y-a['y']) <= a.get('via_diameter', srj['minViaPadDiameter'])/2+margin+sampling_margin:
                                blocked.add(cell)
                        elif i and a.get('layer') == layer and route[i-1].get('layer') == layer:
                            if _segment_distance(x, y, route[i-1], a) <= a['width']/2+margin+sampling_margin:
                                blocked.add(cell)
            occupancy_cache[mask_key] = blocked
            field = None
            if compute is not None:
                try:
                    revision = fingerprint(dict(source=result['input_sha256'], net=name, layer=layer,
                                                bounds=bounds, pitch_mm=pitch_mm, blocked=sorted(blocked)))
                    arguments = dict(width=nx, height=ny, layers=1, blocked=sorted(blocked), targets=[target],
                                     max_sweeps=max(1, min(nx+ny, 4096, 100000000//(nx*ny))))
                    if mask_key not in snapshots and hasattr(compute, 'prepare'):
                        try:
                            snapshots[mask_key] = compute.prepare('cost_field', revision=revision, **arguments)
                        except (ValueError, RuntimeError) as error:
                            emit('engine.compute_cache_fallback', reason=str(error))
                    if mask_key in snapshots:
                        arguments = dict(snapshot_id=snapshots[mask_key], targets=[target])
                    reply = compute.request('cost_field', revision=revision, backend=backend, **arguments)
                    emit('engine.compute', operation='cost_field', error=reply.get('error'), **reply.get('metrics', {}))
                    field = reply.get('result', {}).get('distances')
                except (ValueError, RuntimeError, OSError) as error:
                    emit('engine.compute_fallback', operation='cost_field', backend='cpu_astar', reason=str(error))
            path = astar(nx, ny, blocked, start, target, field=field, deadline=deadline)
            if path is None:
                continue
            points = [terminals[0]] + [point(i) for i in path] + [terminals[1]]
            compact = []
            for p in points:
                if not compact or (p['x'], p['y']) != (compact[-1]['x'], compact[-1]['y']):
                    compact.append(p)
            trace_id = 'engine-' + fingerprint(dict(source=result['input_sha256'], net=name, layer=layer, points=compact))[:24]
            result['output'].setdefault('traces', []).append(dict(type='pcb_trace', pcb_trace_id=trace_id,
                connection_name=name, route=[dict(route_type='wire', x=p['x'], y=p['y'], layer=layer, width=width) for p in compact]))
            routed += 1
            union(name, terminal_a, terminal_b)
            break
    incomplete = [name for name, members in roots.items() if len({find(name, index) for index in members}) > 1]
    if incomplete:
        result['reason'] = 'no complete proposal within bounded same-layer grid; native unroutability is not established'
        result['unresolved_nets'] = incomplete
        return result
    result.update(status='candidate' if routed else 'blocked',
                  reason='local grid copper proposal; full native and configured gates required' if routed
                  else 'no copper proposed: no connection was open in the selected nets',
                  routed_connections=routed, grid=dict(width=nx, height=ny, pitch_mm=pitch_mm,
                                                       bounds=bounds, search_halo_mm=search_halo_mm))
    return result
