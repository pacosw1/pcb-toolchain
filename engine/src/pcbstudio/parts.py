"""BOM and part evidence for a board, from its .kicad_pcb footprints plus the project registry. Read only.

A BOM line groups footprints with the same value, LCSC C-number, MPN and footprint. Joined per line:
- datasheet: `registry/datasheets/<anything>_<C-number>.pdf` (the iot-lab naming), else the footprint's Datasheet URL;
- CAD asset: `registry/cad-assets/<C-number>/` exists;
- evidence: the board's `BOM-VERIFIED.csv` (Stock status, Assembly status) by designator.
Phase 6 replaces the CSV join with per-board `parts.yaml` and per-part `part.yaml`.
"""
from __future__ import annotations

import csv
import re
from functools import lru_cache
from pathlib import Path

from .kicad import board as kboard
from .project import BOARDS_DIR, Project

C_NUMBER = re.compile(r'_(C\d{3,})\.pdf$', re.IGNORECASE)


def _natural(ref: str) -> tuple:
    return tuple(int(t) if t.isdigit() else t for t in re.split(r'(\d+)', ref))


@lru_cache(maxsize=8)
def _datasheet_index(root: str, stamp: float) -> dict[str, str]:
    """C-number -> project-relative PDF path. `stamp` (dir mtime) invalidates the cache."""
    d = Path(root) / 'hardware-design/registry/datasheets'
    out: dict[str, str] = {}
    if d.is_dir():
        for p in sorted(d.glob('*.pdf')):
            m = C_NUMBER.search(p.name)
            if m:
                out.setdefault(m.group(1).upper(), str(p.relative_to(root)))
    return out


def datasheet_index(project: Project) -> dict[str, str]:
    d = project.root / 'hardware-design/registry/datasheets'
    return _datasheet_index(str(project.root), d.stat().st_mtime if d.is_dir() else 0.0)


def _verified(project: Project, pcb_rel: str) -> dict[str, dict[str, str]]:
    """Designator -> BOM-VERIFIED.csv row, for the board that owns this PCB."""
    parts = Path(pcb_rel).parts
    try:
        board_dir = project.root / BOARDS_DIR / parts[parts.index('boards') + 1]
    except (ValueError, IndexError):
        return {}
    f = board_dir / 'BOM-VERIFIED.csv'
    if not f.is_file():
        return {}
    out: dict[str, dict[str, str]] = {}
    with f.open(newline='', encoding='utf-8', errors='replace') as fh:
        for row in csv.DictReader(fh):
            for ref in re.split(r'[,\s]+', row.get('Designator') or ''):
                if ref:
                    out[ref] = row
    return out


def bom(project: Project, pcb_rel: str) -> dict:
    geo = kboard.load(project.resolve(pcb_rel))
    sheets = datasheet_index(project)
    verified = _verified(project, pcb_rel)
    assets = project.root / 'hardware-design/registry/cad-assets'
    lines: dict[tuple, dict] = {}
    for fp in geo['footprints']:
        pr = fp.get('props', {})
        attrs = fp.get('attrs', [])
        ref = fp['ref']
        if not ref or ref.startswith('#') or 'board_only' in attrs or 'exclude_from_bom' in attrs:
            continue
        lcsc = (pr.get('LCSC') or pr.get('JLC') or '').strip().upper()
        key = (pr.get('Value', ''), lcsc, pr.get('MPN', ''), fp['lib'], 'dnp' in attrs)
        line = lines.get(key)
        if line is None:
            sheet = sheets.get(lcsc)
            url = pr.get('Datasheet', '')
            line = lines[key] = {
                'refs': [], 'value': pr.get('Value', ''), 'lcsc': lcsc or None, 'mpn': pr.get('MPN') or None,
                'manufacturer': pr.get('Manufacturer') or None, 'footprint': fp['lib'],
                'description': pr.get('Description') or None, 'dnp': 'dnp' in attrs,
                'assembly': 'tht' if 'through_hole' in attrs else ('smd' if 'smd' in attrs else 'other'),
                'datasheet': sheet, 'datasheet_url': url if url.startswith('http') else None,
                'cad_asset': bool(lcsc) and (assets / lcsc).is_dir(),
                'stock_status': None, 'assembly_status': None,
            }
        line['refs'].append(ref)
        v = verified.get(ref)
        if v:
            line['stock_status'] = line['stock_status'] or (v.get('Stock status') or None)
            line['assembly_status'] = line['assembly_status'] or (v.get('Assembly status') or None)
    out = []
    for line in lines.values():
        line['refs'].sort(key=_natural)
        line['qty'] = len(line['refs'])
        out.append(line)
    out.sort(key=lambda l: _natural(l['refs'][0]))
    placed = [l for l in out if not l['dnp']]
    return {
        'pcb': pcb_rel,
        'lines': out,
        'summary': {
            'refs': sum(l['qty'] for l in out),
            'lines': len(out),
            'dnp_refs': sum(l['qty'] for l in out if l['dnp']),
            'missing_lcsc': sum(1 for l in placed if not l['lcsc']),
            'missing_datasheet': sum(1 for l in placed if not l['datasheet']),
            'missing_cad_asset': sum(1 for l in placed if l['lcsc'] and not l['cad_asset']),
        },
    }
