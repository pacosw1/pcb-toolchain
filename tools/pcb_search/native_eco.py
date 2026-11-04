"""Small native copper proposals for a diagnosed placement conflict.

Move one unlocked two-layer via along an incident straight trace, preserving
both original traces and adding a bridge on the other layer. This is only a
proposal: native DRC/connectivity and the board's full gates decide acceptance.
"""
import argparse
from decimal import Decimal, ROUND_HALF_EVEN
import json
from pathlib import Path
import shutil
import uuid

from block_extract import _spans
from placer.dru import _tree, _tokens
from .block_bindings import child
from .contracts import fingerprint, number
from .native_candidate import copper_items
from .native_srj import geometry_digest, source_set


def point(form, field):
    values = child(form, field)
    if not values or len(values) != 2:
        raise ValueError('expected native two-dimensional point')
    result = tuple(Decimal(v) for v in values)
    if any(not v.is_finite() for v in result):
        raise ValueError('nonfinite native point')
    return result


def locked(form):
    return 'locked' in form or child(form, 'locked', ['no']) != ['no']


def prepare_shift(source, via_id, along_id, *, fraction):
    """Validate one exact local topology and compute a move without writing."""
    number(fraction, 'fraction', positive=True)
    if fraction >= 1:
        raise ValueError('fraction must lie strictly inside the incident trace')
    source = Path(source).resolve()
    before = source_set(source)
    text, items = copper_items(source)
    forms = {uid: _tree(_tokens(text[a:b]))[0] for uid, row in items.items() for a, b in [row['span']]}
    root = _tree(_tokens(text))[0]
    layers = child(root, 'layers', [])
    if {row[1] for row in layers if isinstance(row, list) and row[1].endswith('.Cu')} != {'F.Cu', 'B.Cu'}:
        raise ValueError('this local pattern requires a two-layer board')
    if via_id not in items or items[via_id]['kind'] != 'via':
        raise ValueError('identified source via required')
    via = forms[via_id]
    if (locked(via) or any(kind in via for kind in ('blind', 'micro'))
            or child(via, 'layers') != ['F.Cu', 'B.Cu']):
        raise ValueError('unlocked through via required')
    origin = point(via, 'at')
    incident = []
    for uid, row in items.items():
        if row['net'] != items[via_id]['net'] or row['kind'] not in ('segment', 'arc'):
            continue
        f = forms[uid]
        if origin in (point(f, 'start'), point(f, 'end')):
            if row['kind'] != 'segment':
                raise ValueError('incident arc requires a richer repair')
            incident.append(uid)
        elif row['kind'] == 'segment':
            a, b = point(f, 'start'), point(f, 'end')
            if ((b[0]-a[0])*(origin[1]-a[1]) == (b[1]-a[1])*(origin[0]-a[0])
                    and all(min(x,y) <= z <= max(x,y) for x,y,z in zip(a,b,origin))):
                raise ValueError('via lies inside another segment; branch repair required')
    if len(incident) != 2 or along_id not in incident:
        raise ValueError('exactly two incident source segments required')
    other_id = next(uid for uid in incident if uid != along_id)
    along, other = forms[along_id], forms[other_id]
    if locked(along) or locked(other):
        raise ValueError('locked incident copper requires explicit ownership handling')
    if {child(along, 'layer')[0], child(other, 'layer')[0]} != {'F.Cu', 'B.Cu'}:
        raise ValueError('incident traces must occupy opposite layers')
    anchor = next((q for q in (point(along, 'start'), point(along, 'end')) if q != origin), None)
    if anchor is None:
        raise ValueError('zero-length incident trace')
    # Native coordinates are integer nanometres. This is serialization precision,
    # not a clearance tolerance or an electrical-rule relaxation.
    grid = Decimal('0.000001')
    destination = tuple((a+(b-a)*Decimal(str(fraction))).quantize(grid, rounding=ROUND_HALF_EVEN)
                        for a,b in zip(origin,anchor))
    if destination in (origin,anchor):
        raise ValueError('fraction collapses at native coordinate precision')
    # Quantization must not move the via off the unchanged trace centreline.
    if ((anchor[0]-origin[0])*(destination[1]-origin[1])
            != (anchor[1]-origin[1])*(destination[0]-origin[0])):
        raise ValueError('quantized position is not on the incident centreline')
    return before,text,items,forms,other_id,origin,destination


def shift_via(source, via_id, along_id, out, *, fraction):
    source,out=Path(source).resolve(),Path(out).resolve()
    if out.exists() or out==source.parent:
        raise ValueError('new separate output directory required')
    before,text,items,forms,other_id,origin,destination=prepare_shift(source,via_id,along_id,fraction=fraction)
    other=forms[other_id]
    fmt = lambda value: format(value, 'f')
    va, vb = items[via_id]['span']
    fields = [(a,b) for a,b in _spans(text,va,vb) if _tree(_tokens(text[a:b]))[0][0] == 'at']
    if len(fields) != 1:
        raise ValueError('ambiguous via origin')
    a,b = fields[0]
    changed = text[:a]+'(at '+' '.join(map(fmt,destination))+')'+text[b:]
    width = child(other,'width')[0]
    number(float(width), 'source track width', positive=True)
    bridge_id = str(uuid.uuid5(uuid.NAMESPACE_URL, fingerprint(dict(sources=before, via=via_id,
        along=along_id, destination=list(map(fmt,destination))))))
    if bridge_id in items:
        raise ValueError('bridge identity already exists')
    oa,ob = items[other_id]['span']
    net_fields = [text[a:b] for a,b in _spans(text,oa,ob) if _tree(_tokens(text[a:b]))[0][0] == 'net']
    if len(net_fields) != 1:
        raise ValueError('ambiguous source net')
    bridge = ('\n(segment (start '+' '.join(map(fmt,origin))+') (end '+' '.join(map(fmt,destination))+')'
              +' (width '+width+') (layer '+json.dumps(child(other,'layer')[0])+') '+net_fields[0]
              +' (uuid "'+bridge_id+'"))\n')
    end = changed.rfind(')')
    changed = changed[:end]+bridge+changed[end:]
    out.mkdir(parents=True,exist_ok=False)
    target = out/'proposal.kicad_pcb';target.write_text(changed)
    for ext in ('.kicad_pro','.kicad_dru','.kicad_sch'):
        shutil.copy2(source.with_suffix(ext),target.with_suffix(ext))
    if (source_set(source) != before or geometry_digest(source,[via_id])
            != geometry_digest(target,[via_id,bridge_id])):
        raise ValueError('source changed or repair touched unrelated native content')
    record = dict(schema='iot-lab.native-via-eco.v1', status='candidate', qualified=False,
        sources=before, output_files=source_set(target), via_id=via_id, along_trace_id=along_id,
        other_trace_id=other_id, added_bridge_id=bridge_id, fraction=fraction,
        origin_mm=list(map(fmt,origin)), destination_mm=list(map(fmt,destination)),
        protected_geometry_sha256=geometry_digest(source,[via_id]),
        edits='One via origin and one new bridge; all original tracks unchanged',
        native_and_board_specific_gates_required=True)
    (out/'record.json').write_text(json.dumps(record,indent=2))
    return record


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('board');ap.add_argument('via');ap.add_argument('along_track');ap.add_argument('out')
    ap.add_argument('--fraction',required=True,type=float)
    args=ap.parse_args()
    try:
        shift_via(args.board,args.via,args.along_track,args.out,fraction=args.fraction)
        print('PASS: local via proposal; all original tracks retained; native and board gates required')
        return 0
    except (ValueError,KeyError,TypeError,OSError) as error:
        print('STUCK: '+str(error));return 3


if __name__=='__main__':raise SystemExit(main())
