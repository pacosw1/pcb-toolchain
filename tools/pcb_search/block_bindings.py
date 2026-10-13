"""Check hierarchical block identity before preserving its placement as a unit.

This check covers exact parts, pad definitions, injective net mapping and rigid
quarter-turn placement. It grants no copper reuse or electrical qualification.
Rules, stackup, boundaries, planes and target operating limits still need gates.
"""
import copy
from decimal import Decimal
from pathlib import Path

from block_reuse import read_block
from placer.dru import _tree, _tokens
from .contracts import fingerprint
from .native_srj import source_set


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


def pads(fp):
    result = {}
    for pad in fp['form'][1:]:
        if not isinstance(pad,list) or pad[0] != 'pad':
            continue
        number = pad[1]
        if not number or number in result:
            raise ValueError('unique numbered pads required for block binding')
        net = child(pad,'net',[''])[-1]
        if net.isdecimal():
            raise ValueError('legacy numeric pad net needs native normalization')
        shape = []
        for f in pad[2:]:
            if not isinstance(f,list):
                shape.append(f)
            elif f[0] == 'at':
                angle = Decimal(f[3]) if len(f)==4 else Decimal(0)
                local_angle = (angle-fp['pose'][2]) % 360
                shape.append(['at',str(Decimal(f[1]).normalize()),str(Decimal(f[2]).normalize()),
                              str(((local_angle+360)%360).normalize())])
            elif f[0] not in ('net','uuid','pinfunction','pintype'):
                shape.append(f)
        result[number] = dict(net=net,shape=fingerprint(shape))
    if not result:
        raise ValueError('block part has no numbered pads')
    return result


def rotate(x,y,quarters):
    # KiCad positive rotation is counterclockwise with Y pointing down.
    return ((x,y),(y,-x),(-x,-y),(-y,x))[quarters]


def bind_instance(directory, target, instance_path):
    directory,target = Path(directory).resolve(),Path(target).resolve()
    row = read_block(directory)
    if not instance_path.startswith('/') or instance_path.endswith('/'):
        raise ValueError('exact hierarchical instance path required')
    before = source_set(target)
    src = footprints(directory/(row['id']+'.kicad_pcb'))
    dst = [f for f in footprints(target) if f['path'].rsplit('/',1)[0] == instance_path]
    def indexed(fps):
        pairs = [(f['path'].rsplit('/',1)[-1],f) for f in fps]
        if not pairs or any(not k for k,_ in pairs) or len(dict(pairs)) != len(pairs):
            raise ValueError('missing or ambiguous schematic symbol identity')
        return dict(pairs)
    sources,targets = indexed(src),indexed(dst)
    if set(sources) != set(targets):
        raise ValueError('source/target instance component identities differ')
    refs,netmap,transforms = {},{},set()
    for uid,a in sources.items():
        b = targets[uid]
        ra,rb = a['props'].get('Reference'),b['props'].get('Reference')
        if not ra or not rb or ra in refs or rb in refs.values():
            raise ValueError('ambiguous reference mapping')
        refs[ra] = rb
        for field in ('MPN','LCSC','Value'):
            if not a['props'].get(field) or a['props'][field] != b['props'].get(field):
                raise ValueError(f'{ra}/{rb}: exact {field} differs or missing')
        if a['form'][1] != b['form'][1] or child(a['form'],'layer') != child(b['form'],'layer'):
            raise ValueError(f'{ra}/{rb}: footprint or side differs')
        for field in ('attr','dnp','exclude_from_bom','exclude_from_pos_files'):
            if child(a['form'],field) != child(b['form'],field):
                raise ValueError(f'{ra}/{rb}: assembly attribute differs: {field}')
        delta = ((b['pose'][2]-a['pose'][2])%360+360)%360
        if delta not in (0,90,180,270):
            raise ValueError('only rigid quarter-turn block placement supported')
        q = int(delta/90)
        x,y = rotate(*a['pose'][:2],q)
        transforms.add((q,b['pose'][0]-x,b['pose'][1]-y))
        ap,bp = pads(a),pads(b)
        if set(ap) != set(bp):
            raise ValueError(f'{ra}/{rb}: pad identities differ')
        for pin,p in ap.items():
            t = bp[pin]
            if p['shape'] != t['shape']:
                raise ValueError(f'{ra}/{rb}.{pin}: pad definition differs')
            if bool(p['net']) != bool(t['net']):
                raise ValueError(f'{ra}/{rb}.{pin}: connectedness differs')
            if p['net'] and netmap.setdefault(p['net'],t['net']) != t['net']:
                raise ValueError('one source net maps to multiple target nets')
    if len(set(netmap.values())) != len(netmap):
        raise ValueError('distinct block nets collapse to one target net')
    if len(transforms) != 1:
        raise ValueError('target block placement is no longer rigid')
    if before != source_set(target) or row['source_sha256'] != read_block(directory)['source_sha256']:
        raise ValueError('block or target changed during binding')
    q,x,y = next(iter(transforms))
    return dict(schema='iot-lab.block-binding.v1',status='candidate',qualified=False,
                block_id=row['id'],source_directory=str(directory),source_sha256=row['source_sha256'],
                target=str(target),target_inputs=before,instance_path=instance_path,
                refs=refs,net_map=netmap,transform=dict(rotation_quarters=q,translation_mm=[str(x),str(y)]),
                declared_level=row['declared_level'],open_items=row['open_items'],
                facts_errors=row['facts_errors'],missing_block_files=row['missing_files'],
                target_checks_required=row['target_checks_required'],copper_reuse_approved=False)


def verify_binding(binding):
    fresh = bind_instance(binding['source_directory'],binding['target'],binding['instance_path'])
    if fresh != binding:
        raise ValueError('stale block binding; inspect source and target again')
    return fresh


def attach_to_units(problem, bindings):
    """Use only on a fresh native model; require each bound block to be intact."""
    out = copy.deepcopy(problem)
    attached = []
    occupied = set()
    for binding in bindings:
        verify_binding(binding)
        if Path(problem['board_file']).resolve() != Path(binding['target']).resolve():
            raise ValueError('binding is for a different native board')
        wanted = set(binding['refs'].values())
        matches = [u for u in out['units'] if set(u['refs']) == wanted]
        if len(matches) != 1 or wanted & occupied:
            raise ValueError('reused block must be one distinct intact placement unit')
        occupied.update(wanted)
        attached.append(dict(unit=matches[0]['name'],refs=sorted(wanted),binding_sha256=fingerprint(binding)))
    out['block_bindings'] = attached
    return out
