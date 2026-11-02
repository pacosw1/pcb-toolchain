#!/usr/bin/env python3
"""Router result -> tracks and vias in a copy of the board, zones refilled, then KiCad DRC with parity.

  $PY tools/router/write.py BOARD.kicad_pcb RESULT.json OUT_DIR

Copies the project files next to BOARD (.kicad_pro, .kicad_dru, .kicad_sch, sym/fp-lib-table) into OUT_DIR, adds the
result to the board, refills every zone and saves OUT_DIR/<name>.kicad_pcb. pcbnew rewrites .kicad_pro on save with
defaults (memory: pcbnew-saveboard-overwrites-pro), so the original .kicad_pro is copied back after the save.
The input copper is not touched. Then runs kicad-cli pcb drc --schematic-parity and prints one line:
WRITE PASS|FAIL drc <errors by type> unconnected N parity N -> OUT.
"""
import collections
import glob
import hashlib
import json
import os
import shutil
import subprocess
import sys

import pcbnew

KICAD_CLI = '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'


def main():
    pcb, result, out_dir = sys.argv[1:4]
    os.makedirs(out_dir, exist_ok=True)
    src_dir = os.path.dirname(os.path.abspath(pcb))
    name = os.path.splitext(os.path.basename(pcb))[0]
    proj = None
    for f in glob.glob(os.path.join(src_dir, '*.kicad_pro')):
        proj = os.path.splitext(os.path.basename(f))[0]
    if proj is None:
        raise SystemExit('no .kicad_pro next to ' + pcb)
    for ext in ('.kicad_pro', '.kicad_dru', '.kicad_sch'):
        f = os.path.join(src_dir, proj + ext)
        if os.path.exists(f):
            shutil.copy(f, os.path.join(out_dir, proj + ext))
    for f in ('sym-lib-table', 'fp-lib-table'):
        if os.path.exists(os.path.join(src_dir, f)):
            shutil.copy(os.path.join(src_dir, f), out_dir)
    pro_keep = open(os.path.join(src_dir, proj + '.kicad_pro')).read()

    # v9 determinism: the KIIDs of the new items come from a generator seeded by the input board and the result bytes
    # (KiCad saves tracks sorted by KIID; random KIIDs gave a new item order in each file). A different input gives a
    # different sequence, so a re-route of a board that this tool wrote does not repeat the KIIDs already in it.
    h = hashlib.sha256(open(pcb, 'rb').read() + b'\0' + open(result, 'rb').read()).digest()
    pcbnew.KIID.SeedGenerator(int.from_bytes(h[:4], 'big'))
    b = pcbnew.LoadBoard(pcb)
    r = json.load(open(result))
    nets = b.GetNetsByName()
    lid = {b.GetLayerName(l): l for l in b.GetEnabledLayers().CuStack()}
    mm = pcbnew.FromMM
    for t in r['tracks']:
        tr = pcbnew.PCB_TRACK(b)
        tr.SetStart(pcbnew.VECTOR2I(mm(t['a'][0]), mm(t['a'][1])))
        tr.SetEnd(pcbnew.VECTOR2I(mm(t['b'][0]), mm(t['b'][1])))
        tr.SetWidth(mm(t['w']))
        tr.SetLayer(lid[t['layer']])
        tr.SetNet(nets[t['net']])
        b.Add(tr)
    for v in r['vias']:
        via = pcbnew.PCB_VIA(b)
        via.SetPosition(pcbnew.VECTOR2I(mm(v['x']), mm(v['y'])))
        via.SetWidth(mm(v['d']))
        via.SetDrill(mm(v['drill']))
        via.SetNet(nets[v['net']])
        b.Add(via)
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    out = os.path.join(out_dir, proj + '.kicad_pcb')
    b.Save(out)
    open(os.path.join(out_dir, proj + '.kicad_pro'), 'w').write(pro_keep)

    rep = os.path.join(out_dir, 'drc.json')
    subprocess.run([KICAD_CLI, 'pcb', 'drc', '--schematic-parity', '--format', 'json', '--severity-error',
                    '--output', rep, out], capture_output=True)
    d = json.load(open(rep))
    kinds = collections.Counter(v['type'] for v in d.get('violations', []))
    unc = len(d.get('unconnected_items', []))
    par = len(d.get('schematic_parity', []))
    ok = not kinds and unc == 0 and par == 0
    print(f"WRITE {'PASS' if ok else 'FAIL'} drc {sum(kinds.values())} {dict(kinds)} unconnected {unc} parity {par} -> {out}")
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
