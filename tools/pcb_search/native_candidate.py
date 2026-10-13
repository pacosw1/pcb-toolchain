"""Admit only new requested-net copper from a native backend output.

Every original native form must remain identical. Added copper is a proposal
requiring native DRC/refill and the existing board-specific gates.
"""
import argparse
import json
from pathlib import Path
import shutil

from block_extract import _spans
from placer.dru import _tree, _tokens
from .native_srj import digest, geometry_digest, source_set


def copper_items(path):
    text = Path(path).read_text()
    forms = _tree(_tokens(text))
    if len(forms) != 1 or not forms[0] or forms[0][0] != 'kicad_pcb':
        raise ValueError('unexpected native board root')
    table = {}
    for f in forms[0][1:]:
        if f[0] == 'net' and len(f) == 3:
            if f[1] in table:
                raise ValueError('duplicate native net code')
            table[f[1]] = f[2]
    result = {}
    for a,b in _spans(text,text.index('('),len(text)):
        form = _tree(_tokens(text[a:b]))[0]
        if form[0] not in ('segment','arc','via'):
            continue
        uid = next((v[1] for v in form[1:] if isinstance(v,list) and v[0]=='uuid'),None)
        net = next((v[-1] for v in form[1:] if isinstance(v,list) and v[0]=='net'),None)
        # KiCad 9 stores numeric codes on copper; KiCad 10 stores names.
        # Never silently interpret an unresolved legacy code as a net name.
        if isinstance(net,str) and net.isdecimal():
            if net not in table:
                raise ValueError('unresolved numeric native net')
            net = table[net]
        if not uid or uid in result or not isinstance(net,str) or not net:
            raise ValueError('routing item lacks unique identity or native net')
        result[uid] = dict(span=(a,b),net=net,kind=form[0])
    return text,result


def scope_native(source, candidate, out, nets):
    source,candidate,out = Path(source).resolve(),Path(candidate).resolve(),Path(out).resolve()
    if not nets or len(set(nets)) != len(nets) or any(not isinstance(n,str) or not n for n in nets):
        raise ValueError('explicit unique net names required')
    sources = source_set(source); candidate_sha = digest(candidate)
    _,original = copper_items(source); text,items = copper_items(candidate)
    added = set(items)-set(original)
    if set(original)-set(items) or geometry_digest(source) != geometry_digest(candidate,added):
        raise ValueError('backend changed protected native board content')
    discard = [uid for uid in added if items[uid]['net'] not in nets]
    retained = sorted(added-set(discard))
    if not retained:
        raise ValueError('backend proposed no new copper on requested nets')
    for start,end in sorted((items[uid]['span'] for uid in discard),reverse=True):
        text = text[:start]+text[end:]
    out.mkdir(parents=True,exist_ok=False)
    target = out/'candidate.kicad_pcb';target.write_text(text)
    for ext in ('.kicad_pro','.kicad_dru','.kicad_sch'):
        shutil.copy2(source.with_suffix(ext),target.with_suffix(ext))
    if (sources != source_set(source) or candidate_sha != digest(candidate)
            or geometry_digest(source) != geometry_digest(target,retained)):
        raise ValueError('source changed or protected geometry differs after scoping')
    record = dict(schema='iot-lab.native-candidate.v1',status='candidate',qualified=False,
                  sources=sources,backend_output_sha256=candidate_sha,selected_nets=nets,
                  added_items=retained,discarded_items=sorted(discard),
                  protected_geometry_sha256=geometry_digest(source),output_files=source_set(target),
                  native_and_board_specific_gates_required=True)
    (out/'record.json').write_text(json.dumps(record,indent=2))
    return record


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('source');ap.add_argument('candidate');ap.add_argument('out')
    ap.add_argument('--net',action='append',required=True)
    args=ap.parse_args()
    try:
        r=scope_native(args.source,args.candidate,args.out,args.net)
        print(f"PASS: native proposal scoped; {len(r['added_items'])} added, {len(r['discarded_items'])} discarded; native checks required")
        return 0
    except (ValueError,OSError,KeyError,TypeError) as e:
        print('STUCK: '+str(e));return 3


if __name__=='__main__':
    raise SystemExit(main())
