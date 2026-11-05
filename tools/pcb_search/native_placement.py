"""The footprint signature route_rule_coverage still uses. TS: lib/native-board.ts; pose checks: lib/native-placement.ts."""
import copy
from decimal import Decimal

from .contracts import fingerprint


def footprint_signature(fp):
    """Preserve the footprint definition while allowing a rigid native pose.

    Pad/text at angles are world angles in KiCad; normalize them to the parent.
    Local coordinates, pad shapes, nets, properties, IDs and other fields remain
    in the signature. Unknown native serialization changes therefore abstain.
    """
    form=copy.deepcopy(fp['form']);angle=fp['pose'][2]
    form=[f for f in form if not(isinstance(f,list) and f[0]=='at')]
    for f in form:
        if not isinstance(f,list) or f[0] not in ('pad','property','fp_text'):continue
        for at in f:
            if isinstance(at,list) and at[0]=='at':
                if len(at) not in (3,4):raise ValueError('unsupported local pose')
                degrees=(Decimal(at[3]) if len(at)==4 else Decimal(0))-angle
                canonical=lambda v:str(v.normalize()) if v else '0'
                at[:]=['at',canonical(Decimal(at[1])),canonical(Decimal(at[2])),
                       canonical((degrees%360+360)%360)]
    # KiCad sorts independent footprint items differently after a rotation.
    # Preserve each entire item (including its UUID and ordered polygon points),
    # while ignoring only the order of these sibling forms. Keep multiplicity.
    return fingerprint(dict(header=form[:2],fields=sorted(fingerprint(f) for f in form[2:])))
