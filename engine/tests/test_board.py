"""Independent check: our pad positions and copper counts against KiCad's own pcbnew on real iot-lab boards."""
import json
import os
import subprocess
from pathlib import Path

import pytest

from pcbstudio.kicad import board

CORPUS = Path(os.environ.get('PCBSTUDIO_CORPUS', '/Users/pacosw/code/iot-lab'))
KICAD_PY = Path('/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3')
BOARDS = ['NET-NODE/cad/NET-NODE/NET-NODE.kicad_pcb', 'POE-ETHERNET/cad/POE-ETHERNET/POE-ETHERNET.kicad_pcb',
          'BASE-PWR/cad/BASE-PWR/BASE-PWR.kicad_pcb']

DUMP = r'''
import json, sys, pcbnew
b = pcbnew.LoadBoard(sys.argv[1]); mm = pcbnew.ToMM
pads = {}
for fp in b.GetFootprints():
    for p in fp.Pads():
        pads.setdefault(fp.GetReference() + '.' + p.GetNumber(), []).append([mm(p.GetPosition().x), mm(p.GetPosition().y)])
t = b.GetTracks()
print(json.dumps({'pads': pads,
                  'segments': sum(1 for x in t if x.GetClass() == 'PCB_TRACK'),
                  'arcs': sum(1 for x in t if x.GetClass() == 'PCB_ARC'),
                  'vias': sum(1 for x in t if x.GetClass() == 'PCB_VIA')}))
'''


def kicad_dump(path):
    r = subprocess.run([str(KICAD_PY), '-c', DUMP, str(path)], capture_output=True, text=True, timeout=300)
    return json.loads(r.stdout.strip().splitlines()[-1])


@pytest.mark.skipif(not KICAD_PY.exists() or not CORPUS.is_dir(), reason='KiCad Python or corpus missing')
@pytest.mark.parametrize('rel', BOARDS)
def test_pads_and_copper_match_pcbnew(rel):
    path = CORPUS / 'hardware-design/boards' / rel
    if not path.exists():
        pytest.skip(f'{rel} not in corpus')
    ref = kicad_dump(path)
    geo = board.load(path)
    ours = {}
    for fp in geo['footprints']:
        for p in fp['pads']:
            ours.setdefault(f"{fp['ref']}.{p['num']}", []).append([p['x'], p['y']])
    assert set(ours) == set(ref['pads'])
    worst = 0.0
    for key, pts in ref['pads'].items():
        for a, b_ in zip(sorted(pts), sorted(ours[key])):
            worst = max(worst, abs(a[0] - b_[0]), abs(a[1] - b_[1]))
    assert worst < 1e-3, f'max pad position error {worst} mm'
    n_arc_segments = len(geo['tracks']) - ref['segments']
    assert n_arc_segments == ref['arcs'] * 8           # arcs are drawn as 8 chords
    assert len(geo['vias']) == ref['vias']


@pytest.mark.skipif(not CORPUS.is_dir(), reason='corpus missing')
def test_outline_and_zones():
    paths = [CORPUS / 'hardware-design/boards' / rel for rel in BOARDS]
    path = next((p for p in paths if p.exists()), None)
    if path is None:
        pytest.skip('no reference board in corpus')
    geo = board.load(path)
    x0, y0, x1, y1 = board.bbox(geo)
    assert x1 - x0 > 20 and y1 - y0 > 20
    assert any(z['net'] and z['filled'] for z in geo['zones'])          # a filled copper pour
    assert any(z['rule_area'] for z in geo['zones'])                     # a keepout / rule area
