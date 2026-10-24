import os
from pathlib import Path

import pytest

from pcbstudio import parts
from pcbstudio.project import Project

CORPUS = Path(os.environ.get('PCBSTUDIO_CORPUS', '/Users/pacosw/code/iot-lab'))
POE = 'hardware-design/boards/POE-ETHERNET/cad/POE-ETHERNET/POE-ETHERNET.kicad_pcb'


@pytest.mark.skipif(not (CORPUS / POE).exists(), reason='corpus missing')
def test_poe_bom_is_consistent():
    p = Project(CORPUS)
    b = parts.bom(p, POE)
    refs = [r for l in b['lines'] for r in l['refs']]
    assert len(refs) == len(set(refs)) == b['summary']['refs'] > 20
    assert all(l['qty'] == len(l['refs']) for l in b['lines'])
    for l in b['lines']:
        if l['datasheet']:
            assert (p.root / l['datasheet']).is_file()
            assert l['lcsc'] and l['lcsc'] in l['datasheet'].upper()
    # Mounting holes and other board-only footprints are not BOM lines.
    assert not any(r.startswith('H') and r[1:].isdigit() for r in refs)
