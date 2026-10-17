"""Source-bound block qualification. CAD and declared facts are never promoted.

Native identities establish reuse; gate receipts establish checks; attributed
reviews establish applicability. A bench receipt additionally needs raw measured
data against an approved, sourced test plan. No level transfers to another target.
"""
import csv
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from urllib.parse import urlparse

import block_reuse
import lean_owned
import lean_workflow as lean
from pcb_search.block_bindings import bind_instance, child, footprints, verify_binding
from pcb_search.contracts import fingerprint
from placer.dru import _tree, _tokens

SCHEMA = 'iot-lab.block-qualification.v1'


def read(path):
    value = json.loads(Path(path).read_text())
    if not isinstance(value, dict):
        raise ValueError(f'{path}: expected a JSON object')
    return value


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def stamp():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def enabled(value):
    # Gate configuration follows JavaScript truthiness: {} enables a checker.
    return value is not None and value is not False and value != '' and value != 0


def inventory(root, library, board):
    """Match native hierarchical symbol UUID sets, never names or part values."""
    root, library = Path(root).resolve(), Path(library).resolve()
    if not board or any(c not in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-' for c in board):
        raise ValueError('expected configured board ID')
    config = root / 'hardware-design/boards' / board / 'gate.json'
    cfg = read(config)
    target = (config.parent / cfg['project']).with_suffix('.kicad_pcb').resolve()
    target_parts = footprints(target)
    schematic = target.with_suffix('.kicad_sch')
    forms = _tree(_tokens(schematic.read_text()))
    if len(forms) != 1 or forms[0][0] != 'kicad_sch':
        raise ValueError('expected native schematic')
    sheets = {}
    for form in forms[0][1:]:
        if not isinstance(form, list) or not form or form[0] != 'sheet':
            continue
        uid = child(form, 'uuid', [''])[0]
        props = {p[1]: p[2] for p in form if isinstance(p, list) and p and p[0] == 'property'}
        filename = props.get('Sheetfile', props.get('Sheet file'))
        if uid and filename:
            sheet = (schematic.parent / filename).resolve()
            sheets['/' + uid] = dict(sheet_file=filename, sheet_name=props.get('Sheetname'),
                                    sheet_path=str(sheet), sheet_sha256=sha(sheet))
    instances = {}
    for fp in target_parts:
        instance = fp['path'].rsplit('/', 1)[0]
        if instance:
            instances.setdefault(instance, set()).add(fp['path'].rsplit('/', 1)[-1])
    candidates = []
    for directory in sorted(library.glob('*.kicad_block')):
        source = directory / (directory.name.removesuffix('.kicad_block') + '.kicad_pcb')
        if source.is_file():
            parts = footprints(source)
            ids = [fp['path'].rsplit('/', 1)[-1] for fp in parts]
            if ids and all(ids) and len(set(ids)) == len(ids):
                candidates.append((directory, set(ids)))
    rows = []
    for instance, ids in sorted(instances.items()):
        matched = [directory for directory, source_ids in candidates if source_ids == ids]
        row = dict(instance_path=instance, symbol_uuids=sorted(ids), status='unidentified', level=0)
        row.update(sheets.get(instance, {}))
        if row.get('sheet_file'):
            # This is an explicit native sheet reference, not a part/name
            # similarity match. A matching filename alone grants no binding.
            named = library / (Path(row['sheet_file']).stem + '.kicad_block')
            if named.is_dir():
                row['referenced_block_id'] = named.name.removesuffix('.kicad_block')
                row['binding_failure'] = 'native symbol identities differ from the current library revision'
        if len(matched) == 1:
            directory = matched[0]
            row.update(block_id=directory.name.removesuffix('.kicad_block'), status='native_identity')
            try:
                row['binding'] = bind_instance(directory, target, instance)
                row['status'] = 'bound_draft'
                row.pop('binding_failure', None)
            except (ValueError, OSError) as error:
                row['binding_failure'] = str(error)
        elif len(matched) > 1:
            row.update(status='ambiguous', candidates=[p.name for p in matched])
        rows.append(row)
    return dict(schema='iot-lab.block-inventory.v1', board=board, project=cfg['project'],
                target=str(target), target_sha256=sha(target), config_sha256=sha(config),
                instances=rows, authoritative_instances=sum('block_id' in r for r in rows),
                cause=('native hierarchical symbol identities inspected' if rows else
                       'no authoritative block instances: native board paths are flat'),
                qualification='draft; inventory grants no qualification')


def native_metrics(directory):
    """Same error/parity/unconnected acceptance policy as gate-core.mjs."""
    erc, drc = read(directory / 'erc.json'), read(directory / 'drc.json')
    sheets = erc.get('sheets')
    if not isinstance(sheets, list) or not sheets:
        raise ValueError('native ERC report has no sheets')
    groups = [s.get('violations') for s in sheets] + [drc.get('violations'),
              drc.get('schematic_parity'), drc.get('unconnected_items')]
    if any(not isinstance(v, list) for v in groups):
        raise ValueError('incomplete native reports')
    violations = [v for group in groups[:-2] for v in group]
    if any(not isinstance(v, dict) or v.get('severity') not in {'error', 'warning', 'info', 'exclusion'}
           for v in violations):
        raise ValueError('malformed native violation')
    return dict(erc_errors=sum(v['severity'] == 'error' for s in sheets for v in s['violations']),
                drc_errors=sum(v['severity'] == 'error' for v in drc['violations']),
                drc_parity=len(drc['schematic_parity']), drc_unconnected=len(drc['unconnected_items']))


def native(directory, output, timeout=600):
    """Generate fresh standalone ERC/DRC evidence with an owned process family."""
    directory, output = Path(directory).resolve(), Path(output).resolve()
    if output.is_relative_to(directory):
        raise ValueError('native evidence must live outside the block source')
    row = block_reuse.read_block(directory)
    if row['missing_files'] or row['facts_errors']:
        raise ValueError('complete block CAD and valid facts required')
    binary = shutil.which(os.environ.get('KICAD_CLI', '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'))
    if not binary:
        raise ValueError('KiCad CLI unavailable; set KICAD_CLI')
    binary = str(Path(binary).resolve())
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError('native timeout must be finite and positive')
    output.mkdir(parents=True, exist_ok=False)
    deadline = lean.deadline_after(timeout, {})
    report = dict(schema='iot-lab.block-native.v1', block_id=row['id'], source_sha256=row['source_sha256'],
                  source_directory=str(directory), started_at=stamp(), executable=str(Path(binary).resolve()),
                  executable_sha256=sha(binary), status='error', checks={})
    try:
        report['tool_version'] = subprocess.check_output([binary, '--version'], text=True,
                                                       timeout=min(10, lean.remaining(deadline))).strip()
        if not report['tool_version']:
            raise ValueError('native tool version unavailable')
        for name, args in [('erc', ['sch', 'erc', '--format', 'json', '--severity-all', '--units', 'mm']),
                           ('drc', ['pcb', 'drc', '--schematic-parity', '--refill-zones', '--format', 'json', '--severity-all', '--units', 'mm'])]:
            source = directory / (row['id'] + ('.kicad_sch' if name == 'erc' else '.kicad_pcb'))
            command = [binary, *args, '-o', str(output / (name + '.json')), str(source)]
            print(f'START: block {name}; progress unknown', file=sys.stderr, flush=True)
            proc, cleanup = None, None
            check = dict(command=command)
            report['checks'][name] = check
            try:
                with (output / (name + '.log')).open('wb') as log:
                    proc = lean_owned.prepare(command, dict(cwd=directory, env=dict(os.environ),
                                              stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT))
                    proc.start()
                    proc.activate()
                    heartbeat = time.monotonic()
                    while True:
                        if lean.remaining(deadline) <= 0:
                            raise TimeoutError('block native deadline reached')
                        try:
                            proc.communicate(timeout=min(.1, lean.remaining(deadline)))
                            cleanup = proc.last_cleanup
                            break
                        except subprocess.TimeoutExpired:
                            if time.monotonic() - heartbeat >= 5:
                                print(f'ALIVE: block {name}; progress unknown', file=sys.stderr, flush=True)
                                heartbeat = time.monotonic()
            finally:
                if proc:
                    cleanup = cleanup if cleanup is not None else proc.cleanup()
                    settled = proc.close()
                    check.update(exit_code=proc.returncode, cleanup=cleanup)
                    if not settled or not cleanup.get('complete'):
                        raise ValueError('native owned process cleanup unconfirmed')
            check.update(report_sha256=sha(output / (name + '.json')),
                         log_sha256=sha(output / (name + '.log')))
            if proc.returncode != 0:
                raise ValueError(f'native {name} did not complete successfully')
            print(f'PASS: block {name} invocation completed', file=sys.stderr, flush=True)
        report['metrics'] = native_metrics(output)
        if any(report['metrics'].values()):
            raise ValueError('source native ERC/DRC/parity targets not met')
        if block_reuse.read_block(directory)['source_sha256'] != row['source_sha256']:
            raise ValueError('block source changed during native checks')
        report['status'] = 'passed'
        report['cause'] = 'standalone native ERC/DRC/parity targets met'
    except (ValueError, OSError, RuntimeError, subprocess.SubprocessError) as error:
        report['cause'] = str(error)
    finally:
        report['finished_at'] = stamp()
        lean.atomic_json(output / 'result.json', report)
    return report


class Evidence:
    def __init__(self):
        self.files = {}

    def file(self, path):
        path = Path(path).resolve()
        digest = sha(path)
        old = self.files.setdefault(str(path), digest)
        if old != digest:
            raise ValueError('evidence changed during qualification: ' + str(path))
        return path

    def artifact(self, spec, base):
        if not isinstance(spec, dict) or not spec.get('path') or not spec.get('sha256'):
            raise ValueError('evidence artifact requires path and sha256')
        path = self.file(Path(base) / spec['path'])
        if sha(path) != spec['sha256']:
            raise ValueError('stale evidence artifact: ' + str(path))
        return path

    def absent(self, path):
        path = str(Path(path).absolute())
        if Path(path).exists() or path in self.files and self.files[path] is not None:
            raise ValueError('previously absent evidence input appeared: ' + path)
        self.files[path] = None

    def document(self, spec, base):
        if not isinstance(spec, dict) or not spec.get('locator'):
            raise ValueError('sourced evidence requires a page/section/record locator')
        return self.artifact(spec, base)


def require_review(value, evidence, base):
    if not isinstance(value, dict) or value.get('verdict') != 'pass' or not value.get('reviewer') or not value.get('reviewed_at'):
        raise ValueError('applicability review needs pass verdict, reviewer and reviewed_at')
    timestamp(value['reviewed_at'])
    evidence.document(value.get('evidence'), base)


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError('evidence requires an attributable ISO timestamp with timezone')
    parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('evidence timestamp must include its timezone')
    return parsed


def verify_native(path, row, evidence):
    path = evidence.file(path)
    native_result = read(path)
    if (native_result.get('schema') != 'iot-lab.block-native.v1' or native_result.get('status') != 'passed'
            or native_result.get('block_id') != row['id']
            or native_result.get('source_sha256') != row['source_sha256']
            or Path(native_result.get('source_directory', '')).resolve() != Path(row['source_directory'])):
        raise ValueError('stale or unsuccessful source native evidence')
    binary = evidence.file(native_result['executable'])
    if sha(binary) != native_result['executable_sha256'] or not native_result.get('tool_version'):
        raise ValueError('native executable changed or version unavailable')
    if timestamp(native_result.get('finished_at')) < timestamp(native_result.get('started_at')):
        raise ValueError('source native timestamps disagree')
    for name in ('erc', 'drc'):
        check = native_result.get('checks', {}).get(name, {})
        if check.get('exit_code') != 0 or check.get('cleanup', {}).get('complete') is not True:
            raise ValueError('source native invocation incomplete: ' + name)
        command = check.get('command', [])
        source = Path(row['source_directory']) / (row['id'] + ('.kicad_sch' if name == 'erc' else '.kicad_pcb'))
        expected = ([str(binary), 'sch', 'erc', '--format', 'json', '--severity-all', '--units', 'mm'] if name == 'erc' else
                    [str(binary), 'pcb', 'drc', '--schematic-parity', '--refill-zones', '--format', 'json', '--severity-all', '--units', 'mm'])
        expected += ['-o', str(path.parent / (name + '.json')), str(source)]
        if command != expected:
            raise ValueError('unsupported source native invocation: ' + name)
        for extension, key in (('json', 'report_sha256'), ('log', 'log_sha256')):
            artifact = evidence.file(path.parent / (name + '.' + extension))
            if sha(artifact) != check.get(key):
                raise ValueError('source native artifact changed: ' + name)
    metrics = native_metrics(path.parent)
    if metrics != native_result.get('metrics') or any(metrics.values()):
        raise ValueError('source native report targets not met')
    return native_result


def verify_gate(run_directory, binding, root, external_roots, evidence):
    run = Path(run_directory).resolve()
    manifest, result = read(evidence.file(run / 'run.json')), read(evidence.file(run / 'result.json'))
    if (result.get('status') != 'passed' or result.get('exit_code') != 0
            or result.get('scope') != 'configured_board_gate' or result.get('cleanup', {}).get('complete') is not True):
        raise ValueError('target gate did not pass with confirmed cleanup')
    board = manifest.get('board', '')
    if not board or '/' in board or '\\' in board or board in {'.', '..'}:
        raise ValueError('invalid target gate board')
    config = Path(root) / 'hardware-design/boards' / board / 'gate.json'
    cfg = read(evidence.file(config))
    target = (config.parent / cfg['project']).with_suffix('.kicad_pcb').resolve()
    required = {'erc', 'drc', 'paths', 'viapads', 'kicad_happy', 'port_labels'}
    if not required.issubset(k for k, v in cfg.get('checks', {}).items() if enabled(v)):
        raise ValueError('target gate omits required native/electrical checks')
    if target != Path(binding['target']).resolve() or manifest.get('root') != str(Path(root).resolve()):
        raise ValueError('gate is for a different target board/repository')
    command = manifest.get('command', [])[1:]
    if not command or command.pop(0) != str(Path(root) / 'tools/gate.mjs'):
        raise ValueError('unsupported gate mode; fresh target checks required')
    seen = set()
    while command:
        token = command.pop(0)
        if token in seen:
            raise ValueError('ambiguous duplicate gate command argument')
        seen.add(token)
        if token == '--evidence-dir':
            if not command or Path(command.pop(0)).resolve() != run / 'gate':
                raise ValueError('gate evidence destination does not match this run')
        elif token == '--findings-baseline':
            if not command:
                raise ValueError('gate findings baseline path missing')
            evidence.file(command.pop(0))
        elif token not in (board, '--fresh'):
            raise ValueError('unsupported gate mode; fresh target checks required')
    if not {board, '--evidence-dir'}.issubset(seen):
        raise ValueError('gate command does not name the exact board and evidence directory')
    raw = read(evidence.file(run / 'gate/result.json'))
    provenance = raw.get('provenance', {})
    metrics = raw.get('metrics', {})
    cache = raw.get('cache', {})
    if cache.get('enabled') or cache.get('hits', 0) or any(check.get('cached') for check in raw.get('checks', {}).values()):
        raise ValueError('fresh native target evidence required; cached checks cannot promote a block')
    if (raw.get('exit') != 0 or raw.get('changedDuringRun') is not False
            or result.get('input_sha256') != provenance.get('input_sha256')
            or result.get('metrics') != metrics
            or not isinstance(metrics, dict) or not metrics
            or any(type(v) is not int or v < 0 or (v != 0 and not k.endswith('_warnings')) for k, v in metrics.items())
            or not {'erc_errors', 'drc_errors', 'drc_parity', 'drc_unconnected'}.issubset(metrics)
            or not provenance.get('tools') or any(not v for v in provenance['tools'].values())):
        raise ValueError('target native/electrical result is incomplete or not at target')
    if hashlib.sha256(json.dumps(dict(inputs=provenance.get('inputs'), tools=provenance.get('tools')),
                                    ensure_ascii=False, separators=(',', ':')).encode()).hexdigest() != provenance['input_sha256']:
        raise ValueError('target gate provenance fingerprint disagrees')
    event_path = evidence.file(run / 'gate/events.jsonl')
    events = [json.loads(line) for line in event_path.read_text().splitlines()]
    completed = [event for event in events if event.get('type') == 'check.end']
    enabled_checks = {key for key, value in cfg['checks'].items() if enabled(value)}
    combined = {key: value for event in completed for key, value in event.get('metrics', {}).items()}
    if ({event.get('stage') for event in completed} != enabled_checks or len(completed) != len(enabled_checks)
            or any(event.get('status') != 'passed' for event in completed) or combined != metrics
            or not events or events[-1].get('type') != 'gate.end' or events[-1].get('exit') != 0):
        raise ValueError('target gate lacks complete successful configured check events')
    recorded = set()
    for entry in provenance.get('inputs', []):
        name = entry['path']
        if name.startswith('external/'):
            pieces = name.split('/', 2)
            if len(pieces) != 3 or pieces[1] not in external_roots:
                raise ValueError('external gate input root required: ' + name)
            base, relative = Path(external_roots[pieces[1]]).resolve(), pieces[2]
        else:
            base, relative = Path(root).resolve(), name
        path = (base / relative).resolve()
        if not path.is_relative_to(base):
            raise ValueError('gate provenance path escapes its root')
        recorded.add(str(path))
        if entry.get('sha256') is None:
            evidence.absent(path)
        elif sha(evidence.file(path)) != entry['sha256']:
            raise ValueError('stale gate input changed: ' + name)
    mandatory = {str(config.resolve())} | {str(target.with_suffix(ext)) for ext in
                 ('.kicad_pcb', '.kicad_sch', '.kicad_pro', '.kicad_dru')}
    if not mandatory.issubset(recorded):
        raise ValueError('gate provenance omits required exact target inputs')
    evidence.file(run / 'gate/erc.json')
    evidence.file(run / 'gate/drc.json')
    if any(native_metrics(run / 'gate').values()):
        raise ValueError('target native artifacts are not at target')
    return dict(board=board, project=cfg['project'], input_sha256=provenance['input_sha256'])


def verify_bench(path, proof, binding_sha256, evidence, base):
    plan = read(evidence.artifact(proof.get('bench_plan'), base))
    measured = read(evidence.file(path))
    if (plan.get('schema') != 'iot-lab.block-bench-plan.v1' or not plan.get('approved_by')
            or not plan.get('approved_at') or plan.get('binding_sha256') != binding_sha256
            or measured.get('schema') != 'iot-lab.block-bench.v1'
            or measured.get('binding_sha256') != binding_sha256
            or not all(measured.get(k) for k in ('operator', 'measured_at', 'board_serial', 'instruments'))):
        raise ValueError('bench evidence requires approved exact-binding plan and attributable measured hardware')
    if timestamp(measured['measured_at']) < timestamp(plan['approved_at']):
        raise ValueError('bench plan approval must precede measurement')
    instruments = {r['id']: r for r in measured['instruments']}
    if len(instruments) != len(measured['instruments']):
        raise ValueError('bench instrument identities must be unique')
    for instrument in instruments.values():
        evidence.document(instrument.get('calibration_evidence'), Path(path).parent)
    raw = evidence.artifact(measured.get('raw_data'), Path(path).parent)
    with raw.open(newline='') as stream:
        rows = list(csv.DictReader(stream))
    tests = plan.get('tests', [])
    if not tests or len({t['id'] for t in tests}) != len(tests):
        raise ValueError('bench plan requires distinct sourced tests')
    if len(rows) != len(tests) or len({r.get('test_id') for r in rows}) != len(rows):
        raise ValueError('raw bench data must cover every approved test exactly once')
    values = {r['test_id']: r for r in rows}
    for test in tests:
        if not test.get('requirement') or not test.get('unit'):
            raise ValueError('bench tests require a named requirement and measurement unit')
        evidence.document(test.get('source'), base)
        row = values.get(test['id'], {})
        low, high, measured_value = test.get('min'), test.get('max'), float(row.get('value', 'nan'))
        if (type(low) not in (float, int) or type(high) not in (float, int)
                or not all(math.isfinite(v) for v in (low, high, measured_value)) or low > high
                or not low <= measured_value <= high or row.get('unit') != test.get('unit')
                or row.get('instrument_id') not in instruments):
            raise ValueError('bench measurement missing, unsupported or outside sourced limits: ' + test['id'])
    return dict(board_serial=measured['board_serial'], operator=measured['operator'],
                measured_at=measured['measured_at'], tests=[t['id'] for t in tests])


def qualify(library, iid, binding_file, evidence_file, root, bench=None):
    evidence = Evidence()
    binding = read(evidence.file(binding_file))
    verify_binding(binding)
    row = block_reuse.reuse(library, iid, binding['source_sha256'])
    if binding.get('block_id') != iid or binding.get('source_directory') != row['source_directory']:
        raise ValueError('binding refers to a different block')
    if row['missing_files'] or row['facts_errors']:
        raise ValueError('complete block files and valid facts required')
    proof_path = evidence.file(evidence_file)
    proof, base = read(proof_path), proof_path.parent
    binding_hash = fingerprint(binding)
    if proof.get('schema') != 'iot-lab.block-evidence.v1' or proof.get('binding_sha256') != binding_hash:
        raise ValueError('evidence must name the exact native binding fingerprint')
    if proof.get('unsupported'):
        raise ValueError('unsupported applicability requirements remain unresolved')
    verify_native(base / proof['source_native'], row, evidence)
    gate = verify_gate(base / proof['target_run'], binding, root, proof.get('external_roots', {}), evidence)
    reviews = proof.get('reviews', {})
    ports, rules = row['ports'], row['layout_rules']
    port_reviews = reviews.get('operating_limits', {})
    if not ports or set(port_reviews) != {p['name'] for p in ports}:
        raise ValueError('operating-limit review must cover every exact block port')
    for port in ports:
        review = port_reviews[port['name']]
        if not port.get('limits') or not port.get('net') or port['net'] not in binding['net_map'] or not review.get('target_conditions'):
            raise ValueError('port needs native net mapping, limits and explicit target operating conditions')
        require_review(review, evidence, base)
    rule_reviews = reviews.get('layout_rules', {})
    if not rules or set(rule_reviews) != {str(i) for i in range(len(rules))}:
        raise ValueError('layout review must cover every source rule by zero-based index')
    for review in rule_reviews.values():
        require_review(review, evidence, base)
    for context in ('stackup_and_rules', 'boundary_and_returns', 'ground_and_isolation'):
        require_review(reviews.get(context), evidence, base)
    unresolved = reviews.get('open_items', {})
    if set(unresolved) != set(row['open_items']):
        raise ValueError('all declared block open items require attributed resolution')
    for review in unresolved.values():
        require_review(review, evidence, base)
    native_parts = footprints(Path(row['source_directory']) / (iid + '.kicad_pcb'))
    parts = proof.get('parts', {})
    if set(parts) != set(binding['refs']):
        raise ValueError('part evidence must cover every native bound source reference')
    for fp in native_parts:
        ref, properties = fp['props']['Reference'], fp['props']
        part = parts[ref]
        if any(part.get(k.lower()) != properties.get(k) for k in ('MPN', 'LCSC')):
            raise ValueError('part evidence identity differs: ' + ref)
        ds = evidence.artifact(part.get('datasheet'), base)
        source = read(evidence.file(str(ds) + '.source.json'))
        if source.get('sha256') != sha(ds) or not source.get('source_url') or not source.get('fetched_at_utc'):
            raise ValueError('manufacturer datasheet provenance missing or stale: ' + ref)
        availability = read(evidence.artifact(part.get('jlc_assembly'), base))
        record = availability.get('record', availability.get('purchase_record', {}))
        stock = record.get('stockCount', record.get('overseasStockCount'))
        if (urlparse(availability.get('source_url', '')).hostname not in {'jlcpcb.com', 'www.jlcpcb.com'}
                or not availability.get('fetched_at_utc') or record.get('componentCode') != part['lcsc']
                or record.get('componentModelEn') != part['mpn'] or type(stock) is not int or stock <= 0):
            raise ValueError('exact dated JLC assembly availability required: ' + ref)
        require_review(part.get('pinout_and_land_pattern'), evidence, base)
    receipt = dict(schema=SCHEMA, created_at=stamp(), level=1, qualification='gate_verified',
                   block_id=iid, binding=binding, gate=gate, operating_limits=ports, layout_rules=rules,
                   stock_note='dated catalog evidence; not reserved; recheck at review/layout/order gates',
                   scope='exact block revision and native target instance; copper reuse not approved')
    if bench is not None:
        receipt['bench'] = verify_bench(Path(bench).resolve(), proof, binding_hash, evidence, base)
        receipt.update(level=2, qualification='bench_validated')
    verify_binding(binding)
    evidence.file(Path(__file__))
    evidence.file(Path(block_reuse.__file__))
    for module in ('blocks', 'pcb_search.block_bindings', 'pcb_search.contracts', 'pcb_search.native_srj', 'placer.dru'):
        evidence.file(Path(sys.modules[module].__file__))
    for path, digest in evidence.files.items():
        if (Path(path).exists() if digest is None else sha(path) != digest):
            raise ValueError('evidence changed during qualification: ' + path)
    receipt['evidence_inputs'] = evidence.files
    receipt['receipt_sha256'] = fingerprint(receipt)
    return receipt


def status(path):
    receipt = read(path)
    try:
        stored = dict(receipt)
        digest = stored.pop('receipt_sha256', None)
        if receipt.get('schema') != SCHEMA or fingerprint(stored) != digest:
            raise ValueError('unsupported or modified qualification receipt')
        if (receipt.get('level'), receipt.get('qualification')) not in {(1, 'gate_verified'), (2, 'bench_validated')}:
            raise ValueError('unsupported qualification level')
        verify_binding(receipt['binding'])
        for path, expected in receipt['evidence_inputs'].items():
            if (Path(path).exists() if expected is None else sha(path) != expected):
                raise ValueError('qualification evidence changed: ' + path)
        return dict(status='current', level=receipt['level'], qualification=receipt['qualification'],
                    block_id=receipt['block_id'], scope=receipt['scope'], receipt_sha256=digest)
    except (ValueError, OSError, KeyError) as error:
        return dict(status='stale', level=0, qualification='draft', recorded_level=receipt.get('level'), cause=str(error))
