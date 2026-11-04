#!/usr/bin/env python3
"""Content-addressed PDF inspection and source-bound reviewed native part use.

Inspection never selects a part. A verified review establishes only its explicit
engineering facts; stock, ERC/DRC, assembly, release and qualification are separate.
"""
import argparse
import contextlib
import copy
import datetime as dt
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

import part_native

SCHEMA = 'iot-lab.part-evidence.v1'
MANIFEST = 'iot-lab.part-use.v1'
PROFILE = 'iot-lab.part-profile.v1'
ROOT = Path(__file__).resolve().parent.parent
import project_root  # noqa: E402  (project root: --root/IOT_LAB/cwd; tools/project_root.py)
KINDS = {'fixed', 'rigid_group', 'pin_distance', 'clearance', 'connector_access', 'escape'}


def sha(path):
    return part_native.digest(Path(path).read_bytes())


def facts_digest(manifest):
    return part_native.digest(part_native.encoded({k: v for k, v in manifest.items() if k != 'review'}))


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(value, output, sort_keys=True, indent=2, allow_nan=False)
            output.write('\n')
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def tool(name, override=None):
    bundled = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/poppler/bin' / name
    candidate = override or os.environ.get(name.upper()) or (str(bundled) if bundled.is_file() else shutil.which(name))
    if not candidate:
        raise RuntimeError(name + ' is required; configure ' + name.upper() + ' or install Poppler')
    path = Path(candidate).resolve()
    result = subprocess.run([str(path), '-v'], text=True, capture_output=True, timeout=10)
    if result.returncode:
        raise RuntimeError(name + ' version probe failed: ' + result.stderr[-500:])
    return {'path': str(path), 'sha256': sha(path), 'version': (result.stdout + result.stderr).strip()}


def pdf_pages(path, info=None, *, tool_inputs=None):
    info = info or tool('pdfinfo')
    result = subprocess.run([info['path'], str(path)], text=True, capture_output=True,
                            env=dict(os.environ, LC_ALL='C'), timeout=30)
    match = re.search(r'^Pages:\s*([1-9][0-9]*)\s*$', result.stdout, re.M)
    if result.returncode or not match:
        raise ValueError('cannot read actual PDF page count: ' + result.stderr[-500:])
    if sha(info['path']) != info['sha256']:
        raise ValueError('pdfinfo changed during page inspection')
    if tool_inputs is not None:
        previous = tool_inputs.setdefault(info['path'], info['sha256'])
        if previous != info['sha256']:
            raise ValueError('pdfinfo changed during verification')
    return int(match[1])


def cache_files(directory):
    files = {}
    for path in sorted(directory.rglob('*')):
        if path.is_symlink():
            raise ValueError('PDF cache contains a symlink')
        if path.is_file() and path.name not in ('receipt.json', 'receipt.sha256'):
            files[path.relative_to(directory).as_posix()] = sha(path)
    return files


def read_cache(directory, key, options, scope='pdf_inspection'):
    try:
        if directory.is_symlink():
            return None
        raw = (directory / 'receipt.json').read_bytes()
        if part_native.digest(raw) != (directory / 'receipt.sha256').read_text().strip():
            return None
        receipt = json.loads(raw)
        count = receipt['page_count']
        if isinstance(count,bool) or not isinstance(count,int) or count<1:
            return None
        identity = {name:receipt[name] for name in ('schema','pdf_sha256','tools','options')}
        if part_native.digest(part_native.encoded(identity)) != key:
            return None
        expected = {'pages/%04d.txt' % i for i in range(1, count + 1)}
        expected.update('renders/%04d.png' % i for i in options.get('render_pages', []))
        if (receipt['key'] != key or receipt['scope'] != scope or receipt['reviewed'] is not False
                or set(receipt['artifacts']) != expected or cache_files(directory) != receipt['artifacts']):
            return None
        return receipt
    except (OSError, ValueError, KeyError, TypeError):
        return None


def publish_pdf_cache(staging, destination, identity, key, scope, count):
    receipt = {**identity, 'key': key, 'scope': scope, 'page_count': count,
               'reviewed': False, 'artifacts': cache_files(staging)}
    raw = part_native.encoded(receipt) + b'\n'
    (staging / 'receipt.json').write_bytes(raw)
    (staging / 'receipt.sha256').write_text(part_native.digest(raw) + '\n')
    staging.chmod(0o755)
    if destination.is_symlink():
        raise ValueError('refusing symlink PDF cache entry')
    if destination.exists():
        shutil.rmtree(destination)
    os.replace(staging, destination)
    return receipt


def copy_pdf_text(source, staging, receipt):
    """Keep independently mutable entries; accept only the validated page bytes."""
    (staging / 'pages').mkdir()
    for number in range(1, receipt['page_count'] + 1):
        name = 'pages/%04d.txt' % number
        target = staging / name
        shutil.copyfile(source / name, target)
        if sha(target) != receipt['artifacts'][name]:
            raise ValueError('PDF text cache changed during reuse')


def inspect_pdf(pdf, cache, render_pages=(), dpi=144, extractors=None):
    pdf, cache = Path(pdf).resolve(), Path(cache).resolve()
    original_hash = sha(pdf)
    if b'%PDF-' not in pdf.read_bytes()[:1024]:
        raise ValueError('input is not a PDF')
    if isinstance(dpi, bool) or not isinstance(dpi, int) or dpi <= 0:
        raise ValueError('render DPI must be a positive integer')
    pages = sorted(set(render_pages))
    if any(isinstance(p, bool) or not isinstance(p, int) or p < 1 for p in pages):
        raise ValueError('render pages are one-based positive integers')
    overrides = extractors or {}
    tools = {name: tool(name, overrides.get(name)) for name in ('pdftotext', 'pdfinfo')}
    if pages:
        tools['pdftoppm'] = tool('pdftoppm', overrides.get('pdftoppm'))
    options = {'text': ['-layout', '-enc', 'UTF-8'], 'render_pages': pages, 'dpi': dpi}
    identity = {'schema': 1, 'pdf_sha256': original_hash, 'tools': tools, 'options': options}
    key = part_native.digest(part_native.encoded(identity))
    text_options = {'text': options['text']}
    text_identity = {'schema': 1, 'pdf_sha256': original_hash,
                     'tools': {name: tools[name] for name in ('pdftotext', 'pdfinfo')}, 'options': text_options}
    text_key = part_native.digest(part_native.encoded(text_identity))
    cache.mkdir(parents=True, exist_ok=True)
    text_cache = cache / 'text'
    if text_cache.is_symlink():
        raise ValueError('refusing symlink PDF text cache')
    text_cache.mkdir(exist_ok=True)
    text_directory = text_cache / text_key
    destination = cache / key
    with (cache / (key + '.lock')).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        receipt = read_cache(destination, key, options)
        hit = receipt is not None
        # Render pages, DPI and pdftoppm do not change text extraction. Keep its
        # exact PDF/tool/options identity separately, while retaining existing
        # full inspection keys and receipts for callers and older cache entries.
        with (text_cache / (text_key + '.lock')).open('a') as text_lock:
            fcntl.flock(text_lock, fcntl.LOCK_EX)
            text_receipt = read_cache(text_directory, text_key, text_options, 'pdf_text_extraction')
            text_hit = text_receipt is not None or hit
            if text_receipt is None:
                staging = Path(tempfile.mkdtemp(prefix='.pdf-', dir=text_cache))
                try:
                    if receipt is not None:
                        count = receipt['page_count']
                        copy_pdf_text(destination, staging, receipt)
                    else:
                        print('START: PDF extraction ' + text_key, file=sys.stderr, flush=True)
                        count = pdf_pages(pdf, tools['pdfinfo'])
                        if any(p > count for p in pages):
                            raise ValueError('render page is outside actual PDF')
                        result = subprocess.run([tools['pdftotext']['path'], *text_options['text'], str(pdf), '-'],
                                                capture_output=True, timeout=120)
                        if result.returncode:
                            raise RuntimeError('PDF extraction failed: ' + result.stderr.decode(errors='replace')[-1000:])
                        text = result.stdout.decode('utf-8', errors='strict').split('\f')
                        if text and not text[-1].strip():
                            text.pop()
                        if len(text) != count:
                            raise ValueError('extracted page boundaries differ from actual PDF page count')
                        (staging / 'pages').mkdir()
                        for number, content in enumerate(text, 1):
                            (staging / 'pages' / ('%04d.txt' % number)).write_text(content, encoding='utf-8')
                    if sha(pdf) != original_hash or any(sha(info['path']) != info['sha256'] for info in tools.values()):
                        raise ValueError('PDF or extractor changed during extraction')
                    text_receipt = publish_pdf_cache(staging, text_directory, text_identity, text_key,
                                                     'pdf_text_extraction', count)
                finally:
                    if staging.exists():
                        shutil.rmtree(staging)
            count = text_receipt['page_count']
            if any(p > count for p in pages):
                raise ValueError('render page is outside actual PDF')
            if receipt is None:
                staging = Path(tempfile.mkdtemp(prefix='.pdf-', dir=cache))
                try:
                    copy_pdf_text(text_directory, staging, text_receipt)
                    # Rendering only uses this private copy. Let another request
                    # reuse the same text while these pages are being rendered.
                    fcntl.flock(text_lock, fcntl.LOCK_UN)
                    if pages:
                        (staging / 'renders').mkdir()
                        for number in pages:
                            print('START: PDF render page %s at %s DPI' % (number, dpi), file=sys.stderr, flush=True)
                            prefix = staging / 'renders' / ('%04d' % number)
                            result = subprocess.run([tools['pdftoppm']['path'], '-f', str(number), '-l', str(number),
                                '-singlefile', '-png', '-r', str(dpi), str(pdf), str(prefix)], capture_output=True, timeout=120)
                            if result.returncode or not prefix.with_suffix('.png').is_file():
                                raise RuntimeError('PDF page render failed')
                    if sha(pdf) != original_hash or any(sha(info['path']) != info['sha256'] for info in tools.values()):
                        raise ValueError('PDF or extractor changed during inspection')
                    receipt = publish_pdf_cache(staging, destination, identity, key, 'pdf_inspection', count)
                finally:
                    if staging.exists():
                        shutil.rmtree(staging)
        if sha(pdf) != original_hash or any(sha(info['path']) != info['sha256'] for info in tools.values()):
            raise ValueError('PDF or extractor changed before accepting inspection')
        if read_cache(destination, key, options) != receipt:
            raise ValueError('PDF inspection cache changed before acceptance')
    return {'schema': SCHEMA, 'scope': 'pdf_inspection', 'status': 'inspected', 'cache_hit': hit,
            'cache_key': key, 'cache_directory': str(destination), 'pdf': str(pdf),
            'text_cache_hit': text_hit, 'text_cache_key': text_key, 'text_cache_directory': str(text_directory),
            'inputs': {str(pdf): original_hash, str(destination/'receipt.json'): sha(destination/'receipt.json'),
                       str(destination/'receipt.sha256'): sha(destination/'receipt.sha256'),
                       **{str(destination/name): value for name,value in receipt['artifacts'].items()}},
            'tool_inputs': {info['path']:info['sha256'] for info in tools.values()},
            'receipt': receipt, 'qualified': False, 'stock_current': False, 'release_approved': False}


def dependency_files(root, manifest, *, include_native=True):
    """Return exact repository-relative evidence paths for snapshot closure."""
    root = Path(root).resolve()
    value = json.loads(Path(manifest).read_text()) if not isinstance(manifest, dict) else manifest
    paths, profiles = set(), set()
    def walk(item):
        if isinstance(item, dict):
            if isinstance(item.get('path'), str) and 'sha256' in item:
                part_native.owned(root, item['path'])
                paths.add(item['path'])
            if isinstance(item.get('profile'), dict):
                profile = item['profile']
                target = part_native.owned(root, profile['path'])
                if sha(target) != profile.get('sha256'):
                    raise ValueError('shared part profile is stale: ' + profile['path'])
                if profile['path'] not in profiles:
                    profiles.add(profile['path'])
                    walk(json.loads(target.read_text()))
            for child in item.values():
                walk(child)
        elif isinstance(item, list):
            for child in item:
                walk(child)
    walk(value)
    if not isinstance(manifest, dict):
        try:
            paths.add(Path(manifest).resolve().relative_to(root).as_posix())
        except ValueError:
            pass
    if include_native:
        native = part_native.read_board(root, value.get('board'))
        paths.update(native['native_inputs'])
    if (root / 'hardware-design/registry/boards.json').is_file():
        paths.add('hardware-design/registry/boards.json')
    return sorted(paths)


def verify_manifest(root, board, path):
    """Verify reviewed facts against every required actual native instance."""
    return _verify_part_review(root, board, path, native_required=True)


def verify_selection(root, board, path, output=None):
    """Verify reviewed applicability before CAD; planned native facts stay unverified."""
    report = _verify_part_review(root, board, path, native_required=False)
    if output is not None:
        atomic_json(output, report)
    return report


def _verify_part_review(root, board, path, *, native_required):
    root, path = Path(root).resolve(), Path(path).resolve()
    report = {'schema': SCHEMA, 'scope': 'reviewed_part_use', 'board': board, 'status': 'blocked',
              'qualified': False, 'stock_current': False, 'release_approved': False, 'blockers': [],
              'constraints': {'schema': 'iot-lab.engineering-constraints.v1', 'rules': []},
              'bindings': {}, 'inputs': {}, 'native_inputs': {}, 'checked_ratings': [], 'checked_budgets': []}
    if not native_required:
        report.update(scope='reviewed_part_selection', selections={}, native_verified=False, cad_verified=False, stock_verified=False,
                      connectivity_verified=False, layout_verified=False,
                      limits=['Only declared reviewed selections and applicability are checked; selection completeness is unknown before CAD.',
                              'Native descriptors, planned pad nets and layout rules are declarations, not installed CAD evidence.',
                              'Original PDF identity/page attribution is checked; reviewed facts are not automatically inferred from PDF text.'])
    def block(code, detail, reference=None):
        report['blockers'].append({'code': code, 'detail': detail, **({'reference': reference} if reference else {})})
    def need(ok, code, detail, ref=None):
        if not ok:
            block(code, detail, ref)
        return bool(ok)
    def source(spec, pdf=False):
        if not isinstance(spec, dict) or not isinstance(spec.get('path'), str) or not re.fullmatch(r'[a-f0-9]{64}', spec.get('sha256', '')):
            raise ValueError('evidence needs exact path and SHA-256')
        target = part_native.owned(root, spec['path'])
        actual = sha(target)
        report['inputs'][spec['path']] = actual
        if actual != spec['sha256']:
            block('stale_source', 'evidence hash changed: ' + spec['path'])
        if pdf or target.suffix.lower() == '.pdf':
            page = spec.get('page')
            if isinstance(page, bool) or not isinstance(page, int) or not 1 <= page <= document_pages(target):
                raise ValueError('PDF source needs an actual one-based page locator')
        elif not isinstance(spec.get('section'), str) or not spec['section'].strip():
            raise ValueError('non-PDF source needs a section/record locator')
        return target
    page_counts = {}
    def document_pages(target):
        identity = sha(target)
        if identity not in page_counts:
            page_counts[identity] = pdf_pages(target, tool_inputs=report.setdefault('tool_inputs', {}))
        return page_counts[identity]
    def finite(value):
        return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)
    def interval(value):
        if not isinstance(value, dict) or not isinstance(value.get('unit'), str) or not value['unit']:
            raise ValueError('numeric range needs explicit unit')
        if not finite(value.get('min')) or not finite(value.get('max')) or value['min'] > value['max']:
            raise ValueError('numeric range needs finite ordered min/max')
        source(value.get('source'))
        return value
    def exact_keys(value, allowed, name):
        if not isinstance(value, dict) or set(value) - set(allowed):
            raise ValueError('unsupported ' + name + ' fields')
    def timestamp(value):
        if not isinstance(value, str) or dt.datetime.fromisoformat(value.replace('Z', '+00:00')).utcoffset() is None:
            raise ValueError('review timestamp requires an ISO-8601 timezone')
    def expand_part(entry):
        if 'profile' not in entry:
            return entry
        exact_keys(entry, ('reference', 'profile', 'use'), 'profile-backed part')
        descriptor, use = entry['profile'], entry.get('use', {})
        target = source(dict(descriptor, section='Shared part profile'))
        profile = json.loads(target.read_text())
        exact_keys(profile, ('schema', 'review', 'mpn', 'lcsc', 'manufacturer', 'package', 'datasheets', 'native',
                             'ratings', 'layout_constraints', 'assembly_dependencies', 'unresolved'), 'shared profile')
        if profile.get('schema') != PROFILE:
            raise ValueError('unsupported shared part profile schema')
        review = profile.get('review', {})
        if not isinstance(review, dict):
            raise ValueError('shared profile review must be an object')
        timestamp(review.get('reviewed_at_utc'))
        need(review.get('verdict') == 'passed' and bool(review.get('reviewer')) and bool(review.get('reviewed_at_utc')),
             'profile_review_pending', 'shared part profile needs an attributable engineering review', entry['reference'])
        need(review.get('facts_sha256') == facts_digest(profile), 'stale_profile_review', 'shared part profile facts changed', entry['reference'])
        source(review.get('evidence'))
        exact_keys(use, ('pad_net_map', 'required', 'conditions', 'refs', 'layout_constraints',
                         'assembly_dependencies', 'unresolved'), 'board use')
        result = copy.deepcopy({k: v for k, v in profile.items() if k not in ('schema', 'review')})
        result['reference'] = entry['reference']
        if 'pad_net_map' in result['native']:
            raise ValueError('shared profile must not contain board-specific pad nets')
        result['native']['pad_net_map'] = use['pad_net_map'] if native_required else use.get('pad_net_map', {})
        ratings = result['ratings']
        if set(use.get('required', {})) != {rating['id'] for rating in ratings}:
            raise ValueError('board use must cover every shared rating exactly')
        if set(use.get('conditions', {})) != {rating['id'] for rating in ratings}:
            raise ValueError('board use must cover every shared applicability condition')
        for rating in ratings:
            rating['required'] = use['required'][rating['id']]
            required_conditions = use['conditions'][rating['id']]
            if set(required_conditions) != {condition['quantity'] for condition in rating['conditions']}:
                raise ValueError('board use applicability conditions differ from shared profile')
            for condition in rating['conditions']:
                condition['required'] = required_conditions[condition['quantity']]
        mapping = {'SELF': entry['reference'], **use.get('refs', {})}
        if mapping['SELF'] != entry['reference'] or any(not isinstance(v, str) or not v for v in mapping.values()):
            raise ValueError('invalid shared profile instance reference mapping')
        def remap(value, key=None):
            if isinstance(value, dict):
                return {k: remap(v, k) for k, v in value.items()}
            if isinstance(value, list):
                return [remap(v, 'ref' if key == 'refs' else None) for v in value]
            if key in ('ref', 'reference') and isinstance(value, str) and value.startswith('$'):
                if value[1:] not in mapping:
                    raise ValueError('shared profile reference role has no board binding: ' + value)
                return mapping[value[1:]]
            return value
        for field in ('layout_constraints', 'assembly_dependencies'):
            result[field] = remap(result[field]) + use.get(field, [])
        for rule in result['layout_constraints'][:len(profile['layout_constraints'])]:
            original_id = rule['id']
            rule['id'] = entry['reference'] + ':' + original_id
            report.setdefault('constraint_origins', {})[rule['id']] = dict(profile=descriptor['path'],
                profile_sha256=descriptor['sha256'], source_rule_id=original_id, reference=entry['reference'])
        result['unresolved'] = result['unresolved'] + use.get('unresolved', [])
        report.setdefault('profiles', {})[descriptor['path']] = sha(target)
        return result
    try:
        raw = path.read_bytes()
        manifest = json.loads(raw)
        exact_keys(manifest, ('schema', 'board', 'revision', 'project', 'spec', 'review', 'parts', 'budgets'), 'manifest')
        report['manifest_sha256'] = part_native.digest(raw)
        report['manifest'] = str(path)
        manifest_input = str(path) if native_required else path.relative_to(root).as_posix()
        report['inputs'][manifest_input] = report['manifest_sha256']
        if not native_required:
            report.update(revision=manifest.get('revision'), project=manifest.get('project'))
        if native_required:
            native = part_native.read_board(root, board)
            report['native_inputs'] = native['native_inputs']
            report['tool_inputs'] = {**native['reader_inputs'], str(Path(__file__).resolve()): sha(Path(__file__).resolve())}
            report['inputs'].update(native['native_inputs'])
            report['bindings'] = native['parts']
            report['blockers'].extend(native['blockers'])
            project_matches = manifest.get('project') == native['project']
        else:
            if not isinstance(board, str) or not re.fullmatch(r'[A-Z0-9][A-Z0-9-]*', board):
                raise ValueError('selection requires an exact planned board/design ID')
            project = manifest.get('project')
            prefix = 'hardware-design/boards/' + board + '/'
            project_matches = isinstance(project, str) and project.startswith(prefix) and all(
                item and item not in ('.', '..') and '\\' not in item for item in project.split('/'))
            report['tool_inputs'] = {str(Path(__file__).resolve()): sha(Path(__file__).resolve()),
                                    str(Path(part_native.__file__).resolve()): sha(Path(part_native.__file__).resolve())}
            native = {'parts': {}}
        need(manifest.get('schema') == MANIFEST and manifest.get('board') == board and
             project_matches and isinstance(manifest.get('revision'), str) and manifest['revision'],
             'manifest_identity', 'exact board/revision/owned project identity required')
        source(manifest.get('spec'))
        board_prefix = 'hardware-design/boards/' + board + '/'
        need(manifest['spec']['path'].startswith(board_prefix), 'spec_owner', 'part use requires this board\'s specification')
        registry = root / 'hardware-design/registry/boards.json'
        if registry.is_file():
            from pcb_workflow import registry_revision
            revision = registry_revision(root, board)
            report['inputs']['hardware-design/registry/boards.json'] = sha(registry)
            if revision:
                need(manifest['revision'] == revision.get('revision') and manifest['spec']['path'] ==
                     'hardware-design/boards/' + revision['directory'] + '/' + revision['spec'],
                     'revision_owner', 'manifest differs from registered native revision/spec ownership')
        review = manifest.get('review', {})
        if not isinstance(review, dict):
            raise ValueError('manifest review must be an object')
        need(review.get('verdict') == 'passed' and isinstance(review.get('reviewer'), str) and review['reviewer'].strip(),
             'review_pending', 'explicit attributable engineering review required')
        try:
            timestamp(review.get('reviewed_at_utc'))
        except (ValueError, TypeError, KeyError):
            block('review_timestamp', 'review timestamp missing/invalid')
        need(review.get('facts_sha256') == facts_digest(manifest), 'stale_review', 'review is not bound to these exact engineering facts')
        source(review.get('evidence'))
        parts = manifest.get('parts')
        if not isinstance(parts, list) or not parts:
            raise ValueError('manifest requires explicit reviewed parts')
        seen = set()
        for part in parts:
            ref = part.get('reference') if isinstance(part, dict) else None
            try:
                part = expand_part(part)
                exact_keys(part, ('reference', 'mpn', 'lcsc', 'manufacturer', 'package', 'datasheets', 'native',
                                  'ratings', 'layout_constraints', 'assembly_dependencies', 'unresolved'), 'part')
                if not isinstance(ref, str) or not ref.strip() or ref in seen or (native_required and ref not in native['parts']):
                    raise ValueError('duplicate, missing or unknown native/planned reference')
                seen.add(ref)
                identity = isinstance(part.get('mpn'), str) and bool(part['mpn'].strip()) and part['mpn'] == part['mpn'].strip() and bool(re.fullmatch(r'C[0-9]+', part.get('lcsc', '')))
                actual = native['parts'][ref] if native_required else None
                need(identity and (not native_required or (part['mpn'] == actual['mpn'] and part['lcsc'] == actual['lcsc'])),
                     'part_identity', 'exact native/planned MPN/LCSC differs or is missing', ref)
                package = part.get('package', {})
                if not isinstance(package, dict):
                    raise ValueError('package identity must be an object')
                need(isinstance(part.get('manufacturer'), str) and part['manufacturer'].strip() and
                     isinstance(package.get('name'), str) and package['name'].strip() and
                     isinstance(package.get('variant'), str) and package['variant'].strip(),
                     'package_identity', 'manufacturer, exact package and variant must be reviewed', ref)
                documents = part.get('datasheets', [])
                if not documents:
                    raise ValueError('original exact datasheet/revision evidence required')
                document_identities = set()
                for document in documents:
                    if not isinstance(document, dict):
                        raise ValueError('datasheet source must be an object')
                    need(bool(document.get('document_id')) and bool(document.get('revision')),
                         'document_identity', 'actual datasheet identity and revision required', ref)
                    source(document, pdf=True)
                    document_identities.add((document['path'], document['sha256']))
                expected = part.get('native', {})
                if not isinstance(expected, dict):
                    raise ValueError('native part binding must be an object')
                if native_required:
                    unspecified = sorted(number for number, pin in actual['pin_map'].items()
                                         if pin['type'] == 'unspecified')
                    need(not unspecified, 'unspecified_pin_type',
                         'reviewed native symbol needs functional electrical pin types; unspecified pins: '
                         + ', '.join(unspecified), ref)
                    for field in ('symbol_sha256', 'pin_map', 'footprint', 'footprint_sha256', 'land_geometry_sha256', 'pad_net_map'):
                        need(field in expected and expected[field] == actual.get(field),
                             {'pin_map': 'pin_map_mismatch', 'land_geometry_sha256': 'land_geometry_mismatch'}.get(field, 'native_asset_mismatch'),
                             'installed native ' + field + ' differs from reviewed facts', ref)
                    mechanical = expected.get('non_electrical_pads')
                    need(isinstance(mechanical, list) and len(set(mechanical)) == len(mechanical) and
                         set(actual['pad_numbers']) == set(actual['pin_map']) | set(mechanical or []) and
                         not set(actual['pin_map']) & set(mechanical or []), 'pin_pad_coverage', 'all physical pad numbers need exact pin/mechanical classification', ref)
                else:
                    planned_nets = expected.get('pad_net_map', {})
                    if not isinstance(planned_nets, dict) or any(not isinstance(k, str) or not k or not isinstance(v, str) or not v for k, v in planned_nets.items()):
                        raise ValueError('planned pad nets require explicit string pad/net identities')
                    native['parts'][ref] = dict(required=True, pad_net_map=planned_nets)
                    report['selections'][ref] = dict(mpn=part['mpn'], lcsc=part['lcsc'], manufacturer=part['manufacturer'],
                        package=copy.deepcopy(package), planned_native=copy.deepcopy(expected), native_verified=False)
                ratings = part.get('ratings')
                if not isinstance(ratings, list) or not ratings:
                    raise ValueError('at least one sourced applicable rating/operating range required')
                rating_ids = [rating.get('id') for rating in ratings if isinstance(rating, dict)]
                if len(rating_ids) != len(set(rating_ids)):
                    raise ValueError('rating IDs must be unique for this part')
                for rating in ratings:
                    if not isinstance(rating, dict):
                        raise ValueError('rating must be an object')
                    if not rating.get('id') or not rating.get('quantity') or not isinstance(rating.get('conditions'), list):
                        raise ValueError('rating needs id, physical quantity and explicit applicability conditions')
                    limit, demand = interval(rating['limit']), interval(rating['required'])
                    need(demand['source']['path'].startswith(board_prefix), 'use_conditions_owner', 'operating demand must cite this board\'s requirements', ref)
                    need((limit['source']['path'], limit['source']['sha256']) in document_identities,
                         'rating_source', 'rating limit must cite this exact part datasheet', ref)
                    need(limit['unit'] == demand['unit'] and limit['min'] <= demand['min'] <= demand['max'] <= limit['max'],
                         'rating_exceeded', 'required operating range exceeds sourced applicable rating or units differ: ' + rating['id'], ref)
                    for condition in rating['conditions']:
                        if not isinstance(condition, dict):
                            raise ValueError('applicability condition must be an object')
                        valid, required = interval(condition['valid']), interval(condition['required'])
                        need(required['source']['path'].startswith(board_prefix), 'use_conditions_owner', 'operating conditions must cite this board\'s requirements', ref)
                        need((valid['source']['path'], valid['source']['sha256']) in document_identities,
                             'rating_condition_source', 'applicability limit must cite this exact part datasheet', ref)
                        need(bool(condition.get('quantity')) and valid['unit'] == required['unit'] and
                             valid['min'] <= required['min'] <= required['max'] <= valid['max'],
                             'rating_conditions', 'rating applicability conditions not met: ' + rating['id'], ref)
                    report['checked_ratings'].append({'reference': ref, 'id': rating['id']})
                rules = part.get('layout_constraints')
                if not isinstance(rules, list):
                    raise ValueError('explicit layout constraints list required')
                for rule in rules:
                    if not isinstance(rule, dict):
                        raise ValueError('layout constraint must be an object')
                    source(rule.get('source'))
                    need(rule.get('kind') in KINDS and isinstance(rule.get('id'), str) and rule['id'],
                         'unsupported_constraint', 'unrecognized or unnamed layout constraint', ref)
                    report['constraints']['rules'].append(rule)
                dependencies = part.get('assembly_dependencies')
                if not isinstance(dependencies, list):
                    raise ValueError('explicit connector/assembly dependency list required')
                for dependency in dependencies:
                    if not isinstance(dependency, dict):
                        raise ValueError('assembly dependency must be an object')
                    need(dependency.get('kind') in ('mate', 'contact', 'harness', 'battery', 'other') and
                         bool(dependency.get('reference')) and bool(dependency.get('mpn')) and
                         isinstance(dependency.get('quantity'), int) and not isinstance(dependency.get('quantity'), bool) and dependency['quantity'] > 0,
                         'assembly_dependency', 'exact assembly dependency identity/quantity missing', ref)
                    source(dependency.get('source'))
                unresolved = part.get('unresolved')
                detail = 'unresolved part engineering items remain'
                if not native_required and unresolved:
                    detail += ': ' + json.dumps(unresolved)
                need(isinstance(unresolved, list) and not unresolved, 'unresolved_part_use', detail, ref)
            except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
                block('invalid_part_evidence', str(error), ref)
        if native_required:
            missing = sorted(ref for ref, value in native['parts'].items() if value['required'] and ref not in seen)
            need(not missing, 'unreviewed_native_parts', 'fitted native references lack reviewed evidence: ' + ', '.join(missing))
        ids = [rule['id'] for rule in report['constraints']['rules'] if isinstance(rule.get('id'), str)]
        need(len(ids) == len(set(ids)), 'constraint_identity', 'layout constraint IDs must be unique')
        for budget in manifest.get('budgets', []):
            try:
                connected = {ref for ref, value in native['parts'].items() if value['required'] and budget['net'] in value['pad_net_map'].values()}
                limit = interval(budget['limit'])
                need(bool(connected) and limit['unit'] in ('A', 'W'), 'budget_scope', 'budget needs declared net and current/power units')
                if not native_required:
                    need(all(part['pad_net_map'] for part in native['parts'].values()), 'planned_budget_scope',
                         'every selection needs planned pad nets before declared budget coverage can be checked')
                loads, excluded, total = set(), set(), 0.0
                for load in budget['loads']:
                    required = interval(load['required'])
                    need(load['reference'] in connected and load['reference'] not in loads and required['unit'] == limit['unit'] and required['min'] >= 0,
                         'budget_load', 'budget load identity/units/coverage invalid')
                    loads.add(load['reference']); total += required['max']
                for exclusion in budget.get('exclusions', []):
                    source(exclusion['source'])
                    need(bool(exclusion.get('reason')) and exclusion['reference'] in connected and exclusion['reference'] not in excluded,
                         'budget_exclusion', 'budget exclusion requires unique native reference and sourced reason')
                    excluded.add(exclusion['reference'])
                need(not loads & excluded and loads | excluded == connected and total <= limit['max'],
                     'budget_exceeded', 'native net coverage incomplete or summed worst-case loads exceed sourced budget')
                result = {'id': budget['id'], 'net': budget['net'], 'total': total, 'unit': limit['unit']}
                if not native_required:
                    result['scope'] = 'declared_planned_net_only'
                report['checked_budgets'].append(result)
            except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
                block('invalid_budget', str(error))
        for name, expected in report['inputs'].items():
            target = path if name == manifest_input else part_native.owned(root, name)
            if sha(target) != expected:
                block('stale_source', 'source changed during verification: ' + name)
        if sha(path) != report['manifest_sha256']:
            block('stale_source', 'manifest changed during verification')
        for name, expected in report.get('tool_inputs', {}).items():
            if sha(name) != expected:
                block('stale_tool', 'verification tool changed: ' + name)
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.SubprocessError) as error:
        block('invalid_manifest', str(error))
    report['status'] = 'passed' if not report['blockers'] else ('stale' if any(b['code'].startswith('stale_') for b in report['blockers']) else 'blocked')
    return report


def status_board(root, board):
    root = Path(root).resolve()
    if not isinstance(board, str) or not re.fullmatch(r'[A-Z0-9][A-Z0-9-]*', board):
        raise ValueError('expected configured board ID')
    path = root / 'hardware-design/registry/part-reviews' / (board + '.json')
    if path.is_file():
        return verify_manifest(root, board, path)
    native = part_native.read_board(root, board)
    return {'schema': SCHEMA, 'scope': 'reviewed_part_use', 'board': board, 'status': 'blocked',
            'qualified': False, 'stock_current': False, 'release_approved': False,
            'absent_inputs': [path.relative_to(root).as_posix()],
            'inputs': native['native_inputs'], 'native_inputs': native['native_inputs'], 'tool_inputs': native['reader_inputs'], 'bindings': native['parts'],
            'constraints': {'schema': 'iot-lab.engineering-constraints.v1', 'rules': []},
            'blockers': native['blockers'] + [{'code': 'missing_part_review', 'detail': 'no reviewed native part-use manifest',
                'path': path.relative_to(root).as_posix(), 'references': sorted(ref for ref, value in native['parts'].items() if value['required'])}]}


def verify_population_source(report):
    """Check the exact optional population policy, including recorded absence.

    Absolute paths retain the original backend workspace context. This observes
    filesystem presence/hash only; it never runs native CAD or supplier tools.
    """
    descriptor = report.get('population_source')
    if (not isinstance(descriptor,dict) or set(descriptor) != {'path','exists','sha256'}
            or not isinstance(descriptor.get('path'),str) or not isinstance(descriptor.get('exists'),bool)):
        raise ValueError('stock observation lacks an explicit population policy presence binding')
    path = Path(descriptor['path'])
    if (not path.is_absolute() or path.resolve() != path or path.is_symlink()
            or path.name != 'variants.json' or path.parent.name != report.get('board')
            or path.parent.parent.name != 'boards' or path.parent.parent.parent.name != 'hardware-design'):
        raise ValueError('stock population policy path is not its exact native board owner')
    if descriptor['exists']:
        expected = descriptor['sha256']
        if not isinstance(expected,str) or not re.fullmatch(r'[a-f0-9]{64}',expected) or not path.is_file() or sha(path) != expected:
            raise ValueError('stock population policy changed or disappeared')
    elif descriptor['sha256'] is not None or path.exists():
        raise ValueError('stock population policy appeared after recorded absence')


def stock_population_current(report):
    try:
        verify_population_source(report)
        return True
    except (OSError,ValueError,TypeError,KeyError):
        return False


def stock_board(root, board, candidate, boards, receipts, runner=None):
    """Observe assembly availability through the existing exact release helper."""
    report = {'schema': SCHEMA, 'scope': 'assembly_stock_observation', 'board': board, 'status': 'blocked',
              'qualified': False, 'stock_current': False, 'release_approved': False, 'blockers': [], 'inputs': {}}
    try:
        if not re.fullmatch(r'[A-Z0-9][A-Z0-9-]*', board) or isinstance(boards, bool) or not isinstance(boards, int) or boards < 1:
            raise ValueError('exact board and positive integer board quantity required')
        part_native.owned(Path(root).resolve(), 'hardware-design/boards/' + board + '/gate.json')
        candidate, receipts = Path(candidate).resolve(), Path(receipts).resolve()
        manifest_path = candidate / 'release-manifest.json'
        manifest = json.loads(manifest_path.read_text()); manifest_hash = sha(manifest_path)
        if manifest.get('schema_version') != 1 or manifest.get('scope') != 'cad_fabrication_candidate' or manifest.get('board') != board:
            raise ValueError('candidate board/scope/schema mismatch; no stock request made')
        if receipts.exists():
            raise ValueError('stock receipts directory must be new; preserve original responses')
        native = part_native.read_board(root, board)
        if native['blockers']:
            raise ValueError('native part identity is inconsistent; no stock request made')
        evidence_path = candidate / 'fab/gate-evidence.json'
        gate = json.loads(evidence_path.read_text())
        recorded = {item['path']: item['sha256'] for item in gate['result']['provenance']['inputs']}
        if (manifest.get('artifacts', {}).get('fab/gate-evidence.json') != sha(evidence_path)
                or not manifest.get('input_sha256') or gate.get('input_sha256') != manifest['input_sha256']
                or gate.get('board') != board or any(recorded.get(name) != value for name, value in native['native_inputs'].items())):
            raise ValueError('candidate native board/schematic binding is stale; no stock request made')
        variant_path = Path(root).resolve() / 'hardware-design/boards' / board / 'variants.json'
        report['population_source'] = dict(path=str(variant_path), exists=variant_path.is_file(),
                                          sha256=sha(variant_path) if variant_path.is_file() else None)
        verify_population_source(report)
        variant_inputs = {}
        if variant_path.is_file():
            variants = json.loads(variant_path.read_text())
            names = variants['variants']
            if (not isinstance(names,list) or not names or any(not isinstance(name,str) or not name.strip() for name in names)
                    or len(set(names)) != len(names) or set(variants['fit']) != set(native['parts'])):
                raise ValueError('current variant population coverage is incomplete; no stock request made')
            for ref,fit in variants['fit'].items():
                if (not isinstance(fit,list) or any(not isinstance(name,str) or name not in names for name in fit)
                        or len(set(fit)) != len(fit) or native['parts'][ref]['required'] and not fit):
                    raise ValueError('current variant fit must explicitly cover native fitted references: ' + ref)
            expected_populations = {name:{ref:part['lcsc'] for ref,part in native['parts'].items()
                if part['in_bom'] and name in variants['fit'][ref]} for name in names}
            variant_inputs[str(variant_path)] = sha(variant_path)
        else:
            expected_populations = {'DEFAULT':{ref:part['lcsc'] for ref,part in native['parts'].items() if part['required']}}
        actual_populations = {name:value['references'] for name,value in manifest['assembly']['populations'].items()}
        if actual_populations != expected_populations or not all(expected_populations.values()):
            raise ValueError('candidate populations differ from exact current native/variant scope; no stock request made')
        required, models = {}, {}
        for population in manifest['assembly']['populations'].values():
            for ref, code in population['references'].items():
                part = native['parts'].get(ref)
                if not part or not part['mpn'] or part['lcsc'] != code or code in models and models[code] != part['mpn']:
                    raise ValueError('candidate reference/MPN/LCSC differs from actual native part: ' + ref)
                models[code] = part['mpn']
            codes = list(population['references'].values())
            for code in codes:
                if not isinstance(code, str) or not re.fullmatch(r'C[0-9]+', code):
                    raise ValueError('candidate contains an invalid exact LCSC code')
                required[code] = max(required.get(code, 0), codes.count(code) * boards)
        if not required:
            raise ValueError('candidate has no fitted assembly population')
        day = dt.datetime.now(dt.timezone.utc).date().isoformat()
        helper = Path(__file__).resolve().parent / 'release-stock.mjs'
        report.update(candidate=str(candidate), candidate_sha256=manifest_hash, order_day_utc=day, boards=boards,
                      required_quantities=required, receipts=str(receipts),
                      inputs={**native['native_inputs'], **variant_inputs, str(manifest_path): manifest_hash, str(evidence_path): sha(evidence_path)},
                      tool_inputs={str(path): sha(path) for path in (helper, helper.parent / 'lib/py-compat.mjs')})
        command = ['node', str(helper), str(candidate), str(receipts), '--boards', str(boards)]
        run = runner or subprocess.run
        result = run(command, stdout=sys.stderr, stderr=sys.stderr, timeout=30 * (len(required) + 1))
        if result.returncode:
            raise RuntimeError('existing stock helper failed; original/partial responses retained at ' + str(receipts))
        receipt_path = receipts / 'stock.json'
        receipt = json.loads(receipt_path.read_text())
        report['inputs'][str(receipt_path)] = sha(receipt_path)
        if (receipt.get('schema_version') != 1 or receipt.get('board') != board or receipt.get('candidate_sha256') != manifest_hash
                or receipt.get('order_day_utc') != day or receipt.get('boards') != boards or set(receipt.get('parts', {})) != set(required)):
            raise ValueError('stock receipt candidate/board/day/quantity/coverage mismatch')
        if receipt.get('source_url') != 'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList':
            raise ValueError('stock source differs from existing release helper')
        observed = {}
        for code, need in required.items():
            item = receipt['parts'][code]
            name = item.get('response')
            if not isinstance(name, str) or Path(name).name != name or name in ('', '.', '..'):
                raise ValueError('invalid original stock response path')
            path = receipts / name
            if path.is_symlink() or item.get('required') != need or sha(path) != item.get('response_sha256') or item.get('fetched_at_utc', '')[:10] != day:
                raise ValueError('stock original response/hash/day/quantity mismatch: ' + code)
            fetched = dt.datetime.fromisoformat(item['fetched_at_utc'].replace('Z', '+00:00'))
            if fetched.utcoffset() is None or fetched.astimezone(dt.timezone.utc).date().isoformat() != day:
                raise ValueError('stock original response timestamp lacks exact UTC day: ' + code)
            report['inputs'][str(path)] = sha(path)
            rows = ((json.loads(path.read_text()).get('data') or {}).get('componentPageInfo') or {}).get('list') or []
            exact = [row for row in rows if row.get('componentCode') == code]
            count = exact[0].get('stockCount') if len(exact) == 1 else None
            if isinstance(count, bool) or not isinstance(count, int) or count < need or exact[0].get('componentModelEn') != models[code]:
                raise ValueError('assembly stock is unavailable/ambiguous: ' + code)
            observed[code] = {'required': need, 'observed': count, 'mpn': exact[0].get('componentModelEn'), 'response_sha256': sha(path)}
        if sha(manifest_path) != manifest_hash:
            raise ValueError('candidate changed during stock observation')
        if any(sha(part_native.owned(Path(root).resolve(), name)) != value for name, value in native['native_inputs'].items()):
            raise ValueError('native board/schematic changed during stock observation')
        if any(sha(name if Path(name).is_absolute() else Path(root)/name) != value for name,value in report['inputs'].items()):
            raise ValueError('candidate or original stock evidence changed during observation')
        verify_population_source(report)
        report.update(status='observed', stock_current=True, observations=observed,
                      receipt_sha256=sha(receipt_path), limits=['Dated assembly stock observation only; quantities are not reserved. Engineering selection and complete assembly availability remain separate.'])
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.SubprocessError) as error:
        report['blockers'].append({'code': 'stock_observation', 'detail': str(error)})
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default=project_root.root_str())
    parser.add_argument('--output')
    parser.add_argument('--json', action='store_true')
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('status', 'verify', 'selection', 'inspect', 'stock'):
        command = commands.add_parser(name)
        command.add_argument('target')
        command.add_argument('--root', default=argparse.SUPPRESS)
        command.add_argument('--output', default=argparse.SUPPRESS)
        command.add_argument('--json', action='store_true', default=argparse.SUPPRESS)
        if name in ('verify', 'selection'):
            command.add_argument('--manifest', required=True)
        if name == 'inspect':
            command.add_argument('--cache', default=str(Path.home() / '.cache/iot-lab/part-evidence'))
            command.add_argument('--render-pages', default='')
            command.add_argument('--dpi', type=int, default=144)
        if name == 'stock':
            command.add_argument('--candidate', required=True)
            command.add_argument('--boards', required=True, type=int)
            command.add_argument('--receipts', required=True)
    args = parser.parse_args()
    try:
        if args.command == 'inspect':
            result = inspect_pdf(args.target, args.cache, [int(p) for p in args.render_pages.split(',') if p], args.dpi)
        elif args.command == 'status':
            result = status_board(args.root, args.target)
        elif args.command == 'stock':
            result = stock_board(args.root, args.target, args.candidate, args.boards, args.receipts)
        elif args.command == 'selection':
            result = verify_selection(args.root, args.target, args.manifest)
        else:
            result = verify_manifest(args.root, args.target, args.manifest)
    except Exception as error:
        result = {'schema': SCHEMA, 'status': 'blocked', 'scope': 'part_evidence', 'qualified': False,
                  'stock_current': False, 'release_approved': False, 'blockers': [{'code': 'runtime', 'detail': str(error)}]}
    if args.output:
        atomic_json(args.output, result)
    display=result
    if args.command in ('selection', 'inspect') and args.output and args.json:
        display={key:result.get(key) for key in ('schema','scope','status','board','qualified','native_verified','cad_verified','stock_verified','stock_current')}
        if args.command == 'inspect':
            display.update({key:result.get(key) for key in ('pdf','cache_hit','text_cache_hit','cache_key','text_cache_key','cache_directory','text_cache_directory')})
        display.update(blockers=len(result.get('blockers',[])),report=dict(path=str(Path(args.output).resolve()),sha256=sha(args.output)))
    print(json.dumps(display, sort_keys=True, allow_nan=False) if args.json else '%s parts: %s' % (result['status'].upper(), result.get('board', result.get('pdf'))))
    return 0 if result['status'] in ('passed', 'inspected', 'observed') else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        print(json.dumps({'schema': SCHEMA, 'status': 'blocked', 'scope': 'part_evidence', 'blockers': [{'code': 'runtime', 'detail': str(error)}]}))
        sys.exit(1)
