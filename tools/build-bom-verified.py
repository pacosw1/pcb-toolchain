#!/usr/bin/env python3
"""BOM-VERIFIED.csv for a board from its native schematic + registry evidence (read only on JLC: tools/jlc_stock.mjs).

  python3 tools/build-bom-verified.py BOARD [--boards N]

1. kicad-cli netlist of the board schematic (gate.json / gate.pending.json names the project); one line per C-number
   (footprint iot-lab:<C>), DNP parts on their own line.
2. BOARD/BOM-JLC.csv (Designator, Value, LCSC Part #) -> tools/jlc_stock.mjs -> registry/evidence/<today>/<BOARD>-stock.json
   (class Basic / Extended, stock, sha256 of the response).
3. BOARD/BOM-VERIFIED.csv in the ESP32-CORE column set: manufacturer / MPN / package from the newest JLC snapshot
   (registry/evidence/*/*/<C>/<C>.json), datasheet = registry/datasheets/*<C>.pdf.
Stock is not reserved: recheck it on the order day. One line PASS / FAIL at the end (FAIL: a C-number without snapshot,
datasheet or stock record).
"""
import argparse
import csv
import datetime
import glob
import json
import os
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KCLI = os.environ.get('KICAD_CLI', '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'
                      if sys.platform == 'darwin' else 'kicad-cli')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('board')
    ap.add_argument('--boards', type=int, default=5)
    a = ap.parse_args()
    bdir = os.path.join(ROOT, 'hardware-design/boards', a.board)
    gate = next(json.load(open(p)) for p in (os.path.join(bdir, 'gate.json'), os.path.join(bdir, 'gate.pending.json')) if os.path.exists(p))
    sch = os.path.join(bdir, gate['project'] + '.kicad_sch')
    xml = os.path.join(tempfile.mkdtemp(), 'net.xml')
    subprocess.run([KCLI, 'sch', 'export', 'netlist', '--format', 'kicadxml', '-o', xml, sch], check=True, capture_output=True)
    lines = {}
    for c in ET.parse(xml).getroot().iter('comp'):
        ref, val, fp = c.get('ref'), (c.findtext('value') or ''), (c.findtext('footprint') or '')
        lcsc = fp.split(':')[-1] if fp.startswith('iot-lab:C') else ''
        dnp = any(p.get('name') == 'dnp' for p in c.iter('property'))
        if not lcsc:
            continue
        key = (lcsc, dnp)
        lines.setdefault(key, {'refs': [], 'value': val, 'desc': ''})['refs'].append(ref)
        for p in c.iter('property'):
            if p.get('name') == 'Description' and not lines[key]['desc']:
                lines[key]['desc'] = p.get('value', '')
    jlc = os.path.join(bdir, 'BOM-JLC.csv')
    with open(jlc, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['Comment', 'Designator', 'Footprint', 'LCSC Part #'])
        for (c, dnp), v in sorted(lines.items()):
            if not dnp:
                w.writerow([v['value'], ','.join(sorted(v['refs'])), c, c])
    day = datetime.date.today().isoformat()
    stock_out = os.path.join(ROOT, 'hardware-design/registry/evidence', day, f'{a.board}-stock.json')
    os.makedirs(os.path.dirname(stock_out), exist_ok=True)
    r = subprocess.run(['node', os.path.join(ROOT, 'tools/jlc_stock.mjs'), jlc, stock_out, '--boards', str(a.boards)],
                       capture_output=True, text=True)
    stock = json.load(open(stock_out)) if os.path.exists(stock_out) else {}
    parts = stock.get('parts', stock) if isinstance(stock, dict) else {}
    fails = []
    rows = []
    for (c, dnp), v in sorted(lines.items(), key=lambda kv: sorted(kv[1]['refs'])[0]):
        snaps = sorted(glob.glob(os.path.join(ROOT, 'hardware-design/registry/evidence/*/*', c, f'{c}.json')))
        pr = json.load(open(snaps[-1]))['purchase_record'] if snaps else {}
        ds = sorted(glob.glob(os.path.join(ROOT, 'hardware-design/registry/datasheets', f'*{c}.pdf')))
        st = parts.get(c, {}) if isinstance(parts, dict) else {}
        if not snaps:
            fails.append(f'{c}: no JLC snapshot')
        if not ds:
            fails.append(f'{c}: no datasheet')
        if not dnp and not st:
            fails.append(f'{c}: no stock record')
        rows.append([','.join(sorted(v['refs'])), v['desc'][:90], pr.get('componentModelEn', v['value']), c, pr.get('componentSpecificationEn', ''),
                     pr.get('componentBrandEn', ''), os.path.relpath(ds[0], bdir) if ds else '', st.get('class', ''),
                     f"stock {st.get('stock')} on {day} ({os.path.relpath(stock_out, os.path.join(ROOT, 'hardware-design'))}, not reserved)" if st else 'DNP' if dnp else 'no record',
                     'SMT' if 'Plugin' not in pr.get('componentSpecificationEn', '') else 'THT', '', 'DNP' if dnp else 'fit', ''])
    with open(os.path.join(bdir, 'BOM-VERIFIED.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['Designator', 'Function block', 'MPN/value', 'LCSC', 'Package', 'Manufacturer', 'Datasheet', 'JLC class', 'Stock status',
                    'PCBA type', 'Variant', 'Assembly status', 'Reviewer note'])
        w.writerows(rows)
    tail = (r.stdout.strip().splitlines() or [''])[-1]
    print(f"{'PASS' if not fails and r.returncode == 0 else 'FAIL'} {a.board}: {len(rows)} BOM lines, "
          f"{sum(len(v['refs']) for v in lines.values())} parts; jlc_stock: {tail[:160]}" + (f"; {'; '.join(fails[:6])}" if fails else ''))


if __name__ == '__main__':
    main()
