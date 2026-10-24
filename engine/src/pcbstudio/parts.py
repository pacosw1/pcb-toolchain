"""BOM and part evidence for a board revision, from its .kicad_pcb footprints plus the project registry. Read only.

A BOM line groups footprints with the same value, C-number, MPN and footprint. Joined per line:
- datasheet: the parts index (store/parts_index.py: file names, source.json, CAD manifests, components.json, BOM
  CSVs), else the footprint's Datasheet URL;
- CAD asset: `<cad_assets_dir>/<C-number>/` exists;
- evidence: the revision's own BOM CSV (its `bom` field; none = no stock/assembly evidence), by designator, after
  column normalisation (bomcsv.py). The CSV C-number is compared with the PCB C-number for every ref.
"""
from __future__ import annotations

import re

from . import bomcsv
from .kicad import board as kboard
from .model import Bom, BomLine, BomSource, BomSummary, BoardParts, PartPlacement
from .project import Project
from .store.parts_index import index_for

C_NUMBER_PROPS = ('LCSC', 'JLC', 'LCSC Part #', 'LCSC Part', 'JLCPCB Part #')


def footprint_c_number(props: dict[str, str]) -> str | None:
    """The one rule for a footprint's JLC/LCSC C-number: the first of C_NUMBER_PROPS (any case) that holds a
    C-number. Used by the BOM, board.parts and (through board.parts) the agent."""
    lower = {k.lower(): v for k, v in props.items()}
    for k in C_NUMBER_PROPS:
        c = bomcsv.c_number(props.get(k) if k in props else lower.get(k.lower()))
        if c:
            return c
    return None


def _natural(ref: str) -> tuple:
    return tuple(int(t) if t.isdigit() else t for t in re.split(r'(\d+)', ref))


def _in_bom(fp: dict) -> bool:
    ref, attrs = fp['ref'], fp.get('attrs', [])
    return bool(ref) and not ref.startswith('#') and 'board_only' not in attrs and 'exclude_from_bom' not in attrs


def bom(project: Project, pcb_rel: str, bom_csv: str | None = None) -> Bom:
    """`bom_csv` (project-relative) overrides the revision's own `bom` (for a what-if comparison)."""
    geo = kboard.load(project.resolve(pcb_rel))
    sheets = index_for(project).datasheets()
    hit = project.revision_for_pcb(pcb_rel)
    revision = hit[1] if hit else None
    csv_rel = bom_csv or (revision.bom if revision else None)
    source, verified = None, {}
    if csv_rel:
        b = bomcsv.read(project.resolve(csv_rel))
        verified = b.by_ref()
        source = BomSource(path=csv_rel, rows=len(b.rows), columns=b.columns, unknown_columns=b.unknown,
                           header_only=not b.rows)
    assets = project.path(project.layout.cad_assets_dir)
    lines: dict[tuple, BomLine] = {}
    seen: set[str] = set()
    for fp in geo['footprints']:
        if not _in_bom(fp):
            continue
        pr, attrs, ref = fp.get('props', {}), fp.get('attrs', []), fp['ref']
        seen.add(ref)
        lcsc = footprint_c_number(pr)
        key = (pr.get('Value', ''), lcsc, pr.get('MPN', ''), fp['lib'], 'dnp' in attrs)
        line = lines.get(key)
        if line is None:
            sheet = sheets.get(lcsc) if lcsc else None
            url = pr.get('Datasheet', '')
            line = lines[key] = BomLine(
                refs=[], qty=0, value=pr.get('Value', ''), lcsc=lcsc, mpn=pr.get('MPN') or None,
                manufacturer=pr.get('Manufacturer') or None, footprint=fp['lib'],
                description=pr.get('Description') or None, dnp='dnp' in attrs,
                assembly='tht' if 'through_hole' in attrs else ('smd' if 'smd' in attrs else 'other'),
                datasheet=sheet.path if sheet else None, datasheet_sha256=sheet.sha256 if sheet else None,
                datasheet_url=url if url.startswith('http') else None,
                cad_asset=bool(lcsc) and (assets / lcsc).is_dir(), stock_status=None, assembly_status=None)
        line.refs.append(ref)
        if source is None:
            continue
        v = verified.get(ref)
        if v is None:
            line.csv_missing_refs.append(ref)
            continue
        line.stock_status = line.stock_status or (v.get('stock_status') or None)
        line.assembly_status = line.assembly_status or (v.get('assembly_status') or None)
        csv_c = bomcsv.c_number(v.get('lcsc'))
        if csv_c and csv_c != lcsc:
            line.lcsc_mismatch_refs.append(ref)
            line.csv_lcsc = line.csv_lcsc or csv_c
        elif csv_c and line.csv_lcsc is None:
            line.csv_lcsc = csv_c
    out = []
    for line in lines.values():
        line.refs.sort(key=_natural)
        line.lcsc_mismatch_refs.sort(key=_natural)
        line.csv_missing_refs.sort(key=_natural)
        line.qty = len(line.refs)
        out.append(line)
    out.sort(key=lambda l: _natural(l.refs[0]))
    placed = [l for l in out if not l.dnp]
    csv_only = sorted(set(verified) - seen, key=_natural)
    return Bom(pcb=pcb_rel, revision=revision.revision if revision else None, source=source, csv_only_refs=csv_only,
               lines=out, summary=BomSummary(
                   refs=sum(l.qty for l in out), lines=len(out), dnp_refs=sum(l.qty for l in out if l.dnp),
                   missing_lcsc=sum(1 for l in placed if not l.lcsc),
                   missing_datasheet=sum(1 for l in placed if not l.datasheet),
                   missing_cad_asset=sum(1 for l in placed if l.lcsc and not l.cad_asset),
                   lcsc_mismatches=sum(len(l.lcsc_mismatch_refs) for l in out),
                   lines_with_mismatch=sum(1 for l in out if l.lcsc_mismatch_refs),
                   csv_missing_refs=sum(len(l.csv_missing_refs) for l in out),
                   csv_only_refs=len(csv_only)))


def board_parts(project: Project, pcb_rel: str) -> BoardParts:
    """Footprints of a board with the engine's C-number rule (the agent's board_parts tool)."""
    geo = kboard.load(project.resolve(pcb_rel))
    return BoardParts(pcb=pcb_rel, bbox=kboard.bbox(geo), tracks=len(geo['tracks']), vias=len(geo['vias']),
                      footprints=[PartPlacement(
                          ref=f['ref'], value=f.get('props', {}).get('Value'), lcsc=footprint_c_number(f.get('props', {})),
                          mpn=f.get('props', {}).get('MPN') or None, x=f['x'], y=f['y'], rot=f['rot'],
                          layer=f.get('layer', ''), pads=len(f['pads']), dnp='dnp' in f.get('attrs', []))
                          for f in geo['footprints'] if f['ref']])
