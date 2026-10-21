"""Typed project minima against the actual admitted router model and argv.

No KiCad defaults are invented. Unsupported applicable requirements abstain.
The caller binds source files, establishes immutable native geometry and
supplies the final command that will be used, then runs the native gate.
"""
from decimal import Decimal
import json
import re

import route_hole_coverage


REQUIRED = ('min_clearance', 'min_copper_edge_clearance', 'min_hole_clearance',
            'min_hole_to_hole', 'min_track_width', 'min_microvia_diameter',
            'min_microvia_drill', 'min_through_hole_diameter',
            'min_via_annular_width', 'min_via_diameter', 'min_connection',
            'min_resolved_spokes', 'min_groove_width', 'min_silk_clearance',
            'min_text_height', 'min_text_thickness', 'solder_mask_to_copper_clearance')
HOLE_DIMENSIONS = {'min_hole_to_hole', 'min_microvia_diameter',
                   'min_microvia_drill', 'min_through_hole_diameter',
                   'min_via_annular_width', 'min_via_diameter'}
FIXED_GEOMETRY = {'min_groove_width', 'min_silk_clearance', 'min_text_height',
                  'min_text_thickness'}
TEXT = {'min_text_height', 'min_text_thickness'}
# Rules that only the final native DRC can decide when new vias are possible:
# rule/constraint name -> KiCad 10 DRC item types (kicad_pro rule_severities keys).
NATIVE_DRC = {'min_hole_to_hole': ['hole_to_hole', 'holes_co_located'],
              'hole_to_hole': ['hole_to_hole', 'holes_co_located'],
              'min_hole_clearance': ['hole_clearance'], 'hole_clearance': ['hole_clearance'],
              'min_silk_clearance': ['silk_overlap', 'silk_over_copper'],
              'silk_clearance': ['silk_overlap', 'silk_over_copper']}
VIA_NAME = re.compile(r'Via\[(\d+)-(\d+)\]_(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)_um')


def native_drc(constraint, **extra):
    """Pending obligation: the final native DRC must report none of these types."""
    return dict(disposition='native_postcondition',
        native_obligation=dict(extra, constraint=constraint, enforcement='native-drc',
                               drc_types=list(NATIVE_DRC[constraint])),
        reason='new vias are possible; the final native DRC of the saved candidate must show zero findings of these types')


def via_sizes(dsn_text, model, active_nets, classes, net_classes):
    """Every via the active nets can get, from the actual DSN and the job's via source.

    KiCad 10 specctra_export.cpp makeVia names a via padstack
    "Via[%d-%d]_%.6g:%.6g_um" (DSN copper diameter, drill in um) and
    specctra_import.cpp makeVIA reads the drill back from that name. The
    router can place only the padstacks of the structure via list and of the
    active class use_via. fastroute_job --signal-via sets new vias to the
    project netclass via size, so those sizes are included too."""
    hc = route_hole_coverage
    root = hc._parse(dsn_text)
    structure, network, library = hc._one(root, 'structure'), hc._one(root, 'network'), hc._one(root, 'library')
    stacks, copper = hc._index(library, 'padstack'), [l[1] for l in hc._children(structure, 'layer')]
    names = {v for form in hc._children(structure, 'via') for v in form[1:] if isinstance(v, str)}
    dsn_classes = hc._index(network, 'class')
    for net in active_nets:
        for circuit in hc._children(dsn_classes[model.membership[net]], 'circuit'):
            names |= {v for use in hc._children(circuit, 'use_via') for v in use[1:] if isinstance(v, str)}
    if not names:
        raise ValueError('active nets may change layer, but the actual DSN declares no via padstack')
    result = []
    for name in sorted(names):
        match = VIA_NAME.fullmatch(name)
        if not match or name not in stacks:
            raise ValueError('via padstack is missing or not the exact KiCad DSN via encoding: ' + name)
        top, bottom = int(match[1]), int(match[2])
        shapes = hc._children(stacks[name], 'shape')
        if (bottom >= len(copper) or top > bottom
                or any(len(s) != 2 or not isinstance(s[1], list) or len(s[1]) != 3 or s[1][0] != 'circle'
                       or hc._d(s[1][2]) != Decimal(match[3]) for s in shapes)
                or sorted(s[1][1] for s in shapes) != sorted(copper[top:bottom + 1])):
            raise ValueError('via padstack copper differs from its exact name encoding: ' + name)
        result.append(dict(source='dsn padstack ' + name, diameter=Decimal(match[3]) * hc.UNITS[model.unit],
            drill=Decimal(match[4]) / 1000, through=top == 0 and bottom == len(copper) - 1))
    for name in sorted({net_classes[net] for net in active_nets}):
        item = classes.get(name, (None, {}))[1]
        result.append(dict(source='netclass ' + name, diameter=_number(item.get('via_diameter')),
            drill=_number(item.get('via_drill')), through=True))
    return result
KNOWN = set(REQUIRED) | FIXED_GEOMETRY | {'min_connection', 'min_resolved_spokes',
                                       'max_error', 'use_height_for_length_calcs',
                                       'solder_mask_to_copper_clearance'}

THERMAL_SOURCES = [
    'https://raw.githubusercontent.com/KiCad/kicad-source-mirror/10.0.6/pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr_parser.cpp',
    'https://raw.githubusercontent.com/KiCad/kicad-source-mirror/10.0.6/pcbnew/zones.h',
    'https://raw.githubusercontent.com/KiCad/kicad-source-mirror/10.0.6/pcbnew/drc/drc_test_provider_zone_connections.cpp',
]


def thermal_scope(native_roots, custom_rules):
    """Prove only the complete no-zone/all-explicit-solid/no-override subset."""
    result = dict(thermal_connections_possible=True, zones=0, overrides=0,
                  primary_sources=list(THERMAL_SOURCES))
    def walk(form):
        if isinstance(form, list):
            yield form
            for item in form:
                yield from walk(item)
    try:
        for form in walk(custom_rules):
            if form[:2] == ['constraint', 'zone_connection']:
                raise ValueError('custom zone-connection rules need native applicability resolution')
        for root in native_roots:
            for form in walk(root):
                if form[:1] == ['zone']:
                    if any(isinstance(v,list) and v[:1]==['keepout'] for v in form):
                        continue
                    result['zones'] += 1
                    connections = [v for v in form if isinstance(v,list) and v[:1]==['connect_pads']]
                    if len(connections) != 1:
                        raise ValueError('zone thermal mode is missing or ambiguous')
                    modes = [v for v in connections[0][1:] if isinstance(v,str)]
                    if modes not in (['yes'], ['no']):
                        raise ValueError('native zone mode is thermal/default/unknown')
                elif form[:1] == ['zone_connect']:
                    result['overrides'] += 1
                    # Native enum: INHERITED=-1,NONE=0,THERMAL=1,FULL=2,THT_THERMAL=3.
                    if form[1:] not in (['-1'], ['0'], ['2']):
                        raise ValueError('footprint/pad zone mode can require thermal reliefs')
        result.update(thermal_connections_possible=False,
            reason='complete native scope has no zones or only explicit solid/none zones, with no thermal footprint/pad/custom-rule override')
    except ValueError as error:
        result['reason'] = str(error)
    return result


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate project field: ' + key)
        result[key] = value
    return result


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (Decimal, int, float)):
        raise ValueError('expected authored finite nonnegative number in millimetres')
    result = Decimal(str(value))
    if not result.is_finite() or result < 0:
        raise ValueError('expected authored finite nonnegative number in millimetres')
    return result


def _load(text):
    if text is None:
        raise ValueError('native project file is missing; resolved project requirements are unknown')
    def invalid(value):
        raise ValueError('nonfinite project JSON number: ' + value)
    project = json.loads(text, object_pairs_hook=_unique, parse_float=Decimal,
                         parse_int=Decimal, parse_constant=invalid)
    if not isinstance(project, dict):
        raise ValueError('native project must be an object')
    try:
        rules = project['board']['design_settings']['rules']
        classes = project['net_settings']['classes']
    except (KeyError, TypeError) as error:
        raise ValueError('project rules/netclass requirements are unresolved') from error
    if not isinstance(rules, dict) or not isinstance(classes, list) or not classes:
        raise ValueError('project rules and nonempty netclass list are required')
    names = {}
    for index, item in enumerate(classes):
        if (not isinstance(item, dict) or not isinstance(item.get('name'), str)
                or not item['name'] or item['name'] in names):
            raise ValueError('project netclasses have missing/duplicate names')
        names[item['name']] = (index, item)
    if 'Default' not in names:
        raise ValueError('explicit Default netclass is required')
    return rules, names


def command_floor(command, name):
    """Require one exact integer-micrometre option; duplicates never override."""
    if not isinstance(command, list) or not command or any(not isinstance(v, str) for v in command):
        raise ValueError('final backend argv is missing or malformed')
    prefix = '--router.' + name
    values = [value for value in command if value == prefix or value.startswith(prefix + '=')]
    if len(values) != 1:
        raise ValueError('exactly one ' + prefix + ' is required; missing/duplicate override is unknown')
    text = values[0][len(prefix) + 1:]
    if not text or not text.isascii() or not text.isdecimal():
        raise ValueError('backend control must be an explicit nonnegative integer micrometre value: ' + prefix)
    return Decimal(text) / Decimal(1000)


def evaluate(text, *, source, model, dsn_text, active_nets, net_classes, obstacles,
             layers, holes, holes_preserved, immutable_geometry_preserved,
             backend_command, thermal=None, backend_policy=None,
             native_thermal_capability=None, added_vias=None):
    rows = []

    def row(name, pointer, value=None):
        result = dict(rule='native project', constraint=name, disposition='unsupported',
                      source=dict(path=str(source), pointer=pointer))
        if value is not None:
            result['required_mm'] = str(value)
        rows.append(result)
        return result

    try:
        rules, classes = _load(text)
    except (ValueError, TypeError) as error:
        row('project_document', '')['reason'] = str(error)
        return rows

    moving_vias = any(len(model.allowed(net)) != 1 for net in active_nets)
    vias, via_error = None, None
    if moving_vias:
        try:
            # Through vias the job added to the base before routing are fixed router input.
            vias = via_sizes(dsn_text, model, active_nets, classes, net_classes) + [dict(
                source='base via ' + h['identity'], diameter=Decimal(h['size_mm'][0]),
                drill=Decimal(h['drill_mm'][0]), through=True) for h in added_vias or []]
            for item in vias:
                item['annular'] = (item['diameter'] - item['drill']) / 2
        except (ValueError, KeyError, TypeError, IndexError, ArithmeticError) as error:
            via_error = str(error)
    counterparts = {obj['NetName'] for obj in obstacles} | set(active_nets)
    pairs = [(left, right) for left in sorted(active_nets) for right in sorted(counterparts) if left != right]
    # Every actual class used by active/retained objects must resolve against
    # the authored project; absent inheritance is not an invented zero/default.
    used = {net_classes[net] for net in counterparts}
    for name in sorted(used):
        index, item = classes.get(name, (None, None))
        pointer = '/net_settings/classes/' + str(index) + '/clearance' if index is not None else '/net_settings/classes'
        item_row = row('netclass_clearance', pointer)
        item_row['netclass'] = name
        try:
            if item is None or 'clearance' not in item:
                raise ValueError('actual native netclass clearance is unresolved: ' + str(name))
            value = _number(item['clearance'])
            item_row['required_mm'] = str(value)
            relevant = [(a, b) for a, b in pairs if net_classes[a] == name or net_classes[b] == name]
            if not relevant:
                item_row.update(disposition='not_applicable', reason='no different-net active/retained pair uses this class')
            elif value == 0:
                item_row.update(disposition='not_applicable', reason='explicit authored zero adds no positive clearance floor')
            else:
                floor = min(model.clearance_floor(a, b) for a, b in relevant)
                item_row.update(model_floor_mm=str(floor), disposition='covered' if floor >= value else 'weaker_than_native',
                    witness=dict(active=relevant[0][0], obstacle=relevant[0][1]),
                    reason='conservative actual final DSN clearance floor; no unproved precedence override')
        except (ValueError, KeyError, TypeError) as error:
            item_row['reason'] = str(error)

    for name in sorted(set(rules) | set(REQUIRED)):
        pointer = '/board/design_settings/rules/' + name.replace('~', '~0').replace('/', '~1')
        item_row = row(name, pointer)
        try:
            if name not in KNOWN:
                raise ValueError('unknown project requirement; routing applicability is unproved')
            if name not in rules:
                item_row['source']['exists'] = False
                if (name == 'min_resolved_spokes' and thermal is not None
                        and thermal.get('thermal_connections_possible') is False and immutable_geometry_preserved):
                    item_row.update(disposition='not_applicable', thermal_applicability=thermal,
                        reason='undeclared threshold is not invented; exact native scope has no possible thermal connections')
                    continue
                if (name in FIXED_GEOMETRY or name in HOLE_DIMENSIONS) and (not moving_vias or name in TEXT) and (
                        immutable_geometry_preserved if name in FIXED_GEOMETRY else holes_preserved):
                    item_row.update(disposition='immutable_unchanged',
                        reason='undeclared threshold is unknown but its exact native geometry cannot change under this scope')
                    continue
                raise ValueError('native project minimum is absent; resolved value is unknown')
            item_row['source']['exists'] = True
            if name == 'use_height_for_length_calcs':
                if not isinstance(rules[name], bool):
                    raise ValueError('project length-calculation selector must be boolean')
                item_row.update(disposition='not_applicable', reason='length measurement convention adds no routing limit')
                continue
            value = _number(rules[name])
            item_row['required_mm' if name != 'min_resolved_spokes' else 'required_count'] = str(value)
            if name == 'min_resolved_spokes' and value != value.to_integral_value():
                raise ValueError('resolved thermal-spoke count must be an authored integer')
            if name == 'max_error':
                item_row.update(disposition='not_applicable', reason='native polygon approximation parameter adds no authored new-track minimum; exact supported geometry proofs still required')
            elif value == 0:
                item_row.update(disposition='not_applicable', reason='explicit authored zero adds no positive requirement')
            elif name == 'min_clearance':
                if not pairs:
                    item_row.update(disposition='not_applicable', reason='no different-net counterpart can receive new-copper clearance')
                else:
                    floor = min(model.clearance_floor(a, b) for a, b in pairs)
                    item_row.update(model_floor_mm=str(floor), disposition='covered' if floor >= value else 'weaker_than_native',
                                    reason='all potentially applicable final DSN clearances meet the project minimum')
            elif name in ('min_track_width', 'min_copper_edge_clearance'):
                control = 'min_trace_width_um' if name == 'min_track_width' else 'copper_to_edge_clearance_um'
                floor = command_floor(backend_command, control)
                if name == 'min_track_width' and isinstance(backend_command, list):
                    necks = [v for v in backend_command if v == '--router.neck_width_um' or v.startswith('--router.neck_width_um=')]
                    if necks:
                        neck = command_floor(backend_command, 'neck_width_um')
                        if neck > 0:
                            floor = min(floor, neck)
                item_row.update(backend_control=control, model_floor_mm=str(floor),
                    disposition='covered' if floor >= value else 'weaker_than_native',
                    reason='exact final backend command control compared to authored project minimum')
            elif name == 'min_hole_clearance':
                if moving_vias:
                    item_row.update(native_drc(name, required_mm=str(value)))
                    continue
                if holes is None or not holes_preserved:
                    raise ValueError('complete unchanged original/base drilled geometry is required')
                proofs = []
                for net in sorted(active_nets):
                    applicable = [hole for hole in holes if hole.get('net') != net or not hole.get('supported')]
                    # Zero credits no assumed clearance when every plated hole
                    # is same-net; full inventory/model bindings still checked.
                    floor = min((model.clearance_floor(net, hole.get('net') or None) for hole in applicable), default=Decimal(0))
                    proof = route_hole_coverage.inspect_drilled(dsn_text, holes=holes,
                        active_nets=[net], layers=model.allowed(net), required_mm=str(value),
                        clearance_floor_mm=str(floor), applicability='kicad10_project_track',
                        backend_policy=backend_policy, backend_command=backend_command)
                    proofs.append(dict(active_net=net, proof=proof))
                item_row['hole_geometry'] = proofs
                failures = [p['proof'].get('cause', 'drilled containment unknown') for p in proofs if p['proof'].get('status') != 'covered']
                if failures:
                    raise ValueError('; '.join(failures))
                item_row.update(disposition='covered' if proofs else 'not_applicable',
                    reason='all applicable original drilled items have exact final DSN containment' if proofs else 'complete native inventory has no different-net drilled item')
            elif name in HOLE_DIMENSIONS and not moving_vias:
                if not holes_preserved:
                    raise ValueError('hole-only dimensions require verified no-new-via masks and unchanged original/base holes')
                item_row.update(disposition='immutable_unchanged', reason='actual active-net masks forbid new holes; exact source/base drilled geometry remains fixed')
            elif name in HOLE_DIMENSIONS:
                if not holes_preserved and added_vias is None:
                    raise ValueError('new vias are possible; source drilled geometry must be unchanged in the base, with only added through vias')
                if name == 'min_hole_to_hole':
                    item_row.update(native_drc(name, required_mm=str(value)))
                    continue
                if via_error is not None:
                    raise ValueError(via_error)
                if name.startswith('min_microvia_'):
                    if not all(v['through'] for v in vias):
                        raise ValueError('a blind/buried/micro via padstack can be placed; microvia minimum is unproved')
                    item_row.update(disposition='not_applicable', reason='every via the active nets can get is a through via; original holes unchanged')
                    continue
                key = dict(min_via_diameter='diameter', min_through_hole_diameter='drill', min_via_annular_width='annular')[name]
                low = min(vias, key=lambda v: v[key])
                text = lambda v: '{:f}'.format(v.normalize())
                item_row.update(model_floor_mm=text(low[key]), via_padstacks=[dict(source=v['source'],
                    diameter_mm=text(v['diameter']), drill_mm=text(v['drill']), annular_mm=text(v['annular']),
                    through=v['through']) for v in vias])
                if low[key] >= value:
                    item_row.update(disposition='covered', reason='every via the active nets can get meets the minimum: exact DSN padstacks and netclass via sizes; original holes unchanged')
                else:
                    item_row.update(disposition='weaker_than_native',
                        reason=low['source'] + ' ' + key + ' ' + text(low[key]) + ' mm is below the project minimum')
            elif name == 'min_silk_clearance' and moving_vias and immutable_geometry_preserved:
                item_row.update(native_drc(name, required_mm=str(value)))
            elif name in FIXED_GEOMETRY:
                if (moving_vias and name not in TEXT) or not immutable_geometry_preserved:
                    raise ValueError('fixed text/mask/outline rule needs unchanged geometry and no new holes')
                item_row.update(disposition='immutable_unchanged', reason='router adds only tracks and vias, never text; source/base text preserved'
                    if name in TEXT else 'source/base fixed text, mask, outline and footprint geometry preserved; model introduces tracks only')
            elif (name == 'min_resolved_spokes' and thermal is not None
                    and thermal.get('thermal_connections_possible') is False and immutable_geometry_preserved):
                item_row.update(disposition='not_applicable', thermal_applicability=thermal, reason=thermal['reason'])
            elif name == 'min_resolved_spokes' and native_thermal_capability is not None:
                # check_files revalidates the native input evidence before
                # supplying this capability. It does not model spokes in DSN.
                capability = native_thermal_capability
                if (capability.get('schema') != 'iot-lab.native-thermal-capability.v1'
                        or capability.get('status') != 'pending_native'
                        or type(capability.get('required_count')) is not int
                        or capability['required_count'] != value
                        or not immutable_geometry_preserved):
                    raise ValueError('native thermal capability differs from the authored count or immutable scope')
                item_row.update(disposition='native_postcondition',
                    native_obligation=dict(constraint=name, required_count=str(value),
                        capability_sha256=capability['content_sha256']),
                    reason='explicit native input capability; resolved spokes remain pending until exact final native verification')
            else:
                raise ValueError('applicable project constraint has no proven router-model enforcement')
        except (ValueError, KeyError, TypeError, ArithmeticError) as error:
            item_row['reason'] = str(error)
    return rows
