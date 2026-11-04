import os
from pathlib import Path

import pytest

from pcbstudio.kicad import board as kboard
from pcbstudio.model import Candidate, Geometry, RunSummary
from pcbstudio.model.tsgen import generate
from pcbstudio.runs import Run

GENERATED = Path(__file__).resolve().parents[2] / 'app/src/shared/generated.ts'
CORPUS = Path(os.environ.get('PCBSTUDIO_CORPUS', '/Users/pacosw/code/iot-lab'))
BOARDS = sorted(p.relative_to(CORPUS / 'hardware-design/boards').as_posix()
                for p in (CORPUS / 'hardware-design/boards').glob('*/cad/*/*.kicad_pcb')
                if p.parent.name != 'backups') if CORPUS.is_dir() else []
BOARD = '''(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
 (gr_rect (start 0 0) (end 20 10) (layer "Edge.Cuts") (width 0.1))
 (footprint "R" (layer "F.Cu") (at 5 5) (property "Reference" "R1") (property "LCSC" "C25804") (attr smd)
  (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (net "/A"))
  (pad "2" thru_hole circle (at 1 0) (size 1 1) (drill 0.5) (layers "*.Cu") (net "GND"))
  (pad "3" thru_hole oval (at 3 0) (size 1 2) (drill oval 0.5 1.2) (layers "*.Cu"))
  (pad "4" smd custom (at 0 2) (size 0.5 0.5) (layers "F.Cu") (options (anchor circle))
   (primitives (gr_poly (pts (xy 0 0) (xy 1 0) (xy 1 1)) (width 0) (fill yes))))
  (fp_line (start -2 -1) (end 2 -1) (layer "F.SilkS") (width 0.12)))
 (segment (start 0 0) (end 1 1) (width 0.2) (layer "F.Cu") (net "/A"))
 (via (at 1 1) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "/A"))
 (zone (net_name "GND") (layers "B.Cu") (name "") (polygon (pts (xy 0 0) (xy 1 0) (xy 1 1)))
  (filled_polygon (layer "B.Cu") (pts (xy 0 0) (xy 1 0) (xy 1 1))))
 (zone (net 0) (net_name "") (layers "F.Cu") (name "KO") (keepout (tracks not_allowed) (vias allowed) (pads allowed)
  (copperpour allowed) (footprints allowed)) (polygon (pts (xy 2 2) (xy 3 2) (xy 3 3)))))
'''


def test_generated_typescript_is_current():
    assert GENERATED.read_text() == generate(), 'stale: run `npm run types:gen` in app/'


def test_generated_typescript_shapes():
    ts = generate()
    assert 'export type Pt = [number, number]' in ts
    assert "  state: 'running' | 'passed' | 'failed' | 'error' | 'cancelled' | 'interrupted'\n" in ts
    assert '  bbox: [number, number, number, number]\n' in ts
    assert '  revisions: Revision[]\n' in ts and '  drill: number | null\n' in ts


def test_geometry_model_matches_parser(tmp_path):
    f = tmp_path / 'b.kicad_pcb'
    f.write_text(BOARD)
    geo = kboard.load(f)
    g = Geometry.model_validate({**geo, 'pcb': 'b.kicad_pcb', 'bbox': kboard.bbox(geo)})
    assert g.footprints[0].pads[1].drill == 0.5 and g.vias[0].layers == ['F.Cu', 'B.Cu'] and g.zones[0].filled
    pads = g.footprints[0].pads
    assert pads[2].drill_shape == 'oval' and pads[2].drill_h == 1.2
    assert pads[3].anchor == 'circle' and pads[3].prims and pads[3].prims[0].fill
    ko = g.zones[1]
    assert ko.rule_area and ko.keepout and ko.allow and not ko.allow.tracks and ko.polygons == [ko.outline]
    assert g.outline_open == 0 and any(gr.layer == 'F.SilkS' and gr.ref == 'R1' for gr in g.graphics)
    assert g.footprints[0].props['LCSC'] == 'C25804' and g.footprints[0].attrs == ['smd']


@pytest.mark.skipif(not BOARDS, reason='iot-lab corpus missing')
@pytest.mark.parametrize('rel', BOARDS)
def test_geometry_model_matches_parser_on_corpus(rel):
    """Every field the parser emits on a real board is in the model (extra='forbid' fails on an unknown one)."""
    p = CORPUS / 'hardware-design/boards' / rel
    geo = kboard.load(p)
    Geometry.model_validate({**geo, 'pcb': rel, 'bbox': kboard.bbox(geo)})


def test_run_models_match_runs_py():
    r = Run(id='1', board='B', mode='fresh', argv=[])
    RunSummary.model_validate(r.summary())
    c = {'pcb': 'x', 'target': None, 'exists': True, 'sha256': None, 'verified': True, 'identity_preserved': None,
         'metrics': {'drc_errors': 0}}
    Candidate.model_validate(c)
