"""Prove a narrow PTH hole rule from actual exported circular pin obstacles.

This is a model-containment check, never a native electrical acceptance. It
covers new other-net tracks only. The caller must independently preserve all
source footprints/holes, establish actual routing layers and clearance floor,
bind these inputs, and run the final fresh configured gate.
"""
from decimal import Decimal, Inexact, Rounded, localcontext
from pathlib import Path
import re

from pcb_search.block_bindings import child, footprints
import route_features

SCHEMA = 'iot-lab.route-hole-coverage.v1'
PAD_FIELDS = {'reference','pad','net','side','footprint_position_mm','footprint_rotation_deg',
              'position_mm','size_mm','drill_mm','drill_offset_mm','shape','layers'}
UNITS = {'mm':Decimal(1),'um':Decimal('0.001'),'mil':Decimal('0.0254'),'inch':Decimal('25.4'),'in':Decimal('25.4')}


def _d(value):
    if isinstance(value,bool) or not isinstance(value,(str,int,float,Decimal)):
        raise ValueError('expected finite decimal geometry')
    text=str(value)
    if not re.fullmatch(r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)',text):
        raise ValueError('unsupported or nonfinite decimal geometry: '+text)
    result=Decimal(text)
    if not result.is_finite():raise ValueError('nonfinite geometry')
    return result


def _pair(value):
    if not isinstance(value,list) or len(value)!=2:raise ValueError('expected two geometry coordinates')
    return [_d(v) for v in value]


def _angle(value):
    value=_d(value)%360
    if value<0:value+=360
    if value not in (0,90,180,270):raise ValueError('only exact quarter-turn placement is supported')
    return int(value)


def _rotate(x,y,angle):
    return {0:(x,y),90:(-y,x),180:(-x,-y),270:(y,-x)}[angle]


def _children(form,key):
    return [v for v in form if isinstance(v,list) and v[:1]==[key]]


def _one(form,key):
    rows=_children(form,key)
    if len(rows)!=1:raise ValueError('missing or ambiguous DSN '+key)
    return rows[0]


def _parse(text):
    if not isinstance(text,str):raise ValueError('expected actual DSN text')
    text=re.sub(r'\(string_quote\s+"\)', '(string_quote quote)',text)
    end=0;depth=0
    for match in re.finditer(r'"(?:[^"\\]|\\.)*"|[()]|[^\s()"]+',text):
        if text[end:match.start()].strip():raise ValueError('invalid DSN token')
        end=match.end()
        if match[0]=='(':depth+=1
        elif match[0]==')':
            depth-=1
            if depth<0:raise ValueError('unbalanced DSN')
    if depth or text[end:].strip():raise ValueError('incomplete DSN')
    roots=route_features.sexpr(text)
    if len(roots)!=1 or roots[0][:1]!=['pcb']:raise ValueError('expected one complete DSN PCB')
    return roots[0]


def native_pth_pads(native_path):
    """Exact native source rows for the supported front, circular PTH subset.

    Unsupported PTH geometry raises; NPTH pads are deliberately outside this
    collector's scope. A broader selector must not be certified using it.
    """
    text=Path(native_path).read_text()
    native=route_features.sexpr(text)
    if len(native)!=1 or native[0][:1]!=['kicad_pcb']:raise ValueError('expected native PCB')
    layer_rows=child(native[0],'layers')
    if not isinstance(layer_rows,list):raise ValueError('missing native copper layers')
    copper=[]
    for row in layer_rows:
        if isinstance(row,list) and len(row)>=2 and re.fullmatch(r'(?:F|B|In\d+)\.Cu',str(row[1])):
            if row[1] in copper:raise ValueError('duplicate native copper layer')
            copper.append(row[1])
    if not copper:raise ValueError('missing native copper layers')
    result=[];seen=set()
    with localcontext() as ctx:
        ctx.prec=max(50,len(text));ctx.traps[Inexact]=True;ctx.traps[Rounded]=True
        for fp in footprints(native_path):
            for pad in _children(fp['form'],'pad'):
                if len(pad)<4:raise ValueError('malformed native pad')
                if pad[2] not in ('smd','thru_hole','np_thru_hole','connect'):
                    raise ValueError('unknown native pad type cannot establish hole coverage')
                if pad[2]!='thru_hole':continue
                ref=fp['props'].get('Reference');number=pad[1]
                if not ref or not number or (ref,number) in seen:raise ValueError('ambiguous native PTH identity')
                seen.add((ref,number))
                if child(fp['form'],'layer')!=['F.Cu']:raise ValueError('mirrored/backside PTH placement is unsupported')
                if pad[3]!='circle':raise ValueError('only circular native PTH copper is supported')
                drill=child(pad,'drill')
                if not isinstance(drill,list) or len(drill)!=1:raise ValueError('slots or offset PTH drills are unsupported')
                if any(_children(pad,key) for key in ('offset','primitives','options')):
                    raise ValueError('custom or offset native PTH geometry is unsupported')
                size=_pair(child(pad,'size'));diameter=_d(drill[0])
                if size[0]!=size[1] or diameter<=0 or size[0]<=diameter:raise ValueError('invalid circular native PTH dimensions')
                at=child(pad,'at')
                if not isinstance(at,list) or len(at) not in (2,3):raise ValueError('missing native PTH position')
                local=_pair(at[:2]);rotation=_angle(fp['pose'][2])
                if len(at)==3:_angle(at[2])
                dx,dy=_rotate(local[0],-local[1],rotation)
                position=[fp['pose'][0]+dx,fp['pose'][1]-dy]
                names=child(pad,'layers')
                if not isinstance(names,list):raise ValueError('missing native PTH layers')
                layers=copper if '*.Cu' in names else [v for v in names if v in copper]
                if not layers or any(v.endswith('.Cu') and v not in copper and v!='*.Cu' for v in names):
                    raise ValueError('unknown native PTH copper layers')
                net=child(pad,'net')
                if not isinstance(net,list) or len(net)!=1 or not isinstance(net[0],str) or not net[0]:
                    raise ValueError('missing exact native PTH net')
                result.append(dict(reference=ref,pad=number,net=net[0],side='front',
                    footprint_position_mm=[format(v,'f') for v in fp['pose'][:2]],
                    footprint_rotation_deg=str(rotation),position_mm=[format(v,'f') for v in position],
                    size_mm=[format(v,'f') for v in size],drill_mm=[format(diameter,'f')]*2,
                    drill_offset_mm=['0','0'],shape='circle',layers=list(layers)))
    return result


def _index(forms,kind):
    result={}
    for form in _children(forms,kind):
        if len(form)<2 or not isinstance(form[1],str) or form[1] in result:
            raise ValueError('ambiguous DSN '+kind+' identity')
        result[form[1]]=form
    return result


def _pins(image):
    pins={}
    for pin in _children(image,'pin'):
        values=pin[2:]
        rotation=0
        if values and isinstance(values[0],list):
            if len(values[0])!=2 or values[0][0]!='rotate':raise ValueError('unknown DSN pin transform')
            rotation=_angle(values[0][1]);values=values[1:]
        if len(pin)<5 or len(values)!=3 or values[0] in pins:raise ValueError('ambiguous DSN image pin')
        pins[values[0]]=(pin[1],values[1:],rotation)
    return pins


def inspect(dsn_text, *, pads, active_nets, layers, required_mm, clearance_floor_mm):
    """Return covered/blocked using actual circular copper containment, no tolerance.

    `pads` is native_pth_pads() output. Its identity/unchanged source proof and
    the DSN clearance floor come from the owning rule-coverage caller. The
    actual circle must enclose the drill expanded by required_mm, without
    relying on clearance to rescue insufficient annular copper.
    """
    result=dict(schema=SCHEMA,status='blocked',qualified=False,covered_pads=[],
        scope='other-net circular PTH holes versus new tracks; preserved native source and final fresh gate required')
    try:
        if not isinstance(pads,list) or not pads:raise ValueError('missing native PTH geometry')
        if (not isinstance(active_nets,list) or not active_nets or len(set(active_nets))!=len(active_nets)
                or any(not isinstance(v,str) or not v for v in active_nets)):
            raise ValueError('missing or ambiguous active nets')
        if not isinstance(layers,list) or len(layers)!=1 or layers[0] not in ('F.Cu','B.Cu'):
            raise ValueError('PTH containment requires one supported actual outer routing layer')
        required=_d(required_mm);floor=_d(clearance_floor_mm)
        if required<0 or floor<0:raise ValueError('negative native requirement or DSN clearance')
        root=_parse(dsn_text)
        unit=_one(root,'unit')
        if len(unit)!=2 or unit[1] not in ('mm','um','mil','inch'):raise ValueError('unsupported DSN units')
        resolution=_one(root,'resolution')
        if (len(resolution)!=3 or resolution[1]!=unit[1]
                or not isinstance(resolution[2],str) or not re.fullmatch(r'[1-9][0-9]*',resolution[2])
                or int(resolution[2])>2147483647):
            raise ValueError('ambiguous or unsupported DSN resolution/unit contract')
        scale=UNITS[unit[1]]
        library=_one(root,'library');images=_index(library,'image');stacks=_index(library,'padstack')
        cleaned={}
        for name in stacks:
            key=re.sub(r'\.\d+','',name).casefold()
            if key in cleaned:raise ValueError('ambiguous importer-normalized DSN padstack name')
            cleaned[key]=name
        structure=_one(root,'structure');actual_layers={}
        for layer in _children(structure,'layer'):
            if len(layer)<3 or layer[1] in actual_layers:raise ValueError('ambiguous actual DSN layer')
            kind=_one(layer,'type')
            if len(kind)!=2 or kind[1] not in ('signal','power'):raise ValueError('unknown actual DSN layer type')
            actual_layers[layer[1]]=kind[1]
        if actual_layers.get(layers[0])!='signal':raise ValueError('requested layer is not an actual DSN signal layer')
        if any(kind=='signal' and name not in layers for name,kind in actual_layers.items()):
            raise ValueError('actual DSN permits additional signal layers')
        places={}
        for component in _children(_one(root,'placement'),'component'):
            if len(component)<3 or component[1] not in images:raise ValueError('missing DSN component image')
            for place in _children(component,'place'):
                if len(place)<6 or place[1] in places:raise ValueError('ambiguous DSN component placement')
                places[place[1]]=(component[1],place)
        memberships={};net_names=set()
        for net in _children(_one(root,'network'),'net'):
            if len(net)<3 or not isinstance(net[1],str) or net[1] in net_names:raise ValueError('invalid or duplicate DSN net')
            net_names.add(net[1])
            for token in _one(net,'pins')[1:]:
                if not isinstance(token,str) or token in memberships:raise ValueError('ambiguous DSN pin membership')
                memberships[token]=net[1]
        if not set(active_nets).issubset({v[1] for v in _children(_one(root,'network'),'net')}):
            raise ValueError('active net missing from actual DSN')
        seen=set()
        with localcontext() as ctx:
            ctx.prec=max(50,len(dsn_text)+len(str(pads)));ctx.traps[Inexact]=True;ctx.traps[Rounded]=True
            for pad in pads:
                if not isinstance(pad,dict) or set(pad)!=PAD_FIELDS:raise ValueError('unknown native PTH geometry fields')
                key=(pad['reference'],pad['pad'])
                if any(not isinstance(v,str) or not v for v in (*key,pad['net'])) or key in seen:
                    raise ValueError('ambiguous native PTH reference/pad/net')
                seen.add(key)
                if pad['net'] in active_nets:raise ValueError('active same-net PTH requires a different proof')
                if pad['side']!='front' or pad['shape']!='circle':raise ValueError('mirrored or noncircular PTH is unsupported')
                size=_pair(pad['size_mm']);drill=_pair(pad['drill_mm']);offset=_pair(pad['drill_offset_mm'])
                if size[0]!=size[1] or drill[0]!=drill[1] or offset!=[0,0] or drill[0]<=0 or size[0]<=drill[0]:
                    raise ValueError('slot, offset or malformed circular native PTH')
                if not isinstance(pad['layers'],list) or layers[0] not in pad['layers']:
                    raise ValueError('native PTH lacks routing-layer copper')
                fp_position=_pair(pad['footprint_position_mm']);position=_pair(pad['position_mm'])
                fp_rotation=_angle(pad['footprint_rotation_deg'])
                if pad['reference'] not in places:raise ValueError('native PTH missing from DSN placement')
                image_name,place=places[pad['reference']]
                if (place[4]!='front' or _angle(place[5])!=fp_rotation
                        or [_d(place[2])*scale,-_d(place[3])*scale]!=fp_position):
                    raise ValueError('DSN component pose/mirror differs from native PTH footprint')
                image=images[image_name]
                if _children(image,'side'):raise ValueError('explicit image mirroring is unsupported')
                pins=_pins(image)
                # The importer may merge package ::N aliases. Only exactly
                # identical pin geometry can support this source proof.
                base=re.sub(r'::[0-9]+$','',image_name).casefold()
                for alias,other in images.items():
                    if re.sub(r'::[0-9]+$','',alias).casefold()==base and _pins(other)!=pins:
                        raise ValueError('ambiguous importer-normalized DSN package pins')
                if pad['pad'] not in pins:raise ValueError('native PTH missing from DSN image pins')
                stack_name,pin_xy,_=pins[pad['pad']]
                if memberships.get(pad['reference']+'-'+pad['pad'])!=pad['net']:
                    raise ValueError('DSN PTH electrical membership differs from native')
                if stack_name not in stacks:raise ValueError('missing DSN PTH padstack')
                shapes=[]
                for shape in _children(stacks[stack_name],'shape'):
                    if len(shape)!=2 or not isinstance(shape[1],list) or len(shape[1])<3:
                        raise ValueError('malformed DSN padstack shape')
                    form=shape[1]
                    if form[1] in (layers[0],'signal','pcb'):shapes.append(form)
                if len(shapes)!=1 or shapes[0][0]!='circle' or len(shapes[0]) not in (3,5):
                    raise ValueError('missing or ambiguous circular PTH obstacle on routing layer')
                circle=shapes[0]
                if len(circle)==5 and [_d(v) for v in circle[3:]]!=[0,0]:
                    raise ValueError('offset DSN PTH circle is unsupported')
                diameter=_d(circle[2])*scale
                if diameter<=0:raise ValueError('nonpositive DSN circle')
                dx,dy=_rotate(_d(pin_xy[0])*scale,_d(pin_xy[1])*scale,fp_rotation)
                dsn_center=[_d(place[2])*scale+dx,-(_d(place[3])*scale+dy)]
                displacement2=sum((a-b)**2 for a,b in zip(dsn_center,position))
                remaining=diameter/2-drill[0]/2-required
                if remaining<0 or displacement2>remaining**2:
                    raise ValueError('actual exported PTH circle does not contain the expanded native drill: '+pad['reference']+'.'+pad['pad'])
                result['covered_pads'].append(dict(reference=pad['reference'],pad=pad['pad'],net=pad['net'],
                    layer=layers[0],dsn_image=image_name,dsn_padstack=stack_name,
                    dsn_center_mm=[format(v,'f') for v in dsn_center],native_center_mm=[format(v,'f') for v in position],
                    dsn_radius_mm=format(diameter/2,'f'),native_drill_radius_mm=format(drill[0]/2,'f'),
                    required_mm=format(required,'f'),center_displacement_squared_mm2=format(displacement2,'f'),
                    containment_slack_radius_mm=format(remaining,'f')))
        result.update(status='covered',cause='every other-net circular PTH expanded drill is contained in its actual DSN copper obstacle',
            required_mm=format(required,'f'),clearance_floor_mm=format(floor,'f'))
    except (ValueError,TypeError,KeyError,ArithmeticError) as error:
        result.update(status='blocked',cause=str(error) or type(error).__name__)
    return result
