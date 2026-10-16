"""Read-only retrieval of existing KiCad blocks; never grants design qualification.

Run via ``blocks.py find QUERY`` or ``blocks.py reuse ID``. No KiCad runtime needed.
"""
import hashlib
import json
import re
from pathlib import Path

import blocks


def snapshot(directory):
    """Bind all local CAD, rules, library tables and metadata (not GUI state)."""
    root = Path(directory).resolve()
    hashes = {}
    for path in sorted(root.rglob('*')):
        if not path.is_file() or not (path.suffix in {
                '.kicad_sch', '.kicad_pcb', '.kicad_pro', '.kicad_dru',
                '.kicad_sym', '.kicad_mod', '.json'} or path.name.endswith('lib-table')):
            continue
        if not path.resolve().is_relative_to(root):
            raise ValueError(f'external block file: {path.name}')
        hashes[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    digest = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()
    return digest, hashes


def read_block(directory):
    root = Path(directory)
    digest, files = snapshot(root)
    iid = root.name.removesuffix('.kicad_block')
    def read_json(name):
        path = root / name
        value = json.loads(path.read_text()) if path.exists() else {}
        if not isinstance(value, dict):
            raise ValueError(f'{path}: expected object')
        return value
    meta = read_json(iid + '.json')
    facts = read_json('facts.json')
    pcb = root / (iid + '.kicad_pcb')
    parts = blocks.parse_footprints(pcb.read_text()) if pcb.exists() else []
    if snapshot(root) != (digest, files):
        raise ValueError(f'{iid}: source changed during retrieval; inspect again')
    return {
        'schema': 'iot-lab.block-reuse.v1', 'id': iid,
        'description': meta.get('description', ''), 'keywords': meta.get('keywords', ''),
        'source_directory': str(root.resolve()), 'source_sha256': digest, 'files': files,
        'parts': parts, 'ports': facts.get('ports', []),
        'layout_rules': facts.get('layout_rules', []),
        'declared_level': facts.get('level'),
        'source_note': facts.get('source'), 'declared_gate_notes': facts.get('gates'),
        'open_items': facts.get('open_items', []),
        'facts_errors': blocks.validate_facts(facts),
        'missing_files': [iid + ext for ext in ('.kicad_sch', '.kicad_pcb', '.kicad_pro')
                          if not (root / (iid + ext)).is_file()],
        'qualification': 'unverified_for_target',
        'target_checks_required': [
            'exact parts, pin mapping and footprints',
            'port net mapping, operating limits and ground/isolation domains',
            'stackup, layer mapping, copper thickness and target rules',
            'boundary copper, return paths, keepouts and connector access',
            'native ERC/DRC/parity and applicable board electrical gates',
            'current part availability and attributable validation evidence'],
    }


def catalog(library):
    return [read_block(p) for p in sorted(Path(library).glob('*.kicad_block'))]


def find(library, query, mpn=None, footprint=None):
    """All query tokens must match. Exact part filters narrow discovery, not approval."""
    tokens = set(re.findall(r'[\w]+', query.casefold()))
    results = []
    for row in catalog(library):
        parts = row['parts']
        if mpn and not any(p['mpn'].casefold() == mpn.casefold() for p in parts):
            continue
        if footprint and not any(p['footprint'] == footprint for p in parts):
            continue
        fields = {k: str(row[k]).casefold() for k in ('id', 'description', 'keywords')}
        fields['parts'] = json.dumps(parts).casefold()
        fields['ports'] = json.dumps(row['ports']).casefold()
        matched = {t: [k for k, value in fields.items() if t in value] for t in sorted(tokens)}
        if all(matched.values()):
            results.append({k: row[k] for k in ('id', 'description', 'declared_level',
                'source_sha256', 'qualification', 'open_items', 'missing_files')} |
                {'matches': matched})
    return results


def reuse(library, iid, expected_sha256=None, receipt=None):
    if not re.fullmatch(r'[A-Za-z0-9_-]+', iid):
        raise ValueError('invalid block ID')
    path = Path(library) / (iid + '.kicad_block')
    if not path.is_dir():
        raise ValueError(f'unknown block: {iid}')
    row = read_block(path)
    if expected_sha256 and row['source_sha256'] != expected_sha256:
        raise ValueError('stale block: source fingerprint changed; inspect again')
    if receipt is not None:
        import block_qualification
        checked = block_qualification.status(receipt)
        original = block_qualification.read(receipt)
        binding = original.get('binding', {})
        if (checked['status'] != 'current' or binding.get('block_id') != iid
                or binding.get('source_sha256') != row['source_sha256']
                or binding.get('source_directory') != row['source_directory']):
            raise ValueError('stale or different block qualification receipt')
        row.update(qualification=checked['qualification'], verified_level=checked['level'],
                   qualification_receipt=str(Path(receipt).resolve()),
                   qualification_target=dict(board=binding['target'], instance_path=binding['instance_path']),
                   qualification_scope=original['scope'])
    return row


def target_plan(library, iid, target, mapping=None):
    """Bind explicit target inputs and port mapping without granting CAD approval.

    target is a JSON file listing paths relative to itself. Include requirements,
    rules and CAD; callers choose the dependency closure, which remains reviewable.
    mapping is a prior plan: all fingerprints must still match before reuse.
    """
    manifest = Path(target).resolve()
    spec = json.loads(manifest.read_text())
    if not isinstance(spec, dict) or not isinstance(spec.get('inputs'), list) or not spec['inputs']:
        raise ValueError('target manifest requires a nonempty inputs list')
    inputs = {}
    for name in spec['inputs']:
        if not isinstance(name, str) or not name:
            raise ValueError('target input paths must be nonempty strings')
        path = (manifest.parent / name).resolve()
        inputs[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    inputs['$manifest'] = hashlib.sha256(manifest.read_bytes()).hexdigest()
    digest = hashlib.sha256(json.dumps(inputs, sort_keys=True).encode()).hexdigest()
    row = reuse(library, iid)
    names = [p.get('name') for p in row['ports']]
    if any(not isinstance(n, str) or not n for n in names) or len(set(names)) != len(names):
        raise ValueError('block ports require unique nonempty names')
    ports = {name: None for name in names}
    if mapping is not None:
        if (mapping.get('block_id') != iid or mapping.get('source_sha256') != row['source_sha256']
                or mapping.get('target_sha256') != digest):
            raise ValueError('stale reuse plan: block or target inputs changed')
        ports = mapping.get('port_map')
        if not isinstance(ports, dict) or set(ports) != set(names):
            raise ValueError('port map must cover exactly the block ports')
        if any(v is not None and (not isinstance(v, str) or not v.strip()) for v in ports.values()):
            raise ValueError('port destinations must be nonempty net names or null')
    return {'schema': 'iot-lab.target-reuse-plan.v1', 'block_id': iid,
            'source_sha256': row['source_sha256'], 'target_manifest': str(manifest),
            'target_sha256': digest, 'target_inputs': inputs, 'port_map': ports,
            'unmapped_ports': [k for k, v in ports.items() if v is None],
            'qualification': 'unverified_for_target',
            'missing_block_files': row['missing_files'], 'facts_errors': row['facts_errors'],
            'open_items': row['open_items'], 'target_checks_required': row['target_checks_required']}

