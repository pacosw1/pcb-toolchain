"""Bounded local proposal repair; native validation decides acceptance."""
import copy
import time

from .capacity import route_crossings
from .contracts import fingerprint, number


def prune_crossing_excursion(srj, proposal, *, budget_s):
    """Remove one interior waypoint only if it eliminates all known crossings.

    Preserve layers, widths, vias, terminals, endpoints and branch anchors. This
    is a shortcut proposal, not proof of obstacle/clearance or connectivity safety.
    No repair repeats a full routing job or changes any original copper.
    """
    budget_s = number(budget_s, 'budget_s', positive=True)
    started = time.monotonic()
    if (proposal.get('input_sha256') != fingerprint(srj) or proposal.get('qualified') is not False
            or proposal.get('status') != 'geometry_reject'):
        raise ValueError('matching rejected proposal required for local repair')
    result = copy.deepcopy(proposal)
    result['parent_response_sha256'] = fingerprint(proposal)
    result['repair'] = dict(strategy='one_waypoint_crossing_shortcut', attempts=0, edits=[])
    traces = result['output']['traces']
    originals = {t['pcb_trace_id'] for t in srj.get('traces', [])}
    conflicts = route_crossings(srj, traces)
    affected = {tid for c in conflicts for tid in c['trace_ids']} - originals
    anchors = {(p['x'], p['y']) for c in srj['connections'] for p in c['pointsToConnect']}
    for trace in traces:
        route = trace['route']
        anchors.update((p['x'],p['y']) for p in route if p['route_type'] == 'via')
        if route:
            anchors.update((p['x'],p['y']) for p in (route[0],route[-1]))
    for trace in traces:
        if trace['pcb_trace_id'] not in affected:
            continue
        route = trace['route']
        for i in range(1,len(route)-1):
            if time.monotonic() - started >= budget_s:
                result['reason'] = 'local repair deadline; original proposal retained'
                return result
            triple = route[i-1:i+2]
            point = triple[1]
            if (any(p['route_type'] != 'wire' for p in triple)
                    or len({(p['layer'],p['width']) for p in triple}) != 1
                    or (point['x'],point['y']) in anchors
                    or point.get('start_pcb_port_id') or point.get('end_pcb_port_id')):
                continue
            result['repair']['attempts'] += 1
            trace['route'] = route[:i] + route[i+1:]
            remaining = route_crossings(srj, traces)
            if not remaining and time.monotonic() - started < budget_s:
                result.update(status='candidate', qualified=False, native_validation_required=True,
                              conflicts=[], reason='local shortcut proposal; full native checks required')
                result['repair']['edits'] = [dict(trace_id=trace['pcb_trace_id'], removed_waypoint=point)]
                result['repair']['elapsed_s'] = time.monotonic()-started
                return result
            trace['route'] = route
    result['reason'] = 'no single safe-to-test waypoint shortcut; original proposal retained'
    result['repair']['elapsed_s'] = time.monotonic()-started
    return result
