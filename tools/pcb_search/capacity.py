"""Run a pinned local tscircuit capacity/topology or fanout solver on SRJ.

This is a backend boundary, not a KiCad exporter or acceptance certificate.
Callers must supply a faithful SimpleRouteJson model and validate native output.
"""
import copy
import hashlib
import json
import math
from pathlib import Path
import subprocess
import time

from .contracts import box, fingerprint, number


ROOT = Path(__file__).with_name('routing')
FIELDS = set('layerCount allowBlindAndBuriedVias minTraceWidth nominalTraceWidth minViaDiameter '
             'minViaHoleDiameter minViaPadDiameter min_via_hole_diameter min_via_pad_diameter '
             'defaultObstacleMargin minTraceToPadEdgeClearance minTraceToHoleEdgeClearance '
             'minBoardEdgeClearance minViaEdgeToPadEdgeClearance minViaHoleEdgeToViaHoleEdgeClearance '
             'minPlatedHoleDrillEdgeToDrillEdgeClearance minPadEdgeToPadEdgeClearance '
             'obstacles connections differentialPairs buses allowViaInPad bounds outline '
             'traces jumpers allowJumpers availableJumperTypes'.split())


def retains_fields(actual, expected):
    """Allow solver annotations, but require every supplied semantic field."""
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(k in actual and retains_fields(actual[k], v) for k, v in expected.items())
    if isinstance(expected, list):
        return isinstance(actual, list) and len(actual) == len(expected) and all(retains_fields(a, b) for a, b in zip(actual, expected))
    if isinstance(expected, bool):
        return isinstance(actual, bool) and actual == expected
    if isinstance(actual, bool):
        return False
    return actual == expected


def check_input(srj):
    required = {'layerCount', 'minTraceWidth', 'minViaPadDiameter', 'minViaHoleDiameter',
                'defaultObstacleMargin', 'minBoardEdgeClearance', 'allowViaInPad', 'allowJumpers',
                'obstacles', 'connections', 'bounds'}
    if not isinstance(srj, dict) or not required <= set(srj) or set(srj) - FIELDS:
        raise ValueError('missing or unknown SRJ fields; routing dimensions/policies must be explicit')
    if isinstance(srj['layerCount'], bool) or not isinstance(srj['layerCount'], int) or srj['layerCount'] < 1:
        raise ValueError('invalid layer count')
    for key in ('minTraceWidth', 'minViaPadDiameter', 'minViaHoleDiameter'):
        number(srj[key], key, positive=True)
    for key in ('defaultObstacleMargin', 'minBoardEdgeClearance'):
        number(srj[key], key)
    if srj['minViaHoleDiameter'] >= srj['minViaPadDiameter']:
        raise ValueError('via hole must be smaller than its copper pad')
    for key in ('allowViaInPad', 'allowJumpers'):
        if not isinstance(srj[key], bool):
            raise ValueError('explicit boolean fabrication policy required')
    b = srj['bounds']
    if not isinstance(b, dict) or set(b) != {'minX', 'minY', 'maxX', 'maxY'}:
        raise ValueError('invalid SRJ bounds')
    box([b['minX'], b['minY'], b['maxX'], b['maxY']])
    if not isinstance(srj['obstacles'], list) or not isinstance(srj['connections'], list):
        raise ValueError('SRJ geometry and connection arrays required')
    names = [c.get('name') for c in srj['connections'] if isinstance(c, dict)]
    if (len(names) != len(srj['connections']) or any(not isinstance(n, str) or not n for n in names)
            or len(set(names)) != len(names)):
        raise ValueError('unique connection names required')
    # Also rejects NaN/Infinity anywhere, including nested geometry.
    return fingerprint(srj)


def terminal_conflicts(srj):
    """Catch terminals blocked on every access layer before costly search.

    This checks the supplied obstacle model, not the physical board. A conflict
    requests model/native reconciliation; it never proves the board unroutable.
    """
    conflicts = []
    for connection in srj['connections']:
        for point in connection['pointsToConnect']:
            layers = point.get('layers', [point.get('layer')])
            if not layers or any(not isinstance(layer, str) for layer in layers):
                raise ValueError('terminal copper access layers required')
            blocked = {layer: [] for layer in layers}
            for ob in srj['obstacles']:
                if connection['name'] in ob['connectedTo']:
                    continue
                dx, dy = point['x'] - ob['center']['x'], point['y'] - ob['center']['y']
                angle = math.radians(ob.get('ccwRotationDegrees', 0))
                x, y = dx*math.cos(angle) + dy*math.sin(angle), -dx*math.sin(angle) + dy*math.cos(angle)
                if ob.get('shape') == 'circle':
                    if ob['width'] != ob['height']:
                        raise ValueError('circle obstacle must have equal diameters')
                    distance = max(0, math.hypot(x, y) - ob['width']/2)
                else:
                    distance = math.hypot(max(abs(x)-ob['width']/2, 0), max(abs(y)-ob['height']/2, 0))
                gap = srj.get('minTraceToHoleEdgeClearance', srj['defaultObstacleMargin']) if ob.get('isNonPlatedHole') else srj['defaultObstacleMargin']
                if distance < gap + srj['minTraceWidth']/2:
                    for layer in set(layers) & set(ob['layers']):
                        blocked[layer].append(ob.get('obstacleId', 'unnamed obstacle'))
            if all(blocked.values()):
                conflicts.append(dict(connection=connection['name'], point=point,
                                      blockers=blocked, unroutable_proven=False))
    return conflicts


def route_crossings(srj, output_traces):
    """Prove same-layer centerline crossings; full clearance DRC remains native."""
    originals = {t['pcb_trace_id']: t for t in srj.get('traces', [])}
    # Protected copper always comes from the input, regardless of solver edits.
    traces = list(originals.values()) + [t for t in output_traces if t['pcb_trace_id'] not in originals]
    segments = []
    for trace in traces:
        last = None
        for p in trace['route']:
            if p['route_type'] == 'wire':
                point = (p['x'], p['y'])
                if last and last[1] == p['layer'] and last[0] != point:
                    segments.append((trace['pcb_trace_id'], trace['connection_name'], p['layer'], last[0], point))
                last = point, p['layer']
            elif p['route_type'] == 'via':
                last = (p['x'], p['y']), p['to_layer']
            else:
                raise ValueError('crossing screen cannot represent this route element')
    def orient(a, b, c):
        return (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0])
    def crosses(a,b,c,d):
        if (max(a[0],b[0]) < min(c[0],d[0]) or max(c[0],d[0]) < min(a[0],b[0])
                or max(a[1],b[1]) < min(c[1],d[1]) or max(c[1],d[1]) < min(a[1],b[1])):
            return False
        return orient(a,b,c)*orient(a,b,d) <= 0 and orient(c,d,a)*orient(c,d,b) <= 0
    conflicts = []
    for i, a in enumerate(segments):
        for b in segments[i+1:]:
            if a[2] != b[2] or a[1] == b[1] or (a[0] in originals and b[0] in originals):
                continue
            if crosses(*a[3:], *b[3:]):
                conflicts.append(dict(type='tracks_crossing', layer=a[2],
                                      trace_ids=[a[0], b[0]], nets=[a[1], b[1]],
                                      segments=[a[3:], b[3:]]))
    return conflicts


def progress_records(stderr):
    """Last observed work only; never evidence that a timed-out route completed."""
    if isinstance(stderr, bytes):
        stderr = stderr.decode('utf-8', errors='replace')
    rows = []
    for line in (stderr or '').splitlines():
        if not line.startswith('IOT_CAPACITY_PROGRESS '):
            continue
        try:
            row = json.loads(line.removeprefix('IOT_CAPACITY_PROGRESS '))
        except (ValueError, TypeError):
            continue
        if isinstance(row, dict) and row.get('schema') == 'iot-lab.capacity-progress.v1':
            rows.append(row)
    return rows[-32:]


def resolve_existing_vias(srj, traces):
    """Resolve only exact transitions through source-bound, via-only traces.

    A multilayer obstacle or same net name alone is not connectivity evidence.
    Native import checks the referenced original via again before adding copper.
    """
    vias = [(t['pcb_trace_id'], t['connection_name'], t['route'][0])
            for t in srj.get('traces', []) if len(t['route']) == 1 and t['route'][0]['route_type'] == 'via']
    output = copy.deepcopy(traces)
    for trace in output:
        for index, p in enumerate(trace['route']):
            if p['route_type'] != 'through_obstacle':
                continue
            if p.get('start') != p.get('end') or not isinstance(p.get('start'), dict):
                raise ValueError('unsupported transition through an obstacle; exact original via required')
            matches = [(uid, old) for uid, net, old in vias
                       if net == trace['connection_name'] and p['start'] == dict(x=old['x'], y=old['y'])
                       and {p['from_layer'], p['to_layer']} == {old['from_layer'], old['to_layer']}
                       and p['from_layer'] != p['to_layer']]
            if len(matches) != 1:
                raise ValueError('existing layer transition lacks one exact source via')
            uid, old = matches[0]
            trace['route'][index] = dict(route_type='via', x=old['x'], y=old['y'],
                from_layer=p['from_layer'], to_layer=p['to_layer'], via_diameter=old['via_diameter'],
                via_hole_diameter=old['via_hole_diameter'], reuse_via_id=uid)
    return output


def run(srj, *, budget_s, pipeline='topology', node='node', capture_stages=False):
    budget_s = number(budget_s, 'budget_s', positive=True)
    if pipeline not in ('topology', 'fanout', 'reuse'):
        raise ValueError('unknown capacity pipeline')
    if not isinstance(capture_stages, bool):
        raise ValueError('capture_stages must be boolean')
    source_sha = check_input(srj)
    conflicts = terminal_conflicts(srj)
    if conflicts:
        return dict(status='model_conflict', qualified=False, input_sha256=source_sha,
                    reason='terminal blocked in supplied obstacle model; reconcile native geometry',
                    conflicts=conflicts, native_validation_required=True)
    request = dict(input=srj, input_sha256=source_sha, budget_ms=budget_s*1000, pipeline=pipeline,
                   capture_stages=capture_stages)
    adapter_files = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                     for p in (ROOT/'run.mjs', ROOT/'planning.mjs', ROOT/'reuse.mjs', ROOT/'package.json', ROOT/'package-lock.json')}
    started = time.monotonic()
    try:
        # Current Node's permission mode denies network, subprocesses and writes.
        # Unknown permission options on an older runtime fail, never fall back.
        proc = subprocess.run([node, '--permission', '--allow-fs-read=' + str(ROOT), str(ROOT/'run.mjs')],
                              input=json.dumps(request), text=True, capture_output=True, timeout=budget_s)
    except subprocess.TimeoutExpired as error:
        return dict(status='timeout', qualified=False, input_sha256=source_sha,
                    reason='capacity process deadline', elapsed_s=time.monotonic()-started,
                    progress=progress_records(error.stderr), adapter_files=adapter_files)
    if proc.returncode:
        return dict(status='backend_error', qualified=False, input_sha256=source_sha,
                    reason=proc.stderr[-2000:], elapsed_s=time.monotonic()-started,
                    progress=progress_records(proc.stderr), adapter_files=adapter_files)
    result = json.loads(proc.stdout)
    if result.get('error') and not result.get('reason'):
        result['reason'] = result['error']
    if (result.get('schema') != 'iot-lab.capacity-route.v1' or result.get('input_sha256') != source_sha
            or result.get('qualified') is not False or result.get('native_validation_required') is not True):
        raise ValueError('invalid capacity response contract')
    if result['status'] == 'candidate':
        output = result.get('output')
        if not isinstance(output, dict) or not isinstance(output.get('traces'), list):
            raise ValueError('completed capacity result lacks traces')
        # Reconstructed geometry comes from traces alone. Upstream may not alter
        # the original endpoints, layer masks, obstacles or rule declarations.
        changed = [key for key, value in srj.items() if key != 'traces' and not retains_fields(output.get(key), value)]
        try:
            traces = resolve_existing_vias(srj, output['traces'])
        except ValueError as error:
            result.update(status='unsupported', reason=str(error))
            # Keep costly solver evidence for offline reconciliation, while
            # removing the admissible output field and candidate status.
            result['backend_output'] = result.pop('output')
            traces = None
        if traces is None:
            result.update(elapsed_s=time.monotonic()-started, adapter_files=adapter_files,
                          progress=progress_records(proc.stderr))
            return result
        for old in srj.get('traces', []):
            matches = [t for t in traces if t.get('pcb_trace_id') == old.get('pcb_trace_id')]
            if len(matches) != 1 or not retains_fields(matches[0], old):
                changed.append('preserved trace:' + str(old.get('pcb_trace_id')))
        if changed:
            result.update(status='model_mismatch', reason='capacity output changed supplied fields', changed_fields=changed)
        # Only traces can enter the downstream importer. Ignore returned rule or
        # geometry annotations and retain our exact original model.
        result['output'] = dict(copy.deepcopy(srj), traces=traces)
    result.update(elapsed_s=time.monotonic()-started, rule_coverage='caller model; native checks required')
    result['adapter_files'] = adapter_files
    result['progress'] = progress_records(proc.stderr)
    if result['elapsed_s'] >= budget_s:
        result.update(status='timeout', reason='capacity response validation exceeded deadline')
    return result
