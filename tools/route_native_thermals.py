"""Opt-in native thermal postcondition, never a DSN coverage claim.

Checked Fill+Save and independent DRC are separate evidence.  The initial
capability permits only the named postcondition to remain pending; discharge
does not replace protected-input checks or the full configured final gate.
No native tool is executed here.
"""
import hashlib
import json
import math
from pathlib import Path
import re

import placer.dru as native_parser
from placer.dru import _tokens, _tree


CAPABILITY_SCHEMA = 'iot-lab.native-thermal-capability.v1'
DISCHARGE_SCHEMA = 'iot-lab.native-thermal-discharge.v1'
VERSION = '10.0.6'
_HEX = re.compile(r'[0-9a-f]{64}')


def _identity(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                     allow_nan=False).encode()).hexdigest()


def _path(value):
    if not isinstance(value, (str, Path)) or not str(value):
        raise ValueError('missing evidence path')
    path = Path(value)
    if not path.is_absolute() or path.is_symlink():
        raise ValueError('evidence paths must be absolute and not symlinks: '+str(path))
    return path.resolve()


def _hash(path):
    path = _path(path)
    if not path.is_file():
        raise ValueError('missing evidence file: '+str(path))
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('duplicate evidence JSON key: '+key)
        value[key] = item
    return value


def _read(path):
    path = _path(path)
    before = _hash(path)
    def invalid(value):
        raise ValueError('nonfinite evidence JSON: '+value)
    def finite(value):
        result = float(value)
        if not math.isfinite(result):
            invalid(value)
        return result
    try:
        value = json.loads(path.read_text(), object_pairs_hook=_unique,
                           parse_constant=invalid, parse_float=finite)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError('unreadable evidence JSON: '+str(path)) from error
    if _hash(path) != before:
        raise ValueError('evidence changed while reading: '+str(path))
    if not isinstance(value, dict):
        raise ValueError('evidence JSON must be an object')
    return value, dict(path=str(path), sha256=before)


def _check_inputs(inputs):
    if not isinstance(inputs, dict):
        raise ValueError('missing evidence input hashes')
    result = {}
    for name, expected in inputs.items():
        path = _path(name)
        if expected is None:
            if path.exists() or path.is_symlink():
                raise ValueError('absent input appeared: '+str(path))
        elif not isinstance(expected, str) or not _HEX.fullmatch(expected) or _hash(path) != expected:
            raise ValueError('evidence input changed: '+str(path))
        result[str(path)] = expected
    return result


def _merge(*maps):
    result = {}
    for mapping in maps:
        for name, value in mapping.items():
            if name in result and result[name] != value:
                raise ValueError('conflicting evidence input: '+name)
            result[name] = value
    return result


def _descriptor(value):
    if not isinstance(value, dict) or set(value) != {'path', 'sha256'}:
        raise ValueError('missing exact file descriptor')
    path = _path(value['path'])
    if not isinstance(value['sha256'], str) or not _HEX.fullmatch(value['sha256']) or _hash(path) != value['sha256']:
        raise ValueError('file descriptor is stale: '+str(path))
    return dict(path=str(path), sha256=value['sha256'])


def _forms(text):
    tokens = _tokens(text)
    depth = 0
    for token in tokens:
        if token == '(':
            depth += 1
        elif token == ')':
            depth -= 1
            if depth < 0:
                raise ValueError('malformed native rule/board parentheses')
        elif '"' in token and not re.fullmatch(r'"(?:[^"\\]|\\.)*"', token):
            raise ValueError('malformed quoted native rule/board token')
    if depth:
        raise ValueError('unterminated native rule/board form')
    return _tree(tokens)


def _policy(source, base):
    source, base = _path(source), _path(base)
    inputs = {str(source): _hash(source), str(base): _hash(base),
        str(Path(__file__).resolve()): _hash(Path(__file__).resolve()),
        str(Path(native_parser.__file__).resolve()): _hash(Path(native_parser.__file__).resolve())}
    schematic = source.with_suffix('.kicad_sch')
    if schematic.is_symlink():
        raise ValueError('captured native schematic symlinks are unsupported')
    inputs[str(schematic)] = _hash(schematic) if schematic.exists() else None
    projects, rules = [], []
    for board in (source, base):
        project = board.with_suffix('.kicad_pro')
        data, descriptor = _read(project)
        inputs[descriptor['path']] = descriptor['sha256']
        try:
            settings = data['board']['design_settings']
            count = settings['rules']['min_resolved_spokes']
            severities = settings['rule_severities']
        except (KeyError, TypeError) as error:
            raise ValueError('authored thermal project policy is incomplete') from error
        if type(count) is not int or count <= 0:
            raise ValueError('min_resolved_spokes must be an authored positive integer')
        if not isinstance(severities, dict) or severities.get('starved_thermal') != 'error':
            raise ValueError('starved_thermal must explicitly have error severity')
        if settings.get('drc_exclusions') != []:
            raise ValueError('native thermal verification requires explicit empty DRC exclusions')
        projects.append((descriptor['sha256'], count))
        dru = board.with_suffix('.kicad_dru')
        if dru.is_symlink():
            raise ValueError('native DRU symlinks are unsupported')
        digest = _hash(dru) if dru.exists() else None
        inputs[str(dru)] = digest
        rules.append(digest)
        if digest is not None:
            forms = _forms(dru.read_text())
            if not forms or forms[0] != ['version', '1']:
                raise ValueError('native DRU version is unresolved')
            for form in forms[1:]:
                if not isinstance(form, list) or len(form) < 3 or form[0] != 'rule' or not isinstance(form[1], str):
                    raise ValueError('unsupported native DRU form')
                for field in form[2:]:
                    if not isinstance(field, list) or not field or field[0] not in ('condition', 'constraint', 'layer', 'severity'):
                        raise ValueError('unknown native DRU rule field')
                    if field[0] == 'severity':
                        raise ValueError('custom rule severity is not proven by this capability')
                    if field[0] == 'constraint':
                        if len(field) < 2 or not isinstance(field[1], str):
                            raise ValueError('malformed custom constraint')
                        if 'thermal' in field[1].lower() or field[1] in ('zone_connection', 'min_resolved_spokes'):
                            raise ValueError('custom thermal/zone constraint is not proven by this capability')
    if projects[0] != projects[1] or rules[0] != rules[1]:
        raise ValueError('source/base project or DRU changed')
    return source, base, projects[0][1], inputs


def _uuid_nets(board):
    roots = _forms(board.read_text())
    if len(roots) != 1 or not isinstance(roots[0], list) or roots[0][:1] != ['kicad_pcb']:
        raise ValueError('expected one native PCB')
    def child(form, key):
        rows = [x[1:] for x in form if isinstance(x, list) and x and x[0] == key]
        if len(rows) > 1:
            raise ValueError('ambiguous native '+key)
        return rows[0] if rows else None
    net_codes = {f[1]: f[2] for f in roots[0] if isinstance(f, list) and len(f) == 3 and f[0] == 'net'}
    result = {}
    def walk(form):
        if not isinstance(form, list):
            return
        if form and form[0] in ('pad', 'segment', 'arc', 'via'):
            uid, net = child(form, 'uuid'), child(form, 'net')
            if uid:
                if len(uid) != 1 or uid[0] in result:
                    raise ValueError('ambiguous native diagnostic item UUID')
                name = net[-1] if net else ''
                if name.isdecimal():
                    name = net_codes.get(name, '')
                result[uid[0]] = name
        for item in form:
            if isinstance(item, list):
                walk(item)
    walk(roots[0])
    return result


def _command(receipt, candidate, report):
    argv = receipt.get('command')
    if not isinstance(argv, list) or len(argv) < 4 or any(not isinstance(x, str) or not x for x in argv):
        raise ValueError('native DRC command is missing')
    tool = _descriptor(receipt.get('tool'))
    if _path(argv[0]) != _path(tool['path']) or argv[1:3] != ['pcb', 'drc']:
        raise ValueError('native DRC tool or operation differs')
    flags, positions, index = {}, [], 3
    while index < len(argv):
        token = argv[index]
        if token in ('--severity-all', '--schematic-parity'):
            key, value = token, True
        elif token in ('--format', '--units', '-o', '--output'):
            if index+1 >= len(argv):
                raise ValueError('incomplete native DRC command')
            key, value = ('output' if token in ('-o', '--output') else token), argv[index+1]
            index += 1
        elif token.startswith('-'):
            raise ValueError('unsupported native DRC option (hidden refill forbidden): '+token)
        else:
            positions.append(token)
            index += 1
            continue
        if key in flags:
            raise ValueError('duplicate native DRC option: '+key)
        flags[key] = value
        index += 1
    if (flags.get('--severity-all') is not True or flags.get('--format') != 'json'
            or flags.get('--units') != 'mm' or 'output' not in flags
            or _path(flags['output']) != _path(report['path']) or len(positions) != 1
            or _path(positions[0]) != candidate):
        raise ValueError('native DRC command does not check the exact saved candidate/report')
    return tool, flags.get('--schematic-parity', False)


def _native_evidence_impl(candidate, fill_path, drc_path, selected_nets, final):
    fill, fill_file = _read(fill_path)
    drc, drc_file = _read(drc_path)
    descriptor = dict(path=str(candidate), sha256=_hash(candidate))
    if fill.get('schema') != 'iot-lab.native-thermal-fill.v1' or drc.get('schema') != 'iot-lab.native-thermal-drc.v1':
        raise ValueError('unknown native thermal receipt schema')
    if (_descriptor(fill.get('candidate')) != descriptor or _descriptor(drc.get('candidate')) != descriptor):
        raise ValueError('native receipts refer to another candidate')
    if (fill.get('fill_result') is not True or fill.get('invocation') != dict(operation='ZONE_FILLER.Fill', saved=True)
            or fill.get('pcbnew_version') != VERSION or fill.get('cause')):
        raise ValueError('native zone fill must explicitly succeed and save under KiCad '+VERSION)
    fill_tool = _descriptor(fill.get('tool'))
    if type(drc.get('returncode')) is not int or drc['returncode'] != 0 or drc.get('cause'):
        raise ValueError('independent native DRC did not succeed')
    report_file = _descriptor(drc.get('report'))
    tool, parity_requested = _command(drc, candidate, report_file)
    report, read_report = _read(report_file['path'])
    if read_report != report_file or report.get('kicad_version') != VERSION or report.get('coordinate_units') != 'mm':
        raise ValueError('native DRC runtime/report identity is unsupported')
    if report.get('source') not in (candidate.name, str(candidate)):
        raise ValueError('native DRC report names another candidate')
    included = report.get('included_severities')
    if not isinstance(included, list) or set(included) != {'error', 'warning', 'exclusion'} or len(included) != 3:
        raise ValueError('native DRC did not include all finding severities/exclusions')
    for key in ('violations', 'unconnected_items', 'schematic_parity', 'ignored_checks'):
        if not isinstance(report.get(key), list):
            raise ValueError('native DRC report is incomplete: '+key)
    for ignored in report['ignored_checks']:
        if not isinstance(ignored, dict) or not isinstance(ignored.get('key'), str):
            raise ValueError('malformed ignored native DRC check')
        if 'thermal' in ignored['key'].lower():
            raise ValueError('thermal check was ignored')
    if report['schematic_parity']:
        raise ValueError('native DRC reported schematic parity findings')
    for key in ('violations', 'unconnected_items', 'schematic_parity'):
        for finding in report[key]:
            if not isinstance(finding, dict) or not isinstance(finding.get('type'), str) or finding.get('severity') not in ('error', 'warning', 'exclusion'):
                raise ValueError('malformed native finding')
            if 'thermal' in finding['type'].lower() or finding['severity'] == 'exclusion' or finding.get('excluded'):
                raise ValueError('thermal/excluded native finding is fatal')
    if any(f['severity'] == 'error' for f in report['violations']):
        raise ValueError('native DRC reported errors')
    opens = report['unconnected_items']
    if final and opens:
        raise ValueError('final native thermal discharge requires zero opens')
    mapping = _uuid_nets(candidate)
    if not set(selected_nets).issubset(set(mapping.values())):
        raise ValueError('selected net is absent from the exact native candidate')
    open_bindings = []
    for row in opens:
        items = row.get('items')
        if row['type'] != 'unconnected_items' or not isinstance(items, list) or len(items) != 2:
            raise ValueError('unresolved initial native open')
        identifiers = [i.get('uuid') if isinstance(i, dict) else None for i in items]
        if any(not isinstance(i, str) or not i for i in identifiers):
            raise ValueError('initial open has no native item identity')
        names = [mapping.get(i) for i in identifiers]
        if len(set(identifiers)) != 2 or not names[0] or names[0] != names[1] or names[0] not in selected_nets:
            raise ValueError('initial opens are not exclusively on the selected native nets')
        open_bindings.append(dict(net=names[0], item_uuids=identifiers))
    inputs = _merge(_check_inputs(fill.get('inputs')), _check_inputs(drc.get('inputs')),
        {d['path']: d['sha256'] for d in (descriptor, fill_file, drc_file, report_file, tool, fill_tool)})
    return dict(candidate=descriptor, fill_receipt=fill_file, drc_receipt=drc_file,
        native_report=report_file, fill_tool=fill_tool, drc_tool=tool, inputs=inputs,
        metrics=dict(errors=0, thermal_findings=0, opens=len(opens),
            warnings=sum(f['severity'] == 'warning' for f in report['violations']),
            parity_findings=0, parity_checked=parity_requested), initial_open_bindings=open_bindings)


def _native_evidence(candidate, fill_path, drc_path, selected_nets, final):
    try:
        return _native_evidence_impl(candidate, fill_path, drc_path, selected_nets, final)
    except (OSError, UnicodeError, KeyError, TypeError, IndexError) as error:
        raise ValueError('malformed or unavailable native thermal evidence: '+str(error)) from error


def admit(source, base, *, enabled=False, selected_nets, initial_fill_receipt, initial_drc_receipt):
    """Validate checked initial native evidence; only thermal count stays pending."""
    if enabled is not True:
        raise ValueError('native thermal checkback requires explicit opt-in')
    if (not isinstance(selected_nets, (list, tuple, set)) or not selected_nets
            or any(not isinstance(n, str) or not n for n in selected_nets)
            or len(set(selected_nets)) != len(selected_nets)):
        raise ValueError('exact selected native nets are required')
    selected_nets = sorted(selected_nets)
    source, base, count, policy_inputs = _policy(source, base)
    evidence = _native_evidence(base, initial_fill_receipt, initial_drc_receipt, selected_nets, False)
    inputs = _merge(policy_inputs, evidence['inputs'])
    _check_inputs(inputs)
    result = dict(schema=CAPABILITY_SCHEMA, status='pending_native', enabled=True,
        enforcement='native-checkback', required_count=count, selected_nets=selected_nets,
        source=dict(path=str(source), sha256=inputs[str(source)]), base=evidence['candidate'],
        initial=evidence, inputs=inputs, qualified=False, dsn_covered=False,
        scope='project minimum resolved spokes only; final native discharge and full configured gate required')
    result['content_sha256'] = _identity(result)
    return result


def validate_capability(capability, source, base, *, selected_nets, required_count=None):
    """Reopen all initial evidence, not merely a caller-supplied status field."""
    if isinstance(capability, (str, Path)):
        capability, _ = _read(capability)
    if not isinstance(capability, dict) or capability.get('schema') != CAPABILITY_SCHEMA:
        raise ValueError('native thermal capability is missing or unsupported')
    original = dict(capability)
    seal = original.pop('content_sha256', None)
    if seal != _identity(original):
        raise ValueError('native thermal capability content changed')
    try:
        captured = _descriptor(capability['source'])
        captured_path, caller_path = _path(captured['path']), _path(source)
        if _hash(caller_path) != captured['sha256']:
            raise ValueError('caller source differs from immutable thermal source capture')
        for suffix in ('.kicad_pro', '.kicad_dru', '.kicad_sch'):
            old, new = captured_path.with_suffix(suffix), caller_path.with_suffix(suffix)
            if old.is_symlink() or new.is_symlink():
                raise ValueError('native source alias has unsupported sidecar symlink')
            old_hash = _hash(old) if old.exists() else None
            new_hash = _hash(new) if new.exists() else None
            if old_hash != new_hash:
                raise ValueError('caller native source sidecars differ from immutable capture')
        actual = admit(captured_path, base, enabled=capability.get('enabled'), selected_nets=selected_nets,
            initial_fill_receipt=capability['initial']['fill_receipt']['path'],
            initial_drc_receipt=capability['initial']['drc_receipt']['path'])
    except (KeyError, TypeError) as error:
        raise ValueError('native thermal capability is incomplete') from error
    if actual != capability:
        raise ValueError('native thermal capability source, scope or evidence changed')
    if required_count is not None and (isinstance(required_count, bool) or required_count != actual['required_count']):
        raise ValueError('native thermal capability does not cover the authored count')
    return actual


def discharge(capability, candidate, *, fill_receipt, drc_receipt):
    """Discharge this one postcondition; no claim of configured-gate acceptance."""
    if isinstance(capability, (str, Path)):
        capability, _ = _read(capability)
    if not isinstance(capability, dict):
        raise ValueError('native thermal capability is missing')
    try:
        initial = validate_capability(capability, capability['source']['path'], capability['base']['path'],
                                      selected_nets=capability['selected_nets'])
    except (KeyError, TypeError) as error:
        raise ValueError('native thermal capability is incomplete') from error
    candidate = _path(candidate)
    _, _, count, final_inputs = _policy(initial['source']['path'], candidate)
    if count != initial['required_count']:
        raise ValueError('final native thermal minimum changed')
    evidence = _native_evidence(candidate, fill_receipt, drc_receipt, initial['selected_nets'], True)
    if any(evidence[key] != initial['initial'][key] for key in ('fill_tool', 'drc_tool')):
        raise ValueError('initial/final native thermal runtime tools changed')
    inputs = _merge(initial['inputs'], final_inputs, evidence['inputs'])
    _check_inputs(inputs)
    result = dict(schema=DISCHARGE_SCHEMA, status='passed', enforcement='native-checkback',
        required_count=count, initial_capability_sha256=initial['content_sha256'],
        candidate=evidence['candidate'], final=evidence, inputs=inputs,
        qualified=False, dsn_covered=False, configured_gate_required=True,
        scope='native project thermal minimum discharged only; protected inputs and full configured gate still required')
    result['content_sha256'] = _identity(result)
    return result
