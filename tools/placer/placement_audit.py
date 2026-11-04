"""Attributed placement diagnostics; no automatic score tuning or board promotion."""
import hashlib
import json
import math
from pathlib import Path


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def identity(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False).encode()).hexdigest()


def movement(pr, pose, baseline=None):
    before = baseline or [(u['x'], u['y'], 0) for u in pr['units']]
    if len(pose) != len(pr['units']) or len(before) != len(pose):
        raise ValueError('pose/unit cardinality mismatch')
    rows = []
    for u, a, b in zip(pr['units'], before, pose):
        if len(b) != 3 or not all(math.isfinite(float(v)) for v in b):
            raise ValueError('nonfinite or malformed pose')
        rows.append(dict(unit=u['name'], refs=u.get('refs', []), fixed=bool(u['fixed']),
                         displacement_mm=math.hypot(b[0]-a[0], b[1]-a[1]), turn_delta=(b[2]-a[2]) % 4))
    return rows


def candidate_report(pr, c, params, seeded=False, max_displacement=None):
    rows = movement(pr, c['pose'])
    faults = list(c.get('illegal', []))
    if c.get('timeout'):
        faults.append('incomplete placement')
    for r in rows:
        if r['fixed'] and (r['displacement_mm'] > 1e-6 or r['turn_delta']):
            faults.append('fixed unit moved: '+r['unit'])
        if seeded and r['turn_delta']:
            faults.append('seeded turn changed: '+r['unit'])
        if max_displacement is not None and r['displacement_mm'] > max_displacement+1e-6:
            faults.append('displacement cap exceeded: '+r['unit'])
    if seeded and any(params.get(k, 0) for k in ('p_swap','p_rot','global','rotate','legal_rotate')):
        faults.append('seeded policy incompatible with actual search parameters')
    if seeded:
        anchors = [(u['x'],u['y']) for u in pr['units']]
        for i, a in enumerate(anchors):
            for j in range(i):
                b=anchors[j]
                if (a != b and tuple(c['pose'][i][:2]) == tuple(b) and
                        tuple(c['pose'][j][:2]) == tuple(a)):
                    faults.append('seeded units swapped: %s/%s' % (pr['units'][i]['name'],pr['units'][j]['name']))
    pre = c.get('prelegal_pose')
    return dict(candidate_sha256=identity(dict(pose=c['pose'], problem=pr, params=params)),
                components=c.get('components'), params=params, movement=rows,
                legalizer_movement=movement(pr, c['pose'], pre) if pre is not None else None,
                illegal=faults, qualified=False,
                constraints=dict(problem_sha256=identity(pr), fixed_units=[r['unit'] for r in rows if r['fixed']],
                                 fixed_copper_items=len(pr['board'].get('fixed_copper', [])),
                                 keepout_areas=len(pr['board'].get('keepouts', [])),
                                 via_keepout_areas=len(pr['board'].get('via_keepouts', [])),
                                 edge_clearance_mm=pr['board'].get('edge_clearance'),
                                 route_rules=pr.get('route_rules'),
                                 functional_groups=sum(len(u.get('refs', []))>1 for u in pr['units']),
                                 via_nets=pr.get('via_nets', []), mains_faults=c.get('mains', []),
                                 domain_areas=len(pr.get('domain_areas', [])), class_gaps=pr.get('class_gaps'),
                                 decoupling_pairs=len(pr.get('decaps', [])), unsupported=pr.get('dru_ignored', []),
                                 note='native preflight and full gate remain mandatory'))


def bounded_feedback(pr, route_dir, board_sha256, prior, cap_mm, congestion=False):
    """Only complete, clean native results on this exact candidate may teach hints."""
    rd = Path(route_dir)
    try:
        manifest = json.loads((rd/'input-manifest.json').read_text())
        outcome = json.loads((rd/'outcome.json').read_text())
    except (OSError, ValueError):
        return dict(prior), {'accepted':False, 'reason':'missing complete attributed evidence'}
    routed = rd/'routed.kicad_pcb'
    if (manifest.get('board_sha256') != board_sha256 or outcome.get('status') != 'complete' or
            outcome.get('errors') != 0 or not routed.is_file() or outcome.get('board_sha256') != digest(routed)):
        return dict(prior), {'accepted':False, 'reason':'candidate mismatch, incomplete or native errors'}
    allowed = {r for u in pr['units'] if not u['fixed'] for r in u.get('refs', [u['name']])}
    additions, sources = {}, {}
    path = rd/'pin-escape.json'
    if path.is_file():
        raw = json.loads(path.read_text())
        additions.update(raw.get('halo_hint', {}))
        sources[str(path)] = digest(path)
    path = rd/'open-triage.json'
    if congestion and path.is_file():
        for conn in json.loads(path.read_text()).get('connections', []):
            if conn.get('class') == 'ENCLOSED':
                for ref in conn.get('blocking_parts', []):
                    additions[ref] = max(additions.get(ref, 0), .25)
        sources[str(path)] = digest(path)
    out = dict(prior)
    for ref in sorted(set(additions) & allowed)[:8]:
        value = float(additions[ref])
        if math.isfinite(value) and value > 0:
            out[ref] = min(cap_mm, out.get(ref, 0)+min(value, .5))
    return out, dict(accepted=True, source_board_sha256=board_sha256, sources=sources,
                     cap_mm=cap_mm, per_update_limit_mm=.5, max_refs_per_update=8, hints=out,
                     note='bounded soft spacing; never relaxes native constraints or moves fixed units')


def ranks(xs):
    return [1+sum(y<x for y in xs)+(sum(y==x for y in xs)-1)/2 for x in xs]


def candidate_key(c):
    return (len(c['illegal']), bool(c.get('timeout')), len(c.get('mains', [])), c['cost'])


def spearman(xs, ys):
    if len(xs) != len(ys) or len(xs) < 3:
        return None
    a, b = ranks(xs), ranks(ys)
    am, bm = sum(a)/len(a), sum(b)/len(b)
    den = math.sqrt(sum((x-am)**2 for x in a)*sum((y-bm)**2 for y in b))
    return sum((x-am)*(y-bm) for x,y in zip(a,b))/den if den else None


def archive(loop, expected_sha256):
    root = Path(loop).resolve()
    if digest(root/'run.json') != expected_sha256:
        raise ValueError('archive run identity mismatch')
    run = json.loads((root/'run.json').read_text())
    rows = []
    for i, step in enumerate(run['steps']):
        # Ignore archived absolute path references; every artifact resolves under this archive.
        d = root/f'step-{i}'
        res = json.loads((d/'search/res.json').read_text())
        native = json.loads((d/'route-0/drc.json').read_text())
        router = json.loads((d/'route-0/report.json').read_text())
        paths = [d/'prob.json', d/'search/res.json', d/'route-0/drc.json', d/'route-0/report.json', d/'route-0/routed.kicad_pcb']
        c = res['candidates'][0]
        rows.append(dict(step=i, real=abs(step['k']-1)<1e-6, halo=step['s'],
                         cost=c['cost'], components=c['components'], native_open=len(native['unconnected_items']),
                         native_errors=sum(v.get('severity')=='error' for v in native['violations']),
                         router_unrouted=router['stats']['unrouted'],
                         attribution={str(p.relative_to(root)):digest(p) for p in paths},
                         movement=candidate_report(run['problem'],c,res['params'])['movement']))
    real = [r for r in rows if r['real']]
    corr = {name:spearman([r['cost'] if name=='cost' else r['components'][name] for r in real],
                         [r['native_open'] for r in real]) for name in ('cost','hpwl','cong','spacing')}
    return dict(run_sha256=expected_sha256, candidates=rows, real_samples=len(real),
                correlation_vs_native_opens=corr, qualified=False, adopt=False,
                note='observational archive; differing halo, one route per pose, no fresh full gate or held-out repetition; virtual excluded')


def main():
    import argparse
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('loop'); ap.add_argument('--expected-run-sha256', required=True); ap.add_argument('-o', required=True)
    a=ap.parse_args()
    Path(a.o).write_text(json.dumps(archive(a.loop,a.expected_run_sha256),indent=2)+'\n')


if __name__ == '__main__':
    main()
