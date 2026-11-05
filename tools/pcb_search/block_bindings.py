"""The native footprint reader route_hole_coverage and route_rule_coverage still use. Block binding is lib/block-bindings.ts."""
from decimal import Decimal
from pathlib import Path

from placer.dru import _tree, _tokens


def child(form, name, default=None):
    rows = [f[1:] for f in form if isinstance(f,list) and f and f[0] == name]
    if len(rows) > 1:
        raise ValueError('ambiguous native field: '+name)
    return rows[0] if rows else default


def footprints(path):
    roots = _tree(_tokens(Path(path).read_text()))
    if len(roots) != 1 or roots[0][0] != 'kicad_pcb':
        raise ValueError('expected native PCB')
    result = []
    for f in roots[0][1:]:
        if f[0] != 'footprint':
            continue
        props = [x[1:3] for x in f if isinstance(x,list) and x[0]=='property']
        if len(dict(props)) != len(props):
            raise ValueError('duplicate footprint property')
        at = child(f,'at')
        if not at or len(at) not in (2,3):
            raise ValueError('missing footprint pose')
        pose = [Decimal(v) for v in at] + ([Decimal(0)] if len(at)==2 else [])
        if any(not v.is_finite() for v in pose):
            raise ValueError('nonfinite footprint pose')
        result.append(dict(form=f,props=dict(props),pose=pose,
                           path=child(f,'path',[''])[0].rstrip('/')))
    return result
