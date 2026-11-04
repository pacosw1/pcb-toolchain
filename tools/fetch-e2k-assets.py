#!/usr/bin/env python3
"""Capture JLC/EasyEDA CAD for C-numbers with easyeda2kicad (fallback when the EasyEDA Pro bridge of
tools/fetch-pq-bridge-assets.py is not running). Same output layout as the bridge captures:

  registry/cad-assets/<C>/<C>.kicad_sym, <C>.pretty/*.kicad_mod, <C>.3dshapes/*, PQ-BRIDGE-MANIFEST.json
  blocks/iot-lab.pretty/<C>.kicad_mod -> symlink to the captured footprint

Read only on the EasyEDA side (public component API through easyeda2kicad). Existing captures are kept.
Usage: python3 tools/fetch-e2k-assets.py C142526 C84681 ...
"""
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import project_root  # noqa: E402  (project root: --root/IOT_LAB/cwd; tools/project_root.py)
ROOT = project_root.root().resolve()
ASSETS = ROOT / 'hardware-design/registry/cad-assets'
PRETTY = ROOT / 'hardware-design/blocks/iot-lab.pretty'
E2K = os.environ.get('EASYEDA2KICAD', str(Path.home() / '.local/bin/easyeda2kicad'))


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def capture(code):
    if not re.fullmatch(r'C\d+', code):
        raise SystemExit(f'{code}: not an LCSC C-number')
    folder = ASSETS / code
    sym = folder / f'{code}.kicad_sym'
    if sym.exists():
        print(f'{code}: kept (already captured)')
    else:
        folder.mkdir(parents=True, exist_ok=True)
        p = subprocess.run([E2K, '--full', f'--lcsc_id={code}', '--output', str(folder / code)], capture_output=True, text=True)
        if p.returncode != 0 or not sym.exists():
            raise SystemExit(f'{code}: easyeda2kicad failed: {(p.stdout + p.stderr)[-400:]}')
    fps = sorted((folder / f'{code}.pretty').glob('*.kicad_mod'))
    if len(fps) != 1:
        raise SystemExit(f'{code}: expected one footprint, found {len(fps)}')
    text = sym.read_text()
    name = re.search(r'\(symbol "([^"]+)"', text).group(1)
    mpn = re.search(r'\(property "Value" "([^"]*)"', text)
    man = {
        'lcsc': code, 'mpn': mpn.group(1) if mpn else name, 'state': 'e2k-captured-candidate',
        'captured_at_utc': dt.datetime.now(dt.timezone.utc).isoformat(),
        'conversion': 'easyeda2kicad (uv tool, --full); no hand-drawn pin map',
        'symbol': {'file': sym.name, 'sha256': sha(sym)},
        'footprints': [{'file': f'{code}.pretty/{fps[0].name}', 'sha256': sha(fps[0])}],
        'models': [str(m.relative_to(folder)) for m in sorted((folder / f'{code}.3dshapes').glob('*'))] if (folder / f'{code}.3dshapes').exists() else [],
        'review': 'Pinout, ratings, land geometry, paste and orientation require verification against the datasheet.',
    }
    mf = folder / 'PQ-BRIDGE-MANIFEST.json'
    if not mf.exists():
        mf.write_text(json.dumps(man, indent=2) + '\n')
    link = PRETTY / f'{code}.kicad_mod'
    if not link.exists():
        link.symlink_to(os.path.relpath(fps[0], PRETTY))
    print(f'{code}: {man["mpn"]} symbol "{name}" footprint {fps[0].name}')


if __name__ == '__main__':
    for c in sys.argv[1:]:
        capture(c)
