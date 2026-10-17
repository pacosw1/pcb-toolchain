"""Read installed KiCad part identities without changing CAD or loading pcbnew.

Use the existing strict population/native parser, including hierarchical instance
resolution. Pad angles follow the existing block_bindings local-angle convention.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
from decimal import Decimal

TOOLS = Path(__file__).resolve().parent


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def children(node, name):
    return [v for v in node[1:] if isinstance(v, list) and v and v[0] == name]


def single(node, name, default=None):
    values = children(node, name)
    if len(values) > 1:
        raise ValueError('ambiguous native field: ' + name)
    return values[0] if values else default


def properties(node):
    result = {}
    for prop in children(node, 'property'):
        if len(prop) < 3 or prop[1] in result:
            raise ValueError('duplicate/malformed native property')
        result[prop[1]] = prop[2]
    return result


def owned(root, name):
    if not isinstance(name, str) or Path(name).is_absolute() or '\\' in name or any(v in ('', '.', '..') for v in name.split('/')):
        raise ValueError('expected repository-relative evidence path')
    path = (root / name).resolve()
    path.relative_to(root.resolve())
    if not path.is_file():
        raise ValueError('missing evidence file: ' + name)
    return path


def canonical_number(value):
    number = Decimal(str(value))
    if not number.is_finite():
        raise ValueError('nonfinite native geometry')
    return str(number.normalize()) if number else '0'


def normalized(node):
    if isinstance(node, list):
        return [normalized(v) for v in node if not (isinstance(v, list) and v and v[0] in ('uuid', 'tstamp'))]
    try:
        return canonical_number(node)
    except Exception:
        return node


def pads(form):
    rotation = Decimal(str((single(form, 'at') or ['at', '0', '0', '0'])[3])) if len(single(form, 'at') or []) > 3 else Decimal(0)
    geometry, nets = [], {}
    for pad in children(form, 'pad'):
        if len(pad) < 4:
            raise ValueError('malformed native pad')
        number = pad[1]
        if not number and pad[2] != 'np_thru_hole':
            raise ValueError('unnumbered electrical pad requires explicit native support')
        net = single(pad, 'net')
        net_name = net[-1] if net else ''
        if net_name.isdecimal():
            raise ValueError('legacy numeric pad net requires normalization')
        if number and number in nets and nets[number] != net_name:
            raise ValueError('duplicate pad number has inconsistent nets')
        if number:
            nets[number] = net_name
        shape = []
        for item in pad[2:]:
            if not isinstance(item, list):
                shape.append(item)
            elif item[0] == 'at':
                angle = Decimal(item[3]) if len(item) == 4 else Decimal(0)
                shape.append(['at', canonical_number(item[1]), canonical_number(item[2]),
                              canonical_number((angle - rotation + 360) % 360)])
            elif item[0] not in ('net', 'uuid', 'tstamp', 'pinfunction', 'pintype'):
                shape.append(normalized(item))
        geometry.append({'number': number, 'definition': shape})
    if not geometry:
        raise ValueError('native footprint has no pads')
    geometry.sort(key=lambda value: encoded(value))
    return geometry, dict(sorted(nets.items()))


def resolve_library(libraries, identifier, visiting=()):
    if identifier in visiting or len(visiting) >= 64:
        raise ValueError('cyclic/excessive native symbol inheritance')
    if identifier not in libraries:
        raise ValueError('embedded symbol definition missing: ' + identifier)
    node = libraries[identifier]
    parent = single(node, 'extends')
    if not parent:
        return [node]
    name = parent[1]
    qualified = identifier.rsplit(':', 1)[0] + ':' + name if ':' in identifier and ':' not in name else name
    candidates = sorted({key for key in (name, qualified) if key in libraries})
    if len(candidates) != 1:
        raise ValueError('ambiguous/missing embedded parent symbol')
    return resolve_library(libraries, candidates[0], visiting + (identifier,)) + [node]


def symbol_pins(definitions, unit):
    pins = {}
    def visit(node, active=True):
        if not isinstance(node, list) or not node:
            return
        if node[0] == 'symbol' and len(node) > 1:
            match = re.search(r'_(\d+)_(\d+)$', node[1])
            if match:
                if int(match[2]) not in (0, 1):
                    raise ValueError('alternate symbol body requires explicit native support')
                active = int(match[1]) in (0, unit)
        if node[0] == 'pin' and active:
            number, name = single(node, 'number'), single(node, 'name')
            if not number or not name:
                raise ValueError('native symbol pin number/name missing')
            value = {'name': name[1], 'type': node[1]}
            if number[1] in pins and pins[number[1]] != value:
                raise ValueError('ambiguous inherited symbol pin definition')
            pins[number[1]] = value
        for item in node[1:]:
            if isinstance(item, list):
                visit(item, active)
    for definition in definitions:
        visit(definition)
    if not pins:
        raise ValueError('native symbol has no selected unit pins')
    return pins


def read_board(root, board):
    root = Path(root).resolve()
    if not isinstance(board, str) or not re.fullmatch(r'[A-Z0-9][A-Z0-9-]*', board):
        raise ValueError('expected configured board ID')
    config_name = 'hardware-design/boards/' + board + '/gate.json'
    config_path = owned(root, config_name)
    config_bytes = config_path.read_bytes()
    config = json.loads(config_bytes)
    stem = (config_path.parent / config['project']).resolve()
    project = stem.relative_to(root).as_posix()
    if not project.startswith('hardware-design/boards/' + board + '/'):
        raise ValueError('native project escapes board owner')
    node = shutil.which('node')
    if not node:
        raise RuntimeError('Node.js required for existing strict KiCad population reader')
    program = '''
import {readFileSync} from 'node:fs';
import {readPopulation,parseNative,children,single} from __READER__;
const [root,project]=process.argv.slice(1);
const p=readPopulation(root,project);
const schematics={}; let pcb;
for(const file of Object.keys(p.sources)) {
 const tree=parseNative(readFileSync(root+'/'+file,'utf8'));
 if(file.endsWith('.kicad_sch')) schematics[file]={root_uuid:single(tree,'uuid')?.[1],libraries:single(tree,'lib_symbols')??['lib_symbols'],placed:children(tree,'symbol')};
 else pcb=children(tree,'footprint');
}
console.log(JSON.stringify({symbols:Object.fromEntries(p.symbols),footprints:Object.fromEntries(p.footprints),sources:p.sources,schematics,pcb}));
'''.replace('__READER__', json.dumps((TOOLS / 'lib/kicad-population.mjs').as_uri()))
    result = subprocess.run([node, '--input-type=module', '-e', program, str(root), project],
                            text=True, capture_output=True, timeout=60)
    if result.returncode:
        raise ValueError('native population reader failed: ' + result.stderr[-2000:])
    native = json.loads(result.stdout)
    root_uuid = native['schematics'][project + '.kicad_sch']['root_uuid']
    by_ref = {properties(form)['Reference']: form for form in native['pcb']}
    facts, errors = {}, []
    for ref, footprint in native['footprints'].items():
        if ref not in native['symbols'] and not (footprint['board_only'] and footprint['excluded']):
            errors.append({'code': 'native_unmatched_footprint', 'reference': ref,
                           'detail': 'PCB reference has no schematic identity and is not excluded board-only mechanics'})
    for ref, metadata in sorted(native['symbols'].items()):
        if not metadata['on_board'] or not metadata['footprint']:
            continue
        fp = by_ref.get(ref)
        if fp is None:
            errors.append({'code': 'native_missing_footprint', 'reference': ref, 'detail': 'physical schematic reference missing from PCB'})
            continue
        pcb = native['footprints'][ref]
        for field in ('mpn', 'lcsc', 'footprint', 'dnp'):
            if metadata[field] != pcb[field]:
                errors.append({'code': 'native_identity_mismatch', 'reference': ref, 'detail': 'schematic/PCB differs: ' + field})
        if metadata['in_bom'] == pcb['excluded']:
            errors.append({'code': 'native_identity_mismatch', 'reference': ref, 'detail': 'schematic/PCB BOM inclusion differs'})
        path = pcb.get('path') or ''
        context, _, primary_uuid = path.rpartition('/')
        expected_context = context if context.startswith('/' + root_uuid) else '/' + root_uuid + context
        pins, symbols, selected_uuids = {}, [], []
        for file, schematic in native['schematics'].items():
            libraries = {form[1]: form for form in children(schematic['libraries'], 'symbol')}
            for placed in schematic['placed']:
                props = properties(placed)
                instances = single(placed, 'instances')
                unit = None
                if instances:
                    projects = [p for p in children(instances, 'project') if p[1] == stem.name]
                    for candidate in projects:
                        for instance in children(candidate, 'path'):
                            inst_ref = single(instance, 'reference')
                            if instance[1] == expected_context and inst_ref and inst_ref[1] == ref:
                                unit = int(single(instance, 'unit')[1])
                elif props.get('Reference') == ref and single(placed, 'uuid', ['', ''])[1] == primary_uuid:
                    unit = int(single(placed, 'unit')[1])
                if unit is None:
                    continue
                definitions = resolve_library(libraries, single(placed, 'lib_id')[1])
                selected_uuids.append(single(placed, 'uuid', ['', ''])[1])
                for number, value in symbol_pins(definitions, unit).items():
                    if number in pins and pins[number] != value:
                        raise ValueError('inconsistent multi-unit native pin: ' + ref)
                    pins[number] = value
                symbols.append({'file': file, 'unit': unit, 'definitions': definitions})
        if not symbols or primary_uuid not in selected_uuids:
            errors.append({'code': 'native_symbol_binding', 'reference': ref, 'detail': 'PCB path does not identify a schematic instance'})
            continue
        geometry, pad_nets = pads(fp)
        # Installed package identity is independent of translation/rotation/net
        # assignment; the exact geometry and assigned nets have separate hashes.
        package = {'identifier': fp[1], 'pads': geometry,
                   'graphics': normalized([v for v in fp[2:] if isinstance(v, list) and v and
                                           v[0] in ('fp_line', 'fp_rect', 'fp_circle', 'fp_arc', 'fp_poly', 'zone')])}
        symbol_assets = [{'unit': value['unit'], 'definitions': value['definitions']} for value in symbols]
        facts[ref] = {**metadata, 'pcb_path': path, 'symbol_sha256': digest(encoded(sorted(symbol_assets, key=lambda v: encoded(v)))),
                      'pin_map': dict(sorted(pins.items())), 'footprint_sha256': digest(encoded(package)),
                      'land_geometry_sha256': digest(encoded(geometry)), 'pad_net_map': pad_nets,
                      'pad_numbers': sorted(pad_nets), 'required': metadata['in_bom'] and not metadata['dnp'],
                      'pose': single(fp, 'at', ['at'])[1:]}
    inputs = {config_name: digest(config_bytes), **native['sources']}
    for file, expected in inputs.items():
        if digest(owned(root, file).read_bytes()) != expected:
            raise ValueError('native source changed during inspection: ' + file)
    return {'board': board, 'project': project, 'parts': facts, 'blockers': errors,
            'native_inputs': inputs, 'reader_inputs': {str(TOOLS / 'lib/kicad-population.mjs'):
                digest((TOOLS / 'lib/kicad-population.mjs').read_bytes()), str(Path(__file__).resolve()): digest(Path(__file__).read_bytes()),
                str(Path(node).resolve()): digest(Path(node).resolve().read_bytes())}}
