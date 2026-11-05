"""Verify that moved footprints kept their definition and everything else on the board."""
import copy
from decimal import Decimal
from pathlib import Path

from placer.dru import _tree, _tokens
from .block_bindings import footprints, rotate
from .contracts import fingerprint
from .native_eco import locked


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


def verify_preserved(source, target, problem, pose):
    """Independently verify exact rigid poses and every unchanged native form."""
    def indexed(path):
        rows=footprints(path);result={f['props'].get('Reference'):f for f in rows}
        if len(result)!=len(rows) or any(not r for r in result):
            raise ValueError('ambiguous native footprint reference')
        return result
    before,after=indexed(source),indexed(target)
    refs=[r for u in problem['units'] for r in u['refs']]
    if len(refs)!=len(set(refs)) or set(refs)!=set(before) or set(before)!=set(after):
        raise ValueError('native/model footprint membership changed')
    changed=[]
    nm=lambda x:int(round(float(x)*1e6))
    for unit,dest in zip(problem['units'],pose):
        if tuple(dest)==(unit['x'],unit['y'],0):continue
        if unit['fixed']:raise ValueError('fixed unit moved')
        if any(unit.get(k) for k in ('borders','cuts','zones')):
            raise ValueError('owned drawings/cuts/zones need an explicit geometry transform contract')
        cx,cy=nm(unit['x']),nm(unit['y'])
        dx,dy=nm(dest[0]-unit['x']),nm(dest[1]-unit['y'])
        quarters=int(dest[2])
        if not(dx or dy or quarters):
            raise ValueError('proposed move collapses at native coordinate precision')
        for ref in unit['refs']:
            a,b=before[ref],after[ref]
            if locked(a['form']):raise ValueError('locked native footprint moved')
            x,y=rotate(nm(a['pose'][0])-cx,nm(a['pose'][1])-cy,quarters)
            expected=(x+cx+dx,y+cy+dy)
            if ((nm(b['pose'][0]),nm(b['pose'][1]))!=expected
                    or (b['pose'][2]-a['pose'][2]-90*quarters)%360):
                raise ValueError('native pose does not match proposed rigid transform: '+ref)
            if footprint_signature(a)!=footprint_signature(b):
                raise ValueError('native footprint definition changed: '+ref)
            changed.append(ref)
    if not changed:raise ValueError('proposal has no placement change')
    def protected(path):
        forms=_tree(_tokens(Path(path).read_text()))[0][1:];hashes=[]
        for f in forms:
            if f[0] in ('generator','generator_version'):continue
            if f[0]=='footprint':
                ref=next((x[2] for x in f if isinstance(x,list) and x[:2]==['property','Reference']),None)
                if ref in changed:continue
            hashes.append(fingerprint(f))
        return fingerprint(sorted(hashes))
    original=protected(source)
    if original!=protected(target):raise ValueError('unrelated native forms or retained copper changed')
    return sorted(changed),original
