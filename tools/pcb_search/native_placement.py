"""Import a source-bound placement proposal while retaining all native copper.

Run in a fresh KiCad Python process. The result is an unqualified board for
native DRC, connectivity and board-specific gates, then local repair if needed.
"""
import argparse
import copy
from decimal import Decimal
import json
from pathlib import Path
import shutil

from placer.dru import _tree, _tokens
from .block_bindings import child, footprints, rotate
from .contracts import fingerprint
from .native_eco import locked
from .native_srj import digest, source_set


def restrict_movement(problem, refs=None, *, no_rotate=False):
    """Only tighten fresh native constraints; never unfix a native fixed part."""
    all_refs=[r for u in problem['units'] for r in u['refs']]
    if len(all_refs)!=len(set(all_refs)):
        raise ValueError('duplicate placement reference')
    if refs is not None:
        if not refs or len(refs)!=len(set(refs)) or not set(refs)<=set(all_refs):
            raise ValueError('unique known movable references required')
        selected=set(refs)
        for unit in problem['units']:
            members=set(unit['refs'])
            if members & selected and not members<=selected:
                raise ValueError('select every reference in a rigid unit')
        for unit in problem['units']:
            unit['fixed']=bool(unit['fixed'] or not set(unit['refs'])<=selected)
    if no_rotate:
        for unit in problem['units']:unit['rotate']=False


def read_proposal(folder, proposal):
    from .placement import screen_pose
    folder,proposal=Path(folder),Path(proposal)
    manifest=json.loads((folder/'record.json').read_text())
    model=folder/'placement.json';raw=json.loads(model.read_text())
    source=Path(manifest['board']).resolve()
    if (manifest.get('schema')!='iot-lab.native-export.v1'
            or manifest.get('status') not in ('candidate','needs_native_check')
            or manifest.get('source_mutated') is not False
            or manifest.get('native',{}).get('parity')!=0
            or '--schematic-parity' not in manifest.get('drc_command',[])
            or manifest['inputs']!=source_set(source)
            or manifest['placement_sha256']!=digest(model)):
        raise ValueError('stale or rejected native placement export')
    if set(raw)!={'problem','params','attachments'}:
        raise ValueError('unexpected placement model')
    if Path(raw['problem']['board_file']).resolve()!=source:
        raise ValueError('placement model targets another source board')
    result=json.loads(proposal.read_text())
    if (result.get('schema') not in ('iot-lab.placement-quench.v1','iot-lab.packing-proposal.v1')
            or result.get('source_sha256')!=fingerprint(raw)
            or result.get('qualified') is not False
            or result.get('status') not in ('candidate','needs_native_check')):
        raise ValueError('no matching completed placement proposal')
    screen=screen_pose(raw['problem'],result['pose'],raw['params'],attachments=raw['attachments'])
    if screen['status'] not in ('candidate','needs_native_check'):
        raise ValueError('placement constraints reject proposal: '+screen['status'])
    return source,manifest,raw,result,screen


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


def import_placement(folder, proposal, out):
    from placer.kicad_io import write_board
    folder,proposal,out=Path(folder).resolve(),Path(proposal).resolve(),Path(out).resolve()
    if out.exists():raise ValueError('new separate output directory required')
    input_hashes={str(p):digest(p) for p in (folder/'record.json',folder/'placement.json',proposal)}
    source,manifest,raw,result,screen=read_proposal(folder,proposal)
    # Reject unsupported owned geometry before the native writer runs. Its
    # movement must be represented explicitly, not silently exempted from hashes.
    for unit,pose in zip(raw['problem']['units'],result['pose']):
        if tuple(pose)!=(unit['x'],unit['y'],0) and any(unit.get(k) for k in ('borders','cuts','zones')):
            raise ValueError('owned drawings/cuts/zones need an explicit geometry transform contract')
    out.mkdir(parents=True,exist_ok=False);target=out/'proposal.kicad_pcb'
    report=write_board(str(source),raw['problem'],result['pose'],str(target),retain_copper=True)
    changed,protected=verify_preserved(source,target,raw['problem'],result['pose'])
    for ext in ('.kicad_pro','.kicad_dru','.kicad_sch'):
        shutil.copy2(source.with_suffix(ext),target.with_suffix(ext))
    if (manifest['inputs']!=source_set(source)
            or any(digest(Path(p))!=h for p,h in input_hashes.items())
            or report['removed_tracks'] or report['moved_block_tracks']):
        raise ValueError('input changed or native writer did not retain all copper')
    record=dict(schema='iot-lab.native-placement.v1',status='candidate',qualified=False,
        sources=manifest['inputs'],input_files=input_hashes,output_files=source_set(target),
        moved_refs=changed,screen=screen,write_report=report,copper_policy='retain',
        protected_geometry_sha256=protected,native_and_board_specific_gates_required=True)
    (out/'record.json').write_text(json.dumps(record,indent=2))
    return record


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('export_folder');ap.add_argument('proposal');ap.add_argument('out')
    args=ap.parse_args()
    try:
        result=import_placement(args.export_folder,args.proposal,args.out)
        print(f"PASS: native placement proposal; {len(result['moved_refs'])} moved footprints, all copper retained; native gates required")
        return 0
    except (ValueError,KeyError,TypeError,OSError) as error:
        print('STUCK: '+str(error));return 3


if __name__=='__main__':raise SystemExit(main())
