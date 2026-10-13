"""Cheap placement refinement using the existing placer geometry and cost model.

Screens every unit, including fixed/fixed geometry the search objective excludes.
Anchored derived copper must be regenerated before a moved owner can advance.
Screened poses remain candidates: native rules are not replaced by raster costs.
"""
import copy
import math
import time

from placer import cost
from .contracts import box, fingerprint, number


def anchor_fingerprint(problem, pose, owners):
    index = {u['name']: i for i, u in enumerate(problem['units'])}
    if len(index) != len(problem['units']) or not owners or len(set(owners)) != len(owners):
        raise ValueError('unique unit names and nonempty unique attachment owners required')
    if not set(owners) <= set(index):
        raise ValueError('unknown attachment owner')
    # A changed local pad/block definition invalidates derived geometry too.
    return fingerprint({name: {'unit': problem['units'][index[name]], 'pose': pose[index[name]]}
                        for name in sorted(owners)})


def screen_pose(problem, pose, params, *, attachments=()):
    if len(pose) != len(problem['units']):
        raise ValueError('pose/unit count mismatch')
    names = [u['name'] for u in problem['units']]
    if len(set(names)) != len(names):
        raise ValueError('duplicate unit')
    errors = []
    occupied_refs = set()
    for binding in problem.get('block_bindings', []):
        refs = set(binding['refs'])
        matches = [u for u in problem['units'] if u['name'] == binding['unit'] and set(u['refs']) == refs]
        if not refs or len(matches) != 1 or refs & occupied_refs:
            errors.append('bound block is not one distinct intact unit: ' + binding['unit'])
        occupied_refs.update(refs)
    move_box = box(problem['move_box']) if problem.get('move_box') else None
    cap = number(params.get('max_displacement', 0), 'max_displacement')
    for u, p in zip(problem['units'], pose):
        if (len(p) != 3 or any(isinstance(v, bool) or not isinstance(v, (int, float)) or
                              not math.isfinite(v) for v in p) or p[2] not in (0, 1, 2, 3)):
            raise ValueError('invalid placement pose')
        if u['fixed'] and tuple(p) != (u['x'], u['y'], 0):
            errors.append('fixed unit moved: ' + u['name'])
        if not u.get('rotate', True) and p[2]:
            errors.append('unit rotation forbidden: ' + u['name'])
        if not u['fixed'] and move_box:
            a, b, c, d = move_box
            if not (a <= p[0] <= c and b <= p[1] <= d):
                errors.append('movement region: ' + u['name'])
        if cap and math.hypot(p[0]-u['x'], p[1]-u['y']) > cap:
            errors.append('displacement cap: ' + u['name'])
    stale = []
    for a in attachments:
        if set(a) != {'id', 'owners', 'anchor_sha256', 'geometry_sha256'}:
            raise ValueError('invalid derived-geometry contract')
        for field in ('anchor_sha256', 'geometry_sha256'):
            v = a[field]
            if not isinstance(v, str) or len(v) != 64 or any(c not in '0123456789abcdef' for c in v):
                raise ValueError('invalid attachment fingerprint')
        if a['anchor_sha256'] != anchor_fingerprint(problem, pose, a['owners']):
            stale.append(a['id'])
    # Do not trust 'illegal' or 'cost' fields produced by a backend; recompute.
    all_units = copy.deepcopy(problem)
    for unit in all_units['units']:
        unit['fixed'] = False
    terms = cost.components(all_units, pose, params)
    if any(not math.isfinite(v) for v in terms.values()):
        raise ValueError('nonfinite placement score')
    # Courtyard/pad bounding boxes and raster masks are conservative projections.
    # A positive area can be a false conflict (e.g. an assembly courtyard over a
    # cutout while the actual copper clears it). Escalate to exact native and
    # board-specific checks; do not call this a proven input defect or waive it.
    geometry_conflicts = [term for term in ('overlap', 'oob') if terms[term] > 0]
    for i, u in enumerate(problem['units']):
        if cost.rule_miss(problem, pose, i) > 0:
            errors.append('part rule: ' + u['name'])
    unsupported = list(problem.get('dru_ignored', []))
    for name in set(problem.get('part_rules') or {}) - {'regions', 'min_dist'}:
        unsupported.append('part rule type: ' + name)
    if params.get('mains'):
        unsupported.append('mains path diagnostic must be run separately')
    status = ('reject' if errors else 'needs_regeneration' if stale else 'unknown' if unsupported
              else 'needs_native_check' if geometry_conflicts else 'candidate')
    return dict(schema='iot-lab.placement-screen.v1', status=status, qualified=False,
                input_sha256=fingerprint(dict(problem=problem, pose=pose, params=params, attachments=attachments)),
                errors=errors, geometry_conflicts=geometry_conflicts,
                stale_attachments=stale, unsupported=unsupported, components=terms,
                native_validation_required=True)


def quench(problem, *, steps_mm, budget_s, params=None, attachments=(), clock=time.monotonic):
    """Bounded coordinate descent; rigid units retained, fixed parts never moved.

steps_mm is a search policy, not an electrical allowance. No default displacement
or electrical threshold is invented here. More costly solvers handle rejected
seeds or remaining congestion. Derived-copper moves abstain until regenerated.
"""
    budget_s = number(budget_s, 'budget_s', positive=True)
    if not steps_mm:
        raise ValueError('positive budget and search steps required')
    if any(isinstance(s, bool) or not isinstance(s, (float, int)) or not math.isfinite(s) or s <= 0 for s in steps_mm):
        raise ValueError('finite positive search steps required')
    started = clock()
    params = dict(params or {})
    pose = [list(x) for x in cost.initial_pose(problem)]
    incumbent = screen_pose(problem, pose, params, attachments=attachments)
    result = dict(schema='iot-lab.placement-quench.v1', qualified=False, initial=incumbent,
                  moves=[], evaluated=1, status=incumbent['status'], pose=pose)
    if clock() - started >= budget_s:
        result.update(status='timeout', elapsed_s=clock() - started)
        return result
    if incumbent['status'] not in ('candidate', 'needs_native_check'):
        result['elapsed_s'] = clock() - started
        return result

    def rank(screen):
        c = screen['components']
        # Pareto safeguard below prevents worse routability proxies being hidden
        # by a weighted wirelength improvement. Actual routing remains decisive.
        return c['cong'], c['via'], c['hpwl'], c['spacing']

    def geometry(screen):
        c = screen['components']
        return c['overlap'], c['oob']

    old = rank(incumbent)
    timed_out = False
    for step in steps_mm:
        for i, u in enumerate(problem['units']):
            if u['fixed']:
                continue
            best = None
            repairing = incumbent['status'] == 'needs_native_check'
            old_geometry = geometry(incumbent)
            for dx, dy in ((step, 0), (-step, 0), (0, step), (0, -step)):
                if clock() - started >= budget_s:
                    timed_out = True
                    break
                candidate = copy.deepcopy(pose)
                candidate[i][0] += dx
                candidate[i][1] += dy
                report = screen_pose(problem, candidate, params, attachments=attachments)
                result['evaluated'] += 1
                if clock() - started >= budget_s:
                    timed_out = True
                    break
                r = rank(report)
                g = geometry(report)
                # Repair a conservative geometry conflict without declaring it
                # a proven native defect. Each move must reduce the conflict,
                # worsen neither geometry term, and satisfy every structural,
                # movement, part-rule and attachment constraint. Routing proxies
                # rank legal placement only after geometry is cleared.
                if repairing:
                    admissible = (report['status'] in ('candidate', 'needs_native_check')
                        and all(a <= b for a, b in zip(g, old_geometry)) and g != old_geometry)
                    score = (sum(g), *g, *r)
                else:
                    admissible = (report['status'] == 'candidate'
                        and all(a <= b for a, b in zip(r[:3], old[:3])) and r < old)
                    score = r
                if admissible and (best is None or score < best[0]):
                    best = (score, candidate, report)
            if timed_out:
                break  # do not admit a partially evaluated round
            if best:
                _, pose, incumbent = best
                old = rank(incumbent)
                result['moves'].append(dict(unit=u['name'], pose=pose[i], screen_sha256=incumbent['input_sha256'],
                                           phase='geometry' if repairing else 'routing_proxies'))
        if timed_out:
            break
    result.update(status='timeout' if timed_out else incumbent['status'], pose=pose,
                  final=incumbent, elapsed_s=clock() - started)
    return result
