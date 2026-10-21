"""Prove a narrow PTH hole rule from actual exported pin obstacles.

This is a model-containment check, never a native electrical acceptance. It
covers new other-net tracks only. The caller must independently preserve all
source footprints/holes, establish actual routing layers and clearance floor,
bind these inputs, and run the final fresh configured gate.
"""
from decimal import Decimal, Inexact, Rounded, localcontext
import hashlib
import json
from pathlib import Path
import re

from pcb_search.block_bindings import child, footprints
import route_features

SCHEMA = 'iot-lab.route-hole-coverage.v2'
PAD_FIELDS = {'reference','pad','net','side','footprint_position_mm','footprint_rotation_deg',
              'position_mm','size_mm','drill_mm','drill_offset_mm','shape','layers'}
PHYSICAL_FIELDS = {'identity','rotation_deg','export_pin'}
UNITS = {'mm':Decimal(1),'um':Decimal('0.001'),'mil':Decimal('0.0254'),'inch':Decimal('25.4'),'in':Decimal('25.4')}
DRILLED_SCHEMA = 'iot-lab.route-drilled-coverage.v1'
EXPORTER_SOURCE = ('https://gitlab.com/kicad/code/kicad/-/blob/10.0.6/'
                   'pcbnew/specctra_import_export/specctra_export.cpp')
TRACK_HOLE_APPLICABILITY_SOURCE = ('https://gitlab.com/kicad/code/kicad/-/blob/10.0.6/'
    'pcbnew/drc/drc_test_provider_copper_clearance.cpp#L582-587')
BACKEND_SOURCE = 'https://github.com/parisxmas/fastroute/tree/e5d52c4544795422b8b28077acc0605fdf11265a'
# Reviewed checkpoint ranking changes selection keys, logging and test fixtures.
# Relative to the reviewed T-junction patch bbf6d0d0, all 126 fr-io/fr-geom
# source files, drill obstacles and coordinate transforms are unchanged.
# A new binary must bind its own source/build and native artifact evidence.
# A different patch requires a new source review, never auto-certifies.
GEOMETRY_PATCH_SHA256 = 'abc1c6fc3b49f446ce0f28fb2c861abb02255822a5fb58fced5eaa2ea53eb1a8'


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
    """Exact native source rows for front circular-drill circle/rectangle PTH.

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
        for fp_index,fp in enumerate(footprints(native_path)):
            occurrences={};electrical_nets={}
            for pad_index,pad in enumerate(_children(fp['form'],'pad')):
                if len(pad)<4:raise ValueError('malformed native pad')
                if pad[2] not in ('smd','thru_hole','np_thru_hole','connect'):
                    raise ValueError('unknown native pad type cannot establish hole coverage')
                # Actual KiCad10 export names repeated numbered physical pads
                # N,N@1,... in native pad order, including intervening SMD EPs.
                # Position, copper and network membership are checked below;
                # the generated suffix alone never establishes identity.
                number=pad[1];ordinal=occurrences.get(number,0)
                occurrences[number]=ordinal+1
                export_pin=number+('@'+str(ordinal) if ordinal else '')
                if number and pad[2]!='np_thru_hole':
                    net=child(pad,'net')
                    if number in electrical_nets and electrical_nets[number]!=net:
                        raise ValueError('repeated native pad number has conflicting electrical membership')
                    electrical_nets[number]=net
                if pad[2]!='thru_hole':continue
                ref=fp['props'].get('Reference');number=pad[1]
                uuid=child(pad,'uuid')
                if uuid is not None and (len(uuid)!=1 or not isinstance(uuid[0],str) or not uuid[0]):
                    raise ValueError('ambiguous native physical pad UUID')
                identity=uuid[0] if uuid else 'index:'+str(fp_index)+':'+str(pad_index)
                if not ref or not number or identity in seen:raise ValueError('ambiguous native PTH identity')
                seen.add(identity)
                if child(fp['form'],'layer')!=['F.Cu']:raise ValueError('mirrored/backside PTH placement is unsupported')
                if pad[3] not in ('circle','rect'):raise ValueError('only circle/rectangle native PTH copper is supported')
                drill=child(pad,'drill')
                if not isinstance(drill,list) or len(drill)!=1:raise ValueError('slots or offset PTH drills are unsupported')
                if any(_children(pad,key) for key in ('offset','primitives','options','rect_delta',
                        'chamfer_ratio','chamfer','roundrect_rratio')):
                    raise ValueError('custom or offset native PTH geometry is unsupported')
                size=_pair(child(pad,'size'));diameter=_d(drill[0])
                if (pad[3]=='circle' and size[0]!=size[1]) or diameter<=0 or min(size)<=diameter:
                    raise ValueError('invalid native PTH dimensions')
                at=child(pad,'at')
                if not isinstance(at,list) or len(at) not in (2,3):raise ValueError('missing native PTH position')
                local=_pair(at[:2]);rotation=_angle(fp['pose'][2])
                pad_rotation=_angle(at[2] if len(at)==3 else 0)
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
                result[-1].update(identity=identity,rotation_deg=str(pad_rotation),shape=pad[3],export_pin=export_pin)
    return result


def native_drilled_geometry(native_path):
    """Inventory every physical drilled pad and via, including unsupported rows.

    No host paths are emitted. UUID (or explicit source index), exact raw-form
    hash and geometry retain physical multiplicity for source/base comparison.
    Supported pads are front, centered, quarter-turn circle/rect/oval copper
    with circular/oval drills. NPTH support is intentionally circular only.
    Unsupported geometry never disappears from the inventory.
    """
    text=Path(native_path).read_text();roots=route_features.sexpr(text)
    if len(roots)!=1 or roots[0][:1]!=['kicad_pcb']:raise ValueError('expected native PCB')
    root=roots[0];copper=[]
    for row in child(root,'layers',[]):
        if isinstance(row,list) and len(row)>=2 and re.fullmatch(r'(?:F|B|In\d+)\.Cu',str(row[1])):
            if row[1] in copper:raise ValueError('duplicate native copper layer')
            copper.append(row[1])
    if not copper or copper[0]!='F.Cu' or copper[-1]!='B.Cu':raise ValueError('missing native copper stack')
    rows=[];identities=set();references=set()
    def base(form,kind,index):
        uid=child(form,'uuid');identity=uid[0] if uid and len(uid)==1 and isinstance(uid[0],str) and uid[0] else 'index:'+index
        if identity in identities:raise ValueError('duplicate physical drilled identity')
        identities.add(identity)
        net=child(form,'net',[])
        row=dict(kind=kind,identity=identity,net=net[-1] if net and isinstance(net[-1],str) else '',
            supported=False,cause=None,native_form_sha256=hashlib.sha256(
                json.dumps(form,ensure_ascii=False,separators=(',',':')).encode()).hexdigest())
        rows.append(row)
        if uid is not None and (len(uid)!=1 or not isinstance(uid[0],str) or not uid[0]):
            row['cause']='ambiguous native drilled UUID'
        return row
    with localcontext() as ctx:
        ctx.prec=max(50,len(text)*2);ctx.traps[Inexact]=True;ctx.traps[Rounded]=True
        for fi,fp in enumerate(footprints(native_path)):
            ref=fp['props'].get('Reference')
            if not ref or ref.casefold() in references:raise ValueError('ambiguous native drilled reference')
            references.add(ref.casefold());occurrences={};net_numbers={}
            for pi,pad in enumerate(_children(fp['form'],'pad')):
                if len(pad)<4:raise ValueError('malformed native pad')
                kind={'thru_hole':'pth','np_thru_hole':'npth'}.get(pad[2])
                drill=child(pad,'drill')
                if pad[1] and pad[2]!='np_thru_hole':
                    net=child(pad,'net',[])
                    if pad[1] in net_numbers and net_numbers[pad[1]]!=net:
                        raise ValueError('conflicting repeated native electrical membership')
                    net_numbers[pad[1]]=net
                if kind is None and drill is None and pad[2] in ('smd','connect'):
                    # Round copper-less holes do not consume exported aliases.
                    number=pad[1];occurrences[number]=occurrences.get(number,0)+1
                    continue
                row=base(pad,kind or 'unknown',str(fi)+':'+str(pi));row.update(reference=ref,pad=pad[1])
                try:
                    if row['cause']:raise ValueError(row['cause'])
                    if kind is None:raise ValueError('unknown drilled pad type')
                    if child(fp['form'],'layer')!=['F.Cu']:raise ValueError('mirrored/backside drilled footprint is unsupported')
                    if pad[3] not in ('circle','rect','oval'):raise ValueError('unsupported drilled pad copper shape')
                    if any(_children(pad,k) for k in ('offset','primitives','options','rect_delta','chamfer_ratio','chamfer','roundrect_rratio','padstack')):
                        raise ValueError('custom or offset drilled pad geometry is unsupported')
                    if not isinstance(drill,list):raise ValueError('missing physical drill')
                    if len(drill)==1:drill_size=[_d(drill[0])]*2;drill_shape='circle'
                    elif len(drill)==3 and drill[0]=='oval':drill_size=_pair(drill[1:]);drill_shape='oval'
                    else:raise ValueError('offset or unknown drill geometry is unsupported')
                    size=_pair(child(pad,'size'));at=child(pad,'at')
                    if min(size)<=0 or min(drill_size)<=0 or (pad[3]=='circle' and size[0]!=size[1]):
                        raise ValueError('invalid drilled pad dimensions')
                    if not isinstance(at,list) or len(at) not in (2,3):raise ValueError('missing drilled pad position')
                    rotation=_angle(fp['pose'][2]);pad_rotation=_angle(at[2] if len(at)==3 else 0)
                    local=_pair(at[:2]);dx,dy=_rotate(local[0],-local[1],rotation)
                    position=[fp['pose'][0]+dx,fp['pose'][1]-dy]
                    names=child(pad,'layers')
                    if not isinstance(names,list) or len(set(names))!=len(names):raise ValueError('ambiguous drilled pad layers')
                    layers=copper if '*.Cu' in names else [v for v in names if v in copper]
                    if any(v.endswith('.Cu') and v not in copper and v!='*.Cu' for v in names):raise ValueError('unknown drilled copper layer')
                    net=child(pad,'net',[])
                    if kind=='pth':
                        if not pad[1] or len(net)!=1 or not isinstance(net[0],str) or not net[0] or net[0].isdecimal():
                            raise ValueError('missing exact drilled electrical membership')
                        if not layers:raise ValueError('PTH has no exported copper')
                        if pad[3]=='circle' and drill_size[0]>=size[0]:raise ValueError('copper-less plated drill requires keepout-specific binding')
                        ordinal=occurrences.get(pad[1],0);export_pin=pad[1]+('@'+str(ordinal) if ordinal else '')
                        occurrences[pad[1]]=ordinal+1
                    else:
                        if net or pad[3]!='circle' or drill_shape!='circle' or size[0]>drill_size[0]:
                            raise ValueError('only copper-less circular NPTH exporter keepouts are supported')
                        export_pin=None
                    row.update(side='front',footprint_position_mm=[format(v,'f') for v in fp['pose'][:2]],
                        footprint_rotation_deg=str(rotation),position_mm=[format(v,'f') for v in position],
                        size_mm=[format(v,'f') for v in size],drill_mm=[format(v,'f') for v in drill_size],
                        drill_shape=drill_shape,drill_offset_mm=['0','0'],shape=pad[3],layers=list(layers),
                        hole_layers=list(copper),rotation_deg=str(pad_rotation),export_pin=export_pin,supported=True)
                except (ValueError,TypeError,KeyError,ArithmeticError) as error:
                    row.update(supported=False,cause=str(error) or type(error).__name__)
        for vi,via in enumerate(_children(root,'via')):
            row=base(via,'via','via:'+str(vi))
            try:
                if row['cause']:raise ValueError(row['cause'])
                if any(isinstance(v,str) and v not in ('via','locked') for v in via):raise ValueError('blind/micro via is unsupported')
                if any(_children(via,k) for k in ('padstack','remove_unused_layers','zone_layer_connections')):
                    raise ValueError('custom via padstack is unsupported')
                size=child(via,'size');drill=child(via,'drill');names=child(via,'layers');net=child(via,'net')
                if (not size or len(size)!=1 or not drill or len(drill)!=1 or names!=[copper[0],copper[-1]]
                        or not net or len(net)!=1 or not isinstance(net[0],str) or not net[0] or net[0].isdecimal()):
                    raise ValueError('unknown via dimensions/layers/electrical membership')
                diameter=_d(size[0]);hole=_d(drill[0]);position=_pair(child(via,'at'))
                if hole<=0 or diameter<=hole:raise ValueError('invalid via annulus')
                row.update(position_mm=[format(v,'f') for v in position],size_mm=[format(diameter,'f')]*2,
                    drill_mm=[format(hole,'f')]*2,drill_shape='circle',drill_offset_mm=['0','0'],shape='circle',
                    layers=list(copper),hole_layers=list(copper),rotation_deg='0',supported=True)
            except (ValueError,TypeError,KeyError,ArithmeticError) as error:
                row.update(supported=False,cause=str(error) or type(error).__name__)
    return rows


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
    """Return covered/blocked using exact copper-plus-clearance containment.

    `pads` is native_pth_pads() output. Its identity/unchanged source proof and
    the DSN clearance floor come from the owning rule-coverage caller. The
    The caller establishes a conservative actual wire-to-pin clearance floor
    for every applicable DSN declaration (never a pad-only clearance). Thus an
    expanded native circular drill must fit inside the actual pin obstacle
    Minkowski-summed with that floor. Rectangle proofs use an inscribed disk
    about the drill center; no rounded-corner approximation is used. V2 adds
    physical identity and explicit clearance credit; the legacy circle-only
    containment_slack_radius_mm remains copper-only for prior report readers.
    """
    result=dict(schema=SCHEMA,status='blocked',qualified=False,covered_pads=[],
        scope='other-net circular PTH drills in circle/rectangle copper versus new tracks; preserved native source and final fresh gate required')
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
        seen=set();physical_seen=set();export_seen=set()
        counts={}
        for pad in pads:
            if isinstance(pad,dict):
                key=(pad.get('reference'),pad.get('pad'))
                counts[key]=counts.get(key,0)+1
        with localcontext() as ctx:
            ctx.prec=max(50,len(dsn_text)+len(str(pads)));ctx.traps[Inexact]=True;ctx.traps[Rounded]=True
            for pad in pads:
                if not isinstance(pad,dict) or set(pad) not in (PAD_FIELDS,PAD_FIELDS|PHYSICAL_FIELDS):
                    raise ValueError('unknown native PTH geometry fields')
                key=(pad['reference'],pad['pad'])
                if any(not isinstance(v,str) or not v for v in (*key,pad['net'])):
                    raise ValueError('ambiguous native PTH reference/pad/net')
                physical=PHYSICAL_FIELDS<=set(pad)
                identity=pad.get('identity')
                if physical:
                    if not isinstance(identity,str) or not identity or identity in physical_seen:
                        raise ValueError('missing or duplicate physical PTH identity')
                    physical_seen.add(identity)
                    export_pin=pad['export_pin']
                    if (not isinstance(export_pin,str) or not re.fullmatch(re.escape(pad['pad'])+r'(?:@[1-9][0-9]*)?',export_pin)
                            or (pad['reference'],export_pin) in export_seen):
                        raise ValueError('ambiguous physical exported PTH pin')
                else:
                    if key in seen or counts[key]!=1:raise ValueError('repeated PTH requires physical source identity')
                    export_pin=pad['pad']
                export_seen.add((pad['reference'],export_pin))
                seen.add(key)
                if pad['net'] in active_nets:raise ValueError('active same-net PTH requires a different proof')
                if pad['side']!='front' or pad['shape'] not in ('circle','rect'):
                    raise ValueError('mirrored or unsupported native PTH copper')
                if pad['shape']=='rect' and not physical:raise ValueError('rectangle requires explicit native pad rotation')
                size=_pair(pad['size_mm']);drill=_pair(pad['drill_mm']);offset=_pair(pad['drill_offset_mm'])
                if ((pad['shape']=='circle' and size[0]!=size[1]) or drill[0]!=drill[1]
                        or offset!=[0,0] or drill[0]<=0 or min(size)<=drill[0]):
                    raise ValueError('slot, offset or malformed native PTH')
                if (not isinstance(pad['layers'],list) or layers[0] not in pad['layers']
                        or len(set(pad['layers']))!=len(pad['layers'])
                        or any(v not in actual_layers for v in pad['layers'])):
                    raise ValueError('native PTH lacks routing-layer copper')
                fp_position=_pair(pad['footprint_position_mm']);position=_pair(pad['position_mm'])
                fp_rotation=_angle(pad['footprint_rotation_deg'])
                native_rotation=_angle(pad['rotation_deg']) if physical else 0
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
                if export_pin not in pins:raise ValueError('native physical PTH missing from DSN image pins')
                stack_name,pin_xy,pin_rotation=pins[export_pin]
                if memberships.get(pad['reference']+'-'+export_pin)!=pad['net']:
                    raise ValueError('DSN PTH electrical membership differs from native')
                if stack_name not in stacks:raise ValueError('missing DSN PTH padstack')
                shapes=[]
                for shape in _children(stacks[stack_name],'shape'):
                    if len(shape)!=2 or not isinstance(shape[1],list) or len(shape[1])<3:
                        raise ValueError('malformed DSN padstack shape')
                    form=shape[1]
                    if form[1] in (layers[0],'signal','pcb'):shapes.append(form)
                if len(shapes)!=1 or shapes[0][0]!=pad['shape']:
                    raise ValueError('missing or ambiguous source-matched PTH obstacle on routing layer')
                shape=shapes[0]
                dx,dy=_rotate(_d(pin_xy[0])*scale,_d(pin_xy[1])*scale,fp_rotation)
                dsn_center=[_d(place[2])*scale+dx,-(_d(place[3])*scale+dy)]
                displacement2=sum((a-b)**2 for a,b in zip(dsn_center,position))
                radius=drill[0]/2+required
                record={}
                if shape[0]=='circle':
                    if len(shape) not in (3,5):raise ValueError('malformed DSN PTH circle')
                    if len(shape)==5 and [_d(v) for v in shape[3:]]!=[0,0]:
                        raise ValueError('offset DSN PTH circle is unsupported')
                    diameter=_d(shape[2])*scale
                    if diameter<=0:raise ValueError('nonpositive DSN circle')
                    remaining=diameter/2-radius
                    effective=remaining+floor
                    if counts[key]>1 and (diameter!=size[0] or dsn_center!=position):
                        raise ValueError('repeated exported PTH alias does not match exact native copper geometry')
                    covered=effective>=0 and displacement2<=effective**2
                    record.update(dsn_radius_mm=format(diameter/2,'f'))
                else:
                    if len(shape)!=6:raise ValueError('malformed DSN PTH rectangle')
                    x0,y0,x1,y1=[_d(v)*scale for v in shape[2:]]
                    if x0>=x1 or y0>=y1 or x0!=-x1 or y0!=-y1:
                        raise ValueError('offset or invalid DSN PTH rectangle')
                    rotation=(fp_rotation+pin_rotation)%360
                    # Require the actual rectangle to be exactly the source
                    # copper, accounting for both pin and footprint rotation.
                    w,h=x1-x0,y1-y0
                    if ((rotation-native_rotation)%180==90):w,h=h,w
                    if [w,h]!=size or dsn_center!=position:
                        raise ValueError('DSN PTH rectangle differs from native copper geometry')
                    lx,ly=_rotate(position[0]-dsn_center[0],-(position[1]-dsn_center[1]),(-rotation)%360)
                    margin=min(lx-x0,x1-lx,ly-y0,y1-ly)
                    remaining=margin-radius
                    effective=remaining+floor
                    covered=margin>=0 and effective>=0
                    record.update(dsn_rectangle_mm=[format(v,'f') for v in (x0,y0,x1,y1)],
                        dsn_rotation_deg=rotation,inscribed_radius_mm=format(margin,'f'))
                if not covered:
                    raise ValueError('actual exported PTH copper plus verified clearance does not contain the expanded native drill: '+pad['reference']+'.'+pad['pad'])
                result['covered_pads'].append(dict(reference=pad['reference'],pad=pad['pad'],net=pad['net'],
                    identity=identity,dsn_pin=export_pin,dsn_shape=shape[0],
                    layer=layers[0],dsn_image=image_name,dsn_padstack=stack_name,
                    dsn_center_mm=[format(v,'f') for v in dsn_center],native_center_mm=[format(v,'f') for v in position],
                    native_drill_radius_mm=format(drill[0]/2,'f'),
                    required_mm=format(required,'f'),center_displacement_squared_mm2=format(displacement2,'f'),
                    containment_slack_radius_mm=format(remaining,'f'),credited_clearance_mm=format(floor,'f'),
                    effective_containment_slack_mm=format(effective,'f'),**record))
        result.update(status='covered',cause='every physical other-net PTH expanded drill is contained in its actual DSN copper obstacle plus verified wire-to-pin clearance',
            required_mm=format(required,'f'),clearance_floor_mm=format(floor,'f'))
    except (ValueError,TypeError,KeyError,ArithmeticError) as error:
        result.update(status='blocked',cause=str(error) or type(error).__name__)
    return result


def _capsule(center, size, rotation):
    """Centered native oval/circular drill, in the board's Y-down frame."""
    radius=min(size)/2;half=(max(size)-min(size))/2
    points=((-half,Decimal(0)),(half,Decimal(0))) if size[0]>=size[1] else ((Decimal(0),-half),(Decimal(0),half))
    ends=[]
    for x,y in points:
        dx,dy=_rotate(x,-y,rotation);ends.append((center[0]+dx,center[1]-dy))
    return dict(kind='capsule',ends=tuple(sorted(ends)),radius=radius)


def _obstacle(shape,scale,center,rotation):
    """Exact DSN circle, centered rectangle or one straight round path."""
    def world(x,y):
        dx,dy=_rotate(x*scale,y*scale,rotation)
        return center[0]+dx,center[1]-dy
    if shape[0]=='circle':
        if len(shape) not in (3,5):raise ValueError('malformed drilled DSN circle')
        offset=[Decimal(0),Decimal(0)] if len(shape)==3 else [_d(v) for v in shape[3:]]
        radius=_d(shape[2])*scale/2
        if radius<=0 or offset!=[0,0]:raise ValueError('offset/nonpositive drilled DSN circle')
        p=world(*offset);return dict(kind='capsule',ends=(p,p),radius=radius)
    if shape[0]=='path':
        if len(shape)!=7:raise ValueError('only one straight oval DSN path is supported')
        width=_d(shape[2])*scale;a=[_d(v) for v in shape[3:5]];b=[_d(v) for v in shape[5:7]]
        if width<=0 or a!=[-v for v in b] or (a[0]!=b[0] and a[1]!=b[1]):
            raise ValueError('offset/non-axis DSN capsule is unsupported')
        return dict(kind='capsule',ends=tuple(sorted((world(*a),world(*b)))),radius=width/2)
    if shape[0]=='rect':
        if len(shape)!=6:raise ValueError('malformed drilled DSN rectangle')
        x0,y0,x1,y1=[_d(v) for v in shape[2:]]
        if x0>=x1 or y0>=y1 or x0!=-x1 or y0!=-y1:raise ValueError('offset drilled DSN rectangle')
        points=[world(x,y) for x in (x0,x1) for y in (y0,y1)]
        return dict(kind='rect',bounds=(min(x for x,y in points),min(y for x,y in points),
                                       max(x for x,y in points),max(y for x,y in points)))
    raise ValueError('unsupported actual DSN drilled obstacle')


def _contains_drill(obstacle,drill,required,floor):
    """Analytic sufficient containment, with no polygon sampling or rounding.

    A capsule is the convex hull of its two endpoint disks. Squared distance
    to an axis-aligned segment bounds each disk inside an expanded capsule.
    For a rectangle, each endpoint disk fits its exact inscribed disk plus
    the verified clearance. The latter is conservative near rounded corners.
    """
    radius=drill['radius']+required
    if obstacle['kind']=='capsule':
        slack=obstacle['radius']+floor-radius
        if slack<0:return False
        a,b=obstacle['ends']
        if a[0]!=b[0] and a[1]!=b[1]:raise ValueError('non-axis obstacle capsule')
        for x,y in drill['ends']:
            dx=max(min(a[0],b[0])-x,Decimal(0),x-max(a[0],b[0]))
            dy=max(min(a[1],b[1])-y,Decimal(0),y-max(a[1],b[1]))
            if dx*dx+dy*dy>slack*slack:return False
        return True
    x0,y0,x1,y1=obstacle['bounds']
    for x,y in drill['ends']:
        margin=min(x-x0,x1-x,y-y0,y1-y)
        if margin<0 or margin+floor<radius:return False
    return True


class _DrilledModel:
    def __init__(self,text,layers):
        self.root=_parse(text);unit=_one(self.root,'unit');resolution=_one(self.root,'resolution')
        if (len(unit)!=2 or unit[1] not in ('mm','um','mil','inch') or len(resolution)!=3
                or resolution[1]!=unit[1] or not re.fullmatch(r'[1-9][0-9]*',str(resolution[2]))
                or int(resolution[2])>2147483647):raise ValueError('ambiguous DSN drilled unit/resolution')
        self.scale=UNITS[unit[1]];self.layers={}
        for form in _children(_one(self.root,'structure'),'layer'):
            kind=_one(form,'type')
            if len(form)<3 or form[1] in self.layers or len(kind)!=2 or kind[1] not in ('signal','power'):
                raise ValueError('ambiguous actual drilled DSN layer')
            self.layers[form[1]]=kind[1]
        if (self.layers.get(layers[0])!='signal' or any(v=='signal' and k not in layers for k,v in self.layers.items())):
            raise ValueError('actual DSN routing layers differ from drilled proof')
        library=_one(self.root,'library');self.images=_index(library,'image');self.stacks=_index(library,'padstack')
        for collection,normalize in ((self.images,lambda n:n.casefold()),
                (self.stacks,lambda n:re.sub(r'\.\d+','',n).casefold())):
            keys=[normalize(k) for k in collection]
            if len(set(keys))!=len(keys):raise ValueError('ambiguous importer-normalized drilled names')
        self.places={}
        for component in _children(_one(self.root,'placement'),'component'):
            if len(component)<3 or component[1] not in self.images:raise ValueError('missing drilled DSN image')
            for place in _children(component,'place'):
                if len(place)<6 or not isinstance(place[1],str) or place[1].casefold() in self.places:
                    raise ValueError('ambiguous drilled component placement')
                self.places[place[1].casefold()]=(component[1],place)
        self.members={};self.nets=set();net_keys=set();member_keys=set()
        for net in _children(_one(self.root,'network'),'net'):
            if len(net)<3 or not isinstance(net[1],str) or net[1].casefold() in net_keys:raise ValueError('ambiguous drilled DSN net')
            self.nets.add(net[1]);net_keys.add(net[1].casefold())
            for token in _one(net,'pins')[1:]:
                if not isinstance(token,str) or token.casefold() in member_keys:raise ValueError('ambiguous drilled pin membership')
                self.members[token]=net[1];member_keys.add(token.casefold())
        self.vias=[]
        wiring=_children(self.root,'wiring')
        if len(wiring)>1:raise ValueError('ambiguous DSN wiring')
        for via in _children(wiring[0] if wiring else [],'via'):
            if len(via)!=6 or not isinstance(via[1],str) or len(_one(via,'net'))!=2 or _one(via,'type')!=['type','fix']:
                raise ValueError('retained DSN via is not a fixed, single-center obstacle')
            self.vias.append((via[1],[_d(via[2])*self.scale,-_d(via[3])*self.scale],_one(via,'net')[1],(via[2],via[3])))

    def image(self,hole):
        name=hole['reference'];image_name,place=self.places.get(name.casefold(),(None,None))
        if (place is None or place[1]!=name or place[4]!='front'
                or _angle(place[5])!=_angle(hole['footprint_rotation_deg'])
                or [_d(place[2])*self.scale,-_d(place[3])*self.scale]!=_pair(hole['footprint_position_mm'])):
            raise ValueError('DSN drilled component pose/mirror differs from native')
        image=self.images[image_name]
        if _children(image,'side'):raise ValueError('mirrored drilled image is unsupported')
        signature=lambda f:(_pins(f),_children(f,'keepout'),_children(f,'wire_keepout'))
        base=re.sub(r'::[0-9]+$','',image_name).casefold()
        for alias,other in self.images.items():
            if re.sub(r'::[0-9]+$','',alias).casefold()==base and signature(other)!=signature(image):
                raise ValueError('ambiguous importer-normalized drilled package')
        return image_name,image,place

    def shape(self,stack,layer):
        if stack not in self.stacks:raise ValueError('missing actual drilled padstack')
        shapes=[]
        for row in _children(self.stacks[stack],'shape'):
            if len(row)!=2 or not isinstance(row[1],list) or len(row[1])<3:raise ValueError('malformed drilled padstack')
            if row[1][1] in (layer,'signal','pcb'):shapes.append(row[1])
        if len(shapes)!=1:raise ValueError('missing or ambiguous drilled obstacle on routing layer')
        return shapes[0]


def _grid_mm(model,value):
    """Exact upstream integer-grid subset; never round a source coordinate."""
    scaled=value/model.scale*10
    # Upstream fr-geom/limits.rs CRIT_INT and fr-io/structure.rs 397-413:
    # the board scale remains resolution10 only below this sourced limit.
    if scaled!=scaled.to_integral_value() or abs(scaled)*5>=33554432:
        raise ValueError('drilled model coordinate/radius/clearance is not exactly representable on the verified backend grid')


def _verified_grid(model,command,policy,inputs):
    """Reuse actual quality-backend provenance; opaque legacy policy blocks."""
    import backend_quality
    if (not isinstance(command,list) or not command or not all(isinstance(v,str) for v in command)
            or '--quality-first' not in command or not Path(command[0]).is_absolute()
            or not isinstance(policy,dict) or policy.get('mode')!='quality-first'):
        raise ValueError('drilled model needs an attributable quality-first backend policy; legacy/unknown geometry is unsupported')
    if policy.get('patch_sha256')!=GEOMETRY_PATCH_SHA256:
        raise ValueError('backend patch geometry transform has not been reviewed')
    paths=[Path(command[0]),Path(backend_quality.__file__).resolve(),backend_quality.PATCH.resolve()]
    manifest=Path(policy.get('manifest',''))
    if not manifest.is_absolute():raise ValueError('actual backend manifest path is required')
    paths.append(manifest)
    def capture():
        for path in paths:
            inputs[str(path)]=hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
    capture()
    data=json.loads(manifest.read_text())
    if not isinstance(data,dict) or not isinstance(data.get('native_validation'),dict):
        raise ValueError('invalid backend native validation manifest')
    for item in data.get('native_validation',{}).get('evidence',[]):
        if not isinstance(item,dict) or not isinstance(item.get('path'),str):raise ValueError('invalid backend native evidence')
        paths.append(Path(item['path']))
    capture();before=dict(inputs)
    if backend_quality.bind(command[0],manifest)!=policy:raise ValueError('actual backend policy differs from its binary/manifest/evidence bindings')
    capture()
    if before!=inputs:raise ValueError('backend policy inputs changed during drilled admission')
    root=model.root;unit=_one(root,'unit');resolution=_one(root,'resolution')
    if unit!=['unit','um'] or resolution!=['resolution','um','10']:
        raise ValueError('only the source-verified um/resolution10 backend grid is supported')
    boundary=_one(_one(root,'structure'),'boundary')
    if (len(boundary)!=2 or not isinstance(boundary[1],list) or boundary[1][:3]!=['path','pcb','0']
            or len(boundary[1])<11 or (len(boundary[1])-3)%2):
        raise ValueError('backend coordinate scale requires one exact closed zero-width PCB boundary')
    values=[_d(v) for v in boundary[1][3:]]
    if values[:2]!=values[-2:] or max(map(abs,values))*50>=33554432:
        raise ValueError('backend board boundary does not establish unchanged resolution10 coordinate scale')
    return dict(source=BACKEND_SOURCE,coordinate_scale=10,unit='um',policy=policy['mode'],
        binary_sha256=policy['binary_sha256'],manifest_sha256=policy['manifest_sha256'])


def inspect_drilled(dsn_text, *, holes, active_nets, layers, required_mm, clearance_floor_mm,
                    applicability='reject_same_net',backend_command=None,backend_policy=None):
    """Prove a project hole-to-new-track minimum for the complete inventory.

    Actual KiCad10.0.6 representations are source-documented at EXPORTER_SOURCE:
    makePADSTACK exports oval copper as a two-point path with round aperture;
    makeIMAGE exports circular copper-less holes as image keepout circles;
    instantiated vias use wiring/via plus circular library padstacks. NPTH
    keepouts receive NO wire-to-pin clearance credit. Same-net plated drills
    are blocked by default: electrical copper is not a same-net wire keepout.
    The explicit kicad10_project_track scope implements the native track
    visitor's same-net connected-item exclusion before hole tests. It still
    binds every physical hole/model instance, and records each exclusion.
    The custom_pth_track scope requires the caller to prove that every
    applicable custom-rule pair is a new track and a retained PTH pad. It
    conservatively applies the custom minimum to ALL PTH pads. NPTH and via
    instances remain fully bound, with zero custom distance and no clearance
    credit; the independent project all-hole minimum remains required.
    Actual backend oval paths remain unsupported: the integer importer uses
    rounded octagons which need not contain the ideal source capsule. Positive
    circle/rectangle proofs require the independently rebound quality backend
    policy and exactly representable centers/radii/corners/clearance. Legacy
    source-opaque backends never receive an assumed transform certificate.
    The supplied clearance floor must conservatively cover both wire-to-pin
    and wire-to-via declarations; hashing a declaration does not prove a floor.
    Source/base identity and final fresh native/configured gates remain required.
    """
    result=dict(schema=DRILLED_SCHEMA,status='blocked',qualified=False,covered_holes=[],
        scope='all retained physical drilled geometry versus new other-net tracks; final native gate required',
        exporter_source=EXPORTER_SOURCE,inputs={})
    try:
        if not isinstance(holes,list):raise ValueError('missing complete native drilled inventory')
        if applicability not in ('reject_same_net','kicad10_project_track','custom_pth_track'):
            raise ValueError('unknown native drilled applicability')
        if (not isinstance(active_nets,list) or not active_nets or len(set(active_nets))!=len(active_nets)
                or any(not isinstance(n,str) or not n for n in active_nets)):raise ValueError('unknown active drilled nets')
        if applicability=='kicad10_project_track' and len(active_nets)!=1:
            raise ValueError('native project hole applicability requires one exact active net')
        if not isinstance(layers,list) or len(layers)!=1 or layers[0] not in ('F.Cu','B.Cu'):
            raise ValueError('drilled proof requires one exact actual outer routing layer')
        required=_d(required_mm);floor=_d(clearance_floor_mm)
        if required<0 or floor<0:raise ValueError('negative drilled clearance')
        with localcontext() as ctx:
            ctx.prec=max(50,2*(len(dsn_text)+len(str(holes))));ctx.traps[Inexact]=True;ctx.traps[Rounded]=True
            model=_DrilledModel(dsn_text,layers)
        if not set(active_nets)<=model.nets:raise ValueError('active drilled net missing from actual DSN')
        identities=set();used_pins=set();used_keepouts=set();used_vias=set();grid=None
        common={'kind','identity','net','supported','cause','native_form_sha256','position_mm','size_mm',
                'drill_mm','drill_shape','drill_offset_mm','shape','layers','hole_layers','rotation_deg'}
        pad_fields={'reference','pad','side','footprint_position_mm','footprint_rotation_deg','export_pin'}
        with localcontext() as ctx:
            ctx.prec=max(50,2*(len(dsn_text)+len(str(holes))));ctx.traps[Inexact]=True;ctx.traps[Rounded]=True
            for hole in holes:
                if not isinstance(hole,dict) or hole.get('supported') is not True:
                    raise ValueError('unsupported retained drilled geometry: '+str(hole.get('cause') if isinstance(hole,dict) else hole))
                kind=hole.get('kind')
                if kind not in ('pth','npth','via') or set(hole)!=(common if kind=='via' else common|pad_fields):
                    raise ValueError('unknown native drilled fields')
                identity=hole['identity']
                if (not isinstance(identity,str) or not identity or identity in identities
                        or not re.fullmatch(r'[0-9a-f]{64}',str(hole['native_form_sha256'])) or hole['cause'] is not None):
                    raise ValueError('missing or duplicate native physical drill identity')
                identities.add(identity)
                if not isinstance(hole['net'],str):raise ValueError('unknown native drilled net')
                if kind!='npth' and not hole['net']:raise ValueError('unassigned plated drill lacks a bound exported obstacle')
                custom_not_applicable=applicability=='custom_pth_track' and kind!='pth'
                same_net=kind!='npth' and hole['net'] in active_nets
                if same_net and applicability!='kicad10_project_track' and not custom_not_applicable:
                    raise ValueError('active same-net plated drill requires native applicability proof')
                if (not isinstance(hole['hole_layers'],list) or layers[0] not in hole['hole_layers']
                        or len(set(hole['hole_layers']))!=len(hole['hole_layers'])
                        or set(hole['hole_layers'])!=set(model.layers)):
                    raise ValueError('unknown physical drill layer extent')
                size=_pair(hole['size_mm']);drill_size=_pair(hole['drill_mm']);position=_pair(hole['position_mm'])
                rotation=_angle(hole['rotation_deg'])
                if (min(size)<=0 or min(drill_size)<=0 or _pair(hole['drill_offset_mm'])!=[0,0]
                        or hole['drill_shape'] not in ('circle','oval') or (hole['drill_shape']=='circle' and drill_size[0]!=drill_size[1])):
                    raise ValueError('invalid/offset physical drill')
                applied_required=Decimal(0) if custom_not_applicable else required
                drill=_capsule(position,drill_size,rotation)
                credited=Decimal(0) if custom_not_applicable else floor;record={}
                if kind=='npth':
                    if hole['net'] or hole['shape']!='circle' or hole['drill_shape']!='circle' or size[0]!=size[1]:
                        raise ValueError('unsupported NPTH circle contract')
                    image_name,image,place=model.image(hole);matches=[]
                    for ki,keepout in enumerate(_children(image,'keepout')+_children(image,'wire_keepout')):
                        if (len(keepout)!=3 or keepout[1]!='' or not isinstance(keepout[2],list)
                                or keepout[2][:2]!=['circle',layers[0]]):continue
                        shape=keepout[2]
                        if len(shape) not in (3,5):raise ValueError('malformed NPTH circle keepout')
                        xy=[Decimal(0),Decimal(0)] if len(shape)==3 else [_d(v)*model.scale for v in shape[3:]]
                        dx,dy=_rotate(*xy,_angle(place[5]));center=[_d(place[2])*model.scale+dx,-_d(place[3])*model.scale-dy]
                        diameter=_d(shape[2])*model.scale
                        if center==position and diameter>0 and (hole['reference'],ki) not in used_keepouts:
                            matches.append((ki,dict(kind='capsule',ends=(tuple(center),tuple(center)),radius=diameter/2),xy))
                    # A keepout is a universal wire obstacle; unlike electrical
                    # copper its declared radius alone must cover the hole.
                    matches=[m for m in matches if _contains_drill(m[1],drill,applied_required,Decimal(0))]
                    if len(matches)!=1:raise ValueError('missing or ambiguous source-bound NPTH wire keepout')
                    ki,obstacle,xy=matches[0];used_keepouts.add((hole['reference'],ki));credited=Decimal(0)
                    record.update(dsn_image=image_name,dsn_keepout_index=ki)
                else:
                    if (not isinstance(hole['layers'],list) or layers[0] not in hole['layers']
                            or len(set(hole['layers']))!=len(hole['layers']) or not set(hole['layers'])<=set(model.layers)):
                        raise ValueError('plated drill lacks routing-layer copper')
                    if kind=='via':
                        if hole['shape']!='circle' or size[0]!=size[1] or hole['drill_shape']!='circle':raise ValueError('unsupported retained via geometry')
                        # The exporter writes via points with "%.6g" (specctra.h:2980), so a center
                        # can lose its last digit. Bind that exact text; the drill keeps the native
                        # center, so the containment proof below pays for the offset.
                        text=tuple('%.6g'%float(v) for v in (position[0]/model.scale,-position[1]/model.scale))
                        matches=[(i,v) for i,v in enumerate(model.vias) if i not in used_vias and v[3]==text and v[2]==hole['net']]
                        if len(matches)!=1:raise ValueError('missing or ambiguous fixed exported via instance')
                        vi,(stack,center,net,_)=matches[0];used_vias.add(vi);shape=model.shape(stack,layers[0])
                        obstacle=_obstacle(shape,model.scale,center,0)
                        expected=_capsule(center,size,0);record.update(dsn_via_index=vi,dsn_padstack=stack)
                    else:
                        if hole['side']!='front' or hole['shape'] not in ('circle','rect','oval'):raise ValueError('unsupported plated pad copper')
                        image_name,image,place=model.image(hole);pin=hole['export_pin'];key=(hole['reference'],pin)
                        if (not isinstance(pin,str) or not re.fullmatch(re.escape(hole['pad'])+r'(?:@[1-9][0-9]*)?',pin)
                                or key in used_pins):raise ValueError('ambiguous physical plated pin alias')
                        used_pins.add(key);pins=_pins(image)
                        if pin not in pins or model.members.get(hole['reference']+'-'+pin)!=hole['net']:
                            raise ValueError('actual plated pin/net membership differs from native')
                        stack,xy,pin_rotation=pins[pin];fp_rotation=_angle(place[5]);dx,dy=_rotate(_d(xy[0])*model.scale,_d(xy[1])*model.scale,fp_rotation)
                        center=[_d(place[2])*model.scale+dx,-_d(place[3])*model.scale-dy]
                        if center!=position:raise ValueError('actual physical pin center differs from native')
                        shape=model.shape(stack,layers[0]);obstacle=_obstacle(shape,model.scale,center,(fp_rotation+pin_rotation)%360)
                        if hole['shape']=='rect':
                            w,h=size;points=[]
                            for x in (-w/2,w/2):
                                for y in (-h/2,h/2):
                                    dx,dy=_rotate(x,-y,rotation);points.append((position[0]+dx,position[1]-dy))
                            expected=dict(kind='rect',bounds=(min(x for x,y in points),min(y for x,y in points),max(x for x,y in points),max(y for x,y in points)))
                        else:
                            if hole['shape']=='circle' and size[0]!=size[1]:raise ValueError('noncircular native circle copper')
                            expected=_capsule(position,size,rotation)
                        record.update(dsn_image=image_name,dsn_pin=pin,dsn_padstack=stack)
                    if obstacle!=expected:raise ValueError('actual DSN copper differs from native drilled geometry')
                    if not same_net and not custom_not_applicable and shape[0]=='path':
                        raise ValueError('oval/path backend integer-octagon containment is unsupported; ideal capsule is not an actual backend proof')
                    if not same_net and not custom_not_applicable and not _contains_drill(obstacle,drill,required,credited):
                        raise ValueError('actual DSN copper plus verified clearance does not contain expanded native drill')
                if not same_net or custom_not_applicable:
                    if grid is None:grid=_verified_grid(model,backend_command,backend_policy,result['inputs'])
                    _grid_mm(model,floor)
                    _grid_mm(model,credited)
                    for value in position:_grid_mm(model,value)
                    if kind!='via':
                        for value in _pair(hole['footprint_position_mm']):_grid_mm(model,value)
                    if kind=='pth':
                        for value in xy:_grid_mm(model,_d(value)*model.scale)
                    if obstacle['kind']=='capsule':
                        _grid_mm(model,obstacle['radius'])
                        for point in obstacle['ends']:
                            for value in point:_grid_mm(model,value)
                    else:
                        for value in obstacle['bounds']:_grid_mm(model,value)
                    if kind=='npth':
                        for value in xy:_grid_mm(model,value)
                if custom_not_applicable:
                    record.update(disposition='custom_not_applicable',
                        reason='caller-proved Track/PTH custom scope excludes this bound non-PTH instance; independent project minimum remains required')
                elif same_net:
                    record.update(disposition='native_not_applicable',
                        reason='KiCad10 track visitor excludes connected items on the same nonzero net before testing hole clearance',
                        applicability_source=TRACK_HOLE_APPLICABILITY_SOURCE)
                    credited=Decimal(0)
                else:record['disposition']='covered'
                result['covered_holes'].append(dict(kind=kind,identity=identity,net=hole['net'],layer=layers[0],
                    native_center_mm=hole['position_mm'],native_drill_mm=hole['drill_mm'],
                    native_rotation_deg=rotation,required_mm=format(applied_required,'f'),credited_clearance_mm=format(credited,'f'),**record))
        if len(used_vias)!=len(model.vias):raise ValueError('unmatched exported retained via inventory')
        result.update(status='covered',cause='every physical drill is bound; every applicable expanded drill is protected by its actual DSN obstacle',
            required_mm=format(required,'f'),clearance_floor_mm=format(floor,'f'),native_hole_count=len(holes),
            applicability=applicability,backend_geometry=grid)
    except (ValueError,TypeError,KeyError,ArithmeticError,IndexError,OSError) as error:
        result.update(status='blocked',cause=str(error) or type(error).__name__)
    return result
