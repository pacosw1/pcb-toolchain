import json
import os
from pathlib import Path

import pytest

from pcbstudio import bomcsv, parts
from pcbstudio.api import board_bom, board_parts, part_get, parts_index, project_open
from pcbstudio.model import Bom, BoardParts, PartRecord
from pcbstudio.project import Project
from pcbstudio.store.parts_index import PartsIndex

CORPUS = Path(os.environ.get('PCBSTUDIO_CORPUS', '/Users/pacosw/code/iot-lab'))
needs_corpus = pytest.mark.skipif(not CORPUS.is_dir(), reason='corpus missing')
B = 'hardware-design/boards/'
POE = B + 'POE-ETHERNET/cad/POE-ETHERNET/POE-ETHERNET.kicad_pcb'
BASE = {r: B + f'BASE-PWR/cad/{d}/{d}.kicad_pcb' for r, d in (('A', 'BASE-PWR'), ('B', 'BASE-PWR-B'), ('C', 'BASE-PWR-C'))}
PQ_A = B + 'PQ-METER/cad/PQ-METER/PQ-METER.kicad_pcb'
PQ_B = B + 'PQ-METER/cad/PQ-METER-B/PQ-METER-B.kicad_pcb'


def fp(ref, props):
    p = ''.join(f' (property "{k}" "{v}")' for k, v in props.items())
    return (f'(footprint "lib:R" (layer "F.Cu") (at 1 1) (property "Reference" "{ref}"){p} (attr smd)'
            f' (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "N")))')


def write(p: Path, text: str | bytes) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(text) if isinstance(text, bytes) else p.write_text(text)


@pytest.fixture
def small(tmp_path):
    root = tmp_path
    pcb = root / B / 'DEMO/cad/DEMO/DEMO.kicad_pcb'
    write(pcb, '(kicad_pcb (version 1) (gr_rect (start 0 0) (end 10 10) (layer "Edge.Cuts"))\n'
               + fp('R1', {'Value': '10k', 'LCSC': 'C1001'}) + fp('R2', {'Value': '10k', 'JLC': 'c1002'})
               + fp('R3', {'Value': '1k'}) + fp('U1', {'Value': 'IC', 'LCSC Part #': 'C1004'}) + ')')
    ds = root / 'hardware-design/registry/datasheets'
    write(ds / 'R10K_C1001.pdf', b'%PDF-1 a')
    write(ds / 'R10K-other.pdf', b'%PDF-1 b')                       # no C-number in the name
    write(ds / 'R10K-other.pdf.source.json', json.dumps({'catalog_url': 'https://jlcpcb.com/partdetail/X-Y/C1002',
                                                         'sha256': 'f' * 64}))
    write(ds / 'IC.pdf', b'%PDF-1 c')
    write(root / 'hardware-design/registry/cad-assets/C1004/MANIFEST.json',
          json.dumps({'lcsc': 'C1004', 'mpn': 'IC-1', 'footprint': {'datasheet': 'hardware-design/registry/datasheets/IC.pdf'}}))
    write(root / 'hardware-design/registry/components.json', json.dumps({'candidates': [
        {'lcsc': 'C1005', 'mpn': 'GONE', 'datasheet': 'datasheets/missing.pdf'}]}))
    write(root / B / 'DEMO/BOM-VERIFIED.csv',
          'Designator,LCSC,MPN/value,Stock observed,Observed UTC,Odd column\n'
          'R1,C1001,RC0603,5000,2026-10-01T00:00Z,x\nR2,C9999,RC0603,7,2026-10-01T00:00Z,y\nR9,C1001,,1,,\n')
    write(root / 'hardware-design/registry/boards.json', json.dumps({'boards': [{'id': 'DEMO', 'directory': 'DEMO',
        'revisions': [{'revision': 'A', 'state': 's', 'project': 'cad/DEMO/DEMO', 'bom': 'BOM-VERIFIED.csv'}]}]}))
    return root


def test_footprint_c_number():
    assert parts.footprint_c_number({'LCSC': ' c123 '}) == 'C123'
    assert parts.footprint_c_number({'JLC': 'C456'}) == 'C456'
    assert parts.footprint_c_number({'lcsc': 'C789'}) == 'C789'
    assert parts.footprint_c_number({'LCSC': 'n/a', 'JLC': 'C5000'}) == 'C5000'
    assert parts.footprint_c_number({'Value': '10k'}) is None


def test_csv_columns_normalised(tmp_path):
    f = tmp_path / 'b.csv'
    f.write_text('﻿Designator,LCSC Part #,Stock observed,Observed UTC,Assembly,Whatever\nC1 C2,C14663,12,2026Z,JLC SMT,1\n')
    b = bomcsv.read(f)
    assert b.columns == ['designator', 'lcsc', 'stock_status', 'stock_observed_utc', 'assembly_status']
    assert b.unknown == ['Whatever']
    assert b.by_ref()['C2'] == {'designator': 'C1 C2', 'lcsc': 'C14663', 'stock_status': 'stock 12 observed 2026Z',
                                'stock_observed_utc': '2026Z', 'assembly_status': 'JLC SMT'}
    f.write_text('Designator,LCSC\n')
    assert bomcsv.read(f).rows == []


def test_small_bom_index_and_mismatch(small):
    p = Project(small)
    bom = parts.bom(p, B + 'DEMO/cad/DEMO/DEMO.kicad_pcb')
    lines = {l.refs[0]: l for l in bom.lines}
    assert bom.revision == 'A' and bom.source.columns[:3] == ['designator', 'lcsc', 'mpn'] and not bom.source.header_only
    assert bom.source.unknown_columns == ['Odd column']
    assert lines['R1'].lcsc == 'C1001' and lines['R1'].stock_status == 'stock 5000 observed 2026-10-01T00:00Z'
    assert lines['R1'].datasheet.endswith('R10K_C1001.pdf') and len(lines['R1'].datasheet_sha256) == 64
    assert lines['R2'].lcsc == 'C1002' and lines['R2'].datasheet.endswith('R10K-other.pdf')   # via source.json
    assert lines['R2'].lcsc_mismatch_refs == ['R2'] and lines['R2'].csv_lcsc == 'C9999'
    assert lines['U1'].datasheet.endswith('IC.pdf') and lines['U1'].csv_missing_refs == ['U1']   # via cad manifest
    assert lines['R3'].lcsc is None and lines['R3'].datasheet is None
    s = bom.summary
    assert (s.lcsc_mismatches, s.lines_with_mismatch, s.csv_missing_refs, s.csv_only_refs) == (1, 1, 2, 1)
    assert bom.csv_only_refs == ['R9']

    idx = PartsIndex(p)
    st = idx.ensure()
    assert st.rebuilt is False                                  # bom() built it; inputs unchanged
    assert (st.pdfs, st.pdfs_c_in_name, st.pdfs_mapped) == (3, 1, 3)
    assert st.by_source['filename'] == 1 and st.by_source['source_json'] == 1 and st.by_source['cad_manifest'] == 1
    assert st.missing_paths == 1 and st.hash_mismatches == 1    # components.json path; source.json sha 'fff..'
    rec = idx.part('c1004')
    assert rec.mpn == 'IC-1' and rec.cad_asset == 'hardware-design/registry/cad-assets/C1004'
    assert rec.datasheet.sources == ['cad_manifest']
    assert idx.part('C1005').mpn == 'GONE' and idx.part('C1005').datasheet is None
    assert idx.part('C424242') is None
    # A changed input rebuilds; then the next call reuses it again.
    write(small / 'hardware-design/registry/datasheets/R1K_C1003.pdf', b'%PDF-1 d')
    st = idx.ensure()
    assert st.rebuilt and st.pdfs == 4
    assert idx.ensure().rebuilt is False


def test_api_methods_return_models(small):
    info = project_open(str(small))
    assert info['boards'][0]['revisions'][0]['bom'].endswith('BOM-VERIFIED.csv')
    pcb = info['boards'][0]['revisions'][0]['pcb']
    Bom.model_validate(board_bom(pcb))
    bp = BoardParts.model_validate(board_parts(pcb))
    assert {f.ref: f.lcsc for f in bp.footprints} == {'R1': 'C1001', 'R2': 'C1002', 'R3': None, 'U1': 'C1004'}
    PartRecord.model_validate(part_get('C1001'))
    assert parts_index()['pdfs'] == 3


@needs_corpus
def test_poe_bom_is_consistent():
    p = Project(CORPUS)
    b = parts.bom(p, POE)
    refs = [r for l in b.lines for r in l.refs]
    assert len(refs) == len(set(refs)) == b.summary.refs > 20
    assert all(l.qty == len(l.refs) for l in b.lines)
    # Mounting holes and other board-only footprints are not BOM lines.
    assert not any(r.startswith('H') and r[1:].isdigit() for r in refs)


@needs_corpus
def test_bom_is_per_revision():
    p = Project(CORPUS)
    for rev in 'AB':
        b = parts.bom(p, BASE[rev])
        assert b.source is None and not any(l.stock_status or l.assembly_status for l in b.lines), rev
    c = parts.bom(p, BASE['C'])
    assert c.source.path == B + 'BASE-PWR/BOM-VERIFIED.csv' and c.summary.lcsc_mismatches == 0
    assert sum(1 for l in c.lines if l.stock_status) > 50
    # PQ-METER: the CSV is rev A's (registry). Rev A joins it with 0 mismatches and reads 'Stock observed';
    # rev B has no CSV of its own, and joining rev A's CSV to it flags every changed C-number.
    a = parts.bom(p, PQ_A)
    assert a.source and a.summary.lcsc_mismatches == 0 and any(l.stock_status for l in a.lines)
    assert parts.bom(p, PQ_B).source is None
    wrong = parts.bom(p, PQ_B, bom_csv=B + 'PQ-METER/BOM-VERIFIED.csv')
    assert wrong.summary.lcsc_mismatches == 90 and wrong.summary.lines_with_mismatch > 30


@needs_corpus
def test_corpus_datasheet_index():
    p = Project(CORPUS)
    idx = PartsIndex(p)
    st = idx.ensure()
    assert st.pdfs > 500 and st.pdfs_mapped > st.pdfs_c_in_name
    assert idx.ensure().rebuilt is False
    sheets = idx.datasheets()
    assert len(sheets) == st.c_numbers
    for c, ref in sheets.items():
        assert (CORPUS / ref.path).is_file(), (c, ref.path)
