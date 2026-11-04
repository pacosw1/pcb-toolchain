"""Pinned tscircuit packing proposals over existing rigid placement units.

The uniform gap conservatively uses the largest input rect spacing. This may
overconstrain packing; it must never weaken the original per-unit/domain checks.
Only poses are imported. Backend geometry and net assignments are never written.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import time

from placer import cost
from .contracts import box, fingerprint, number, xy
from .placement import screen_pose


ROOT = Path(__file__).with_name('packing')


def prepare(problem, rotations=(0,)):
    if (not rotations or any(isinstance(r, bool) or r not in (0, 1, 2, 3) for r in rotations)
            or len(set(rotations)) != len(rotations)):
        raise ValueError('unique quarter-turn rotations required')
    units = problem['units']
    names = [u['name'] for u in units]
    if not units or any(not isinstance(n, str) or not n for n in names) or len(set(names)) != len(names):
        raise ValueError('unique nonempty units required')
    if problem.get('dru_ignored'):
        raise ValueError('unrepresented placement rules')
    components, obstacles, stationary = [], [], []
    gap = 0.
    for i, u in enumerate(units):
        rects = [box(r[:4]) for r in u['rects']]
        if not rects:
            raise ValueError('missing unit geometry: ' + u['name'])
        gap = max(gap, *(number(r[4], 'rect spacing') for r in u['rects']))
        x, y = xy([u['x'], u['y']])
        a, b = min(r[0] for r in rects), min(r[1] for r in rects)
        c, d = max(r[2] for r in rects), max(r[3] for r in rects)
        pads = []
        for j, copper in enumerate(u.get('cu', [])):
            if len(copper) != 5:
                raise ValueError('invalid copper-pad model')
            x0, y0, x1, y1 = box(copper[:4])
            code = copper[4]
            if isinstance(code, bool) or not isinstance(code, int) or code < 0:
                raise ValueError('invalid copper net code')
            net = problem.get('cu_nets', {}).get(str(code))
            if code and (not net or not isinstance(net[0], str)):
                raise ValueError('copper net mapping missing')
            pads.append(dict(padId=f'{i}:{j}', networkId=('net:' + net[0]) if code else f'isolated:{i}:{j}',
                             type='rect', offset=dict(x=(x0+x1)/2, y=-(y0+y1)/2),
                             size=dict(x=x1-x0, y=y1-y0)))
        if not pads:
            if not u['fixed']:
                raise ValueError('movable unit lacks physical pad geometry: ' + u['name'])
            obstacles.append(dict(obstacleId=u['name'], absoluteCenter=dict(x=x+(a+c)/2, y=-(y+(b+d)/2)),
                                  width=c-a, height=d-b))
            stationary.append(i)
            continue
        components.append(dict(componentId=u['name'], isStatic=bool(u['fixed']), center=dict(x=x, y=-y),
                               ccwRotationOffset=0, availableRotationDegrees=[0] if u['fixed'] or not u.get('rotate', True) else [r*90 for r in rotations],
                               pads=pads, courtyard=dict(offsetFromCenter=dict(x=(a+c)/2, y=-(b+d)/2),
                                                         width=c-a, height=d-b)))
    # Keepout polygons are conservatively enclosed. Native geometry is retained
    # in the original model and independently screens the returned poses.
    for i, poly in enumerate(problem['board'].get('keepouts', [])):
        points = [xy(p) for p in poly]
        x0, y0 = min(p[0] for p in points), min(p[1] for p in points)
        x1, y1 = max(p[0] for p in points), max(p[1] for p in points)
        box([x0, y0, x1, y1])
        obstacles.append(dict(obstacleId=f'keepout:{i}', absoluteCenter=dict(x=(x0+x1)/2, y=-(y0+y1)/2),
                              width=x1-x0, height=y1-y0))
    outline = [xy(p) for p in problem['board']['outline']]
    x0, y0 = min(p[0] for p in outline), min(p[1] for p in outline)
    x1, y1 = max(p[0] for p in outline), max(p[1] for p in outline)
    box([x0, y0, x1, y1])
    return dict(input=dict(components=components, obstacles=obstacles, minGap=gap,
                           bounds=dict(minX=x0, minY=-y1, maxX=x1, maxY=-y0),
                           boundaryOutline=[dict(x=x, y=-y) for x, y in outline],
                           packOrderStrategy='largest_to_smallest',
                           packPlacementStrategy='shortest_connection_along_outline'),
                stationary=stationary, rotations=list(rotations))


def admit(problem, prepared, response, params, *, attachments=()):
    """Import positions only; reject omitted, duplicated or invented components."""
    expected_sha = fingerprint(dict(problem=problem, prepared=prepared))
    if (not isinstance(response, dict) or response.get('schema') != 'iot-lab.packing-response.v1'
            or response.get('input_sha256') != expected_sha):
        raise ValueError('packing response does not match this input')
    expected = {u['componentId'] for u in prepared['input']['components']}
    rows = response.get('components')
    if not isinstance(rows, list):
        raise ValueError('missing packing components')
    ids = [r.get('id') for r in rows if isinstance(r, dict)]
    if len(ids) != len(rows) or any(not isinstance(n, str) for n in ids) or len(set(ids)) != len(ids) or set(ids) != expected:
        raise ValueError('packing component identity/cardinality mismatch')
    index = {u['name']: i for i, u in enumerate(problem['units'])}
    pose = [list(p) for p in cost.initial_pose(problem)]
    for r in rows:
        x, y = xy([r.get('x'), r.get('y')])
        rot = r.get('rotation')
        unit = problem['units'][index[r['id']]]
        allowed = [0] if unit['fixed'] or not unit.get('rotate', True) else [q*90 for q in prepared['rotations']]
        if isinstance(rot, bool) or rot not in allowed:
            raise ValueError('packing returned a forbidden rotation')
        pose[index[r['id']]] = [x, -y, int(rot/90)]
    screen = screen_pose(problem, pose, params, attachments=attachments)
    return dict(schema='iot-lab.packing-proposal.v1', status=screen['status'], qualified=False,
                pose=pose, final=screen, backend=response.get('backend'), input_sha256=expected_sha,
                native_validation_required=True)


def propose(problem, *, budget_s, params=None, attachments=(), rotations=(0,), node='node'):
    budget_s = number(budget_s, 'budget_s', positive=True)
    started = time.monotonic()
    params = dict(params or {})
    prepared = prepare(problem, rotations)
    source_sha = fingerprint(dict(problem=problem, prepared=prepared))
    remaining = budget_s - (time.monotonic() - started)
    if remaining <= 0:
        return dict(status='timeout', qualified=False, reason='packing preparation exhausted budget')
    try:
        process = subprocess.run([node, str(ROOT/'run.mjs')],
            input=json.dumps(dict(input=prepared['input'], input_sha256=source_sha)),
            text=True, capture_output=True, timeout=remaining, check=False)
    except subprocess.TimeoutExpired:
        return dict(status='timeout', qualified=False, reason='packing process deadline',
                    input_sha256=source_sha, elapsed_s=time.monotonic()-started)
    if process.returncode:
        return dict(status='backend_error', qualified=False, reason=process.stderr[-2000:],
                    input_sha256=source_sha, elapsed_s=time.monotonic()-started)
    result = admit(problem, prepared, json.loads(process.stdout), params, attachments=attachments)
    result['elapsed_s'] = time.monotonic()-started
    if result['elapsed_s'] >= budget_s:
        result.update(status='timeout', reason='packing validation exceeded deadline')
    result['adapter_files'] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                               for p in (ROOT/'run.mjs', ROOT/'package.json', ROOT/'package-lock.json')}
    return result
