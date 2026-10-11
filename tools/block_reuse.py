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


def reuse(library, iid, expected_sha256=None):
    if not re.fullmatch(r'[A-Za-z0-9_-]+', iid):
        raise ValueError('invalid block ID')
    path = Path(library) / (iid + '.kicad_block')
    if not path.is_dir():
        raise ValueError(f'unknown block: {iid}')
    row = read_block(path)
    if expected_sha256 and row['source_sha256'] != expected_sha256:
        raise ValueError('stale block: source fingerprint changed; inspect again')
    return row
