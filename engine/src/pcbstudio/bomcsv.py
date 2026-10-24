"""BOM evidence CSVs (BOM-VERIFIED.csv and friends) with normalised column names.

Board CSVs name the same thing in different ways ('Stock status' / 'Stock observed', 'LCSC' / 'LCSC Part #',
'MPN/value' / 'MPN'). Each header is normalised (lower case, non-alphanumerics to '_') and mapped to one canonical
name; headers with no mapping are reported, not guessed.
"""
from __future__ import annotations

import csv
import re
from dataclasses import dataclass, field
from pathlib import Path

ALIASES: dict[str, tuple[str, ...]] = {
    'designator': ('designator', 'designators', 'ref', 'refs', 'reference', 'references'),
    'lcsc': ('lcsc', 'lcsc_part', 'lcsc_part_number', 'lcsc_part_no', 'jlc', 'jlc_part', 'jlcpcb_part', 'c_number'),
    'mpn': ('mpn', 'mpn_value', 'part_number', 'manufacturer_part', 'manufacturer_part_number'),
    'manufacturer': ('manufacturer', 'mfr'),
    'value': ('value', 'comment'),
    'footprint': ('footprint',),
    'package': ('package',),
    'qty': ('qty', 'quantity'),
    'function_block': ('function_block',),
    'datasheet': ('datasheet',),
    'datasheet_sha256': ('datasheet_sha256',),
    'stock_status': ('stock_status', 'stock', 'stock_observed'),
    'stock_observed_utc': ('observed_utc', 'stock_observed_utc'),
    'assembly_status': ('assembly_status', 'assembly'),
    'jlc_class': ('jlc_class',),
    'pcba_type': ('pcba_type',),
    'variant': ('variant', 'population'),
    'evidence': ('evidence',),
    'reviewer_note': ('reviewer_note', 'note', 'notes'),
    'selection_state': ('selection_state',),
}
_CANON = {alias: canon for canon, names in ALIASES.items() for alias in names}
C_NUMBER = re.compile(r'^C\d{3,}$')


def normalise(header: str) -> str:
    return re.sub(r'[^a-z0-9]+', '_', header.strip().lower()).strip('_')


def c_number(raw: str | None) -> str | None:
    v = (raw or '').strip().upper()
    return v if C_NUMBER.match(v) else None


@dataclass
class BomCsv:
    path: Path
    columns: list[str] = field(default_factory=list)          # canonical names found
    unknown: list[str] = field(default_factory=list)          # original headers with no mapping
    rows: list[dict[str, str]] = field(default_factory=list)  # canonical name -> value

    def by_ref(self) -> dict[str, dict[str, str]]:
        out: dict[str, dict[str, str]] = {}
        for row in self.rows:
            for ref in re.split(r'[,\s]+', row.get('designator') or ''):
                if ref:
                    out[ref] = row
        return out


def read(path: Path) -> BomCsv:
    out = BomCsv(path=path)
    with path.open(newline='', encoding='utf-8-sig', errors='replace') as fh:
        reader = csv.reader(fh)
        header = next(reader, [])
        mapping: list[str | None] = []
        for h in header:
            canon = _CANON.get(normalise(h))
            if canon is None or canon in out.columns:     # first column wins on a duplicate meaning
                if h.strip():
                    out.unknown.append(h)
                mapping.append(None)
            else:
                out.columns.append(canon)
                mapping.append(canon)
        for raw in reader:
            if not any(c.strip() for c in raw):
                continue
            row = {canon: (raw[i].strip() if i < len(raw) else '') for i, canon in enumerate(mapping) if canon}
            stock, utc = row.get('stock_status'), row.get('stock_observed_utc')
            if stock and utc and stock.replace(',', '').isdigit():
                row['stock_status'] = f'stock {stock} observed {utc}'
            out.rows.append(row)
    return out
