"""The read of one KiCad block for the Python modules not yet ported; never grants design qualification.

The block commands are tools/blocks.ts. This goes with pcb_search/block_bindings.py and engineering_constraints.py.
"""
import hashlib
import json
import os
import re
from pathlib import Path


_PROP = re.compile(r'\(property "([^"]+)" "((?:[^"\\]|\\.)*)"')


def parse_footprints(pcb_text):
    """Top-level footprints of a .kicad_pcb text: ref, value, footprint, lcsc, mpn, description, datasheet
    (file name only), plus 'bom': False when the footprint is excluded from the BOM."""
    out = []
    for chunk in re.split(r'\n\t\((?=\S)', pcb_text)[1:]:
        if not chunk.startswith('footprint "'):
            continue
        props = {}
        for k, v in _PROP.findall(chunk):
            props.setdefault(k, v)
        ds = props.get('Datasheet', '')
        f = {'ref': props.get('Reference', ''), 'value': props.get('Value', ''),
             'footprint': chunk[len('footprint "'):chunk.index('"', len('footprint "'))],
             'lcsc': props.get('LCSC', ''), 'mpn': props.get('MPN', ''),
             'description': props.get('Description', ''),
             'datasheet': os.path.basename(ds) if ds.lower().endswith('.pdf') and '://' not in ds else '',
             'url': ds if '://' in ds else ''}
        if re.search(r'\(attr[^)]*exclude_from_bom', chunk):
            f['bom'] = False
        out.append(f)
    return out


def validate_facts(facts):
    errs = []
    if facts.get('level') not in (0, 1, 2):
        errs.append('level must be 0, 1 or 2')
    for i, r in enumerate(facts.get('layout_rules', []), 1):
        if not r.get('rule'):
            errs.append(f'layout rule {i} has no text')
        if not r.get('source'):
            errs.append(f'layout rule {i} has no source')
    return errs


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
    parts = parse_footprints(pcb.read_text()) if pcb.exists() else []
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
        'facts_errors': validate_facts(facts),
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
