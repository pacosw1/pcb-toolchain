#!/usr/bin/env python3
"""Datasheet identity check for the active parts of a board BOM (no network).

  python3 tools/datasheet_audit.py <BOARD> [--json OUT] [--prefixes U,Q,D,Y,K,F]

For each BOM line (cad/fab/<BOARD>-BOM-JLC.csv) with a designator of the listed prefixes: the datasheet files in
hardware-design/registry/datasheets/ for that C-number (file name *_<C>.pdf, or a .source.json whose catalog_url or
catalog_snapshot names the C-number), their text (tools/pdftext.swift, macOS PDFKit), and:
  MPN      the manufacturer part number (EasyEDA record of the C-number) or its longest prefix (>= 5 characters,
           letters and digits only) is in the text;
  PACKAGE  the package family of the EasyEDA footprint (SOT-23, SOIC, SMA, ...) is in the text.
Status: OK (full MPN and package), CORE (MPN prefix and package: a family datasheet; read the ordering table),
NO_PACKAGE (MPN found, package not), WRONG (MPN not in the text), IMAGE (no text: read it by eye), MISSING.
Exit 1 on WRONG or MISSING. A person reads CORE, NO_PACKAGE and IMAGE.
"""
import argparse
import csv
import glob
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REG = os.path.join(ROOT, 'hardware-design', 'registry')
DS = os.path.join(REG, 'datasheets')
PDFTEXT = os.path.expanduser('~/.cache/iot-lab/pdftext')
PKG = ['SOT-23', 'SOT-223', 'SOT-89', 'SOT-323', 'SOT-363', 'SOT-563', 'SOIC', 'SOP', 'SSOP', 'TSSOP', 'HTSSOP', 'MSOP',
       'HSOP', 'QFN', 'VQFN', 'DFN', 'SON', 'WSON', 'VSON', 'LQFP', 'TQFP', 'SMA', 'SMB', 'SMC', 'SMAF', 'SOD-123',
       'SOD-123F', 'SOD-323', 'SOD-523', 'TO-252', 'TO-263', 'DPAK', 'SO-8FL', 'DFN5', 'SC-70', 'SC-88', 'UDFN', 'LGA',
       '0402', '0603', '0805', '1206', '1210', '1812', '2920']


def pdftext(path, cache={}):
    if path in cache:
        return cache[path]
    if not os.path.exists(PDFTEXT):
        os.makedirs(os.path.dirname(PDFTEXT), exist_ok=True)
        subprocess.run(['swiftc', '-O', os.path.join(ROOT, 'tools', 'pdftext.swift'), '-o', PDFTEXT], check=True)
    p = subprocess.run([PDFTEXT, path], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    cache[path] = p.stdout.decode('utf-8', 'replace')
    return cache[path]


def norm(s):
    return re.sub(r'[^A-Z0-9]', '', (s or '').upper())


def files_for(code, mpn=''):
    out = set(glob.glob(os.path.join(DS, f'*_{code}.pdf')))
    m = norm(mpn)
    if len(m) >= 4:  # a file named for the part (W5500.pdf, DP1435-5V.pdf), not yet linked to the C-number
        for f in glob.glob(os.path.join(DS, '*.pdf')):
            fn = norm(os.path.basename(f)[:-4])
            if fn and (fn.startswith(m) or m.startswith(fn)) and len(fn) >= min(len(m), 4):
                out.add(f)
    for sj in glob.glob(os.path.join(DS, '*.pdf.source.json')):
        try:
            d = json.load(open(sj))
        except Exception:
            continue
        if any(str(d.get(k, '')).rstrip('/').endswith(code) or f'/{code}.' in str(d.get(k, '')) for k in ('catalog_url', 'catalog_snapshot')):
            out.add(sj[:-len('.source.json')])
    return sorted(f for f in out if os.path.exists(f))


def easyeda(code):
    p = os.path.join(REG, 'cad-assets', code, 'easyeda-bridge-source.json')
    if not os.path.exists(p):
        return '', ''
    r = json.load(open(p))['result']
    cp = r['dataStr']['head'].get('c_para', {})
    return cp.get('Manufacturer Part') or r.get('title', ''), cp.get('package') or r.get('packageDetail', {}).get('title', '')


def package_family(pkg):
    u = pkg.upper()
    hits = [p for p in PKG if u.startswith(p) or u.startswith(p.replace('-', ''))]
    return max(hits, key=len) if hits else (re.split(r'[-_]', u)[0] if u else '')


def check(code, mpn, pkg):
    files = files_for(code, mpn)
    if not files:
        return 'MISSING', '', ''
    fam = package_family(pkg)
    best = ('WRONG', '', os.path.basename(files[0]))
    rank = {'OK': 5, 'CORE': 4, 'NO_PACKAGE': 3, 'IMAGE': 2, 'WRONG': 1}
    for f in files:
        t = pdftext(f)
        tn = norm(t)
        if len(tn) < 200:
            st = ('IMAGE', 'no text layer', os.path.basename(f))
        else:
            m = norm(mpn)
            hit = ''
            for n in range(len(m), min(len(m), 5) - 1, -1):
                if m[:n] in tn:
                    hit = m[:n]
                    break
            if not hit:
                st = ('WRONG', f'MPN {mpn} not in text', os.path.basename(f))
            else:
                has_pkg = bool(fam) and norm(fam) in tn
                full = hit == m
                if full and has_pkg:
                    st = ('OK', f'{mpn}; package {fam}', os.path.basename(f))
                elif has_pkg:
                    st = ('CORE', f'prefix {hit} of {mpn}; package {fam}', os.path.basename(f))
                else:
                    st = ('NO_PACKAGE', f'{"MPN" if full else "prefix " + hit}; package {fam or pkg} not in text', os.path.basename(f))
        if rank[st[0]] > rank[best[0]]:
            best = st
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('board')
    ap.add_argument('--json')
    ap.add_argument('--prefixes', default='U,Q,D,Y,K,F')
    a = ap.parse_args()
    pre = tuple(a.prefixes.split(','))
    bd = os.path.join(ROOT, 'hardware-design', 'boards', a.board)
    stem = os.path.basename(json.load(open(os.path.join(bd, 'gate.json')))['project'])
    rows = list(csv.DictReader(open(os.path.join(bd, 'cad', 'fab', f'{stem}-BOM-JLC.csv'))))
    res = []
    for r in rows:
        refs = [x.strip() for x in r['Designator'].split(',') if x.strip()]
        act = [x for x in refs if re.match(r'^(%s)\d' % '|'.join(pre), x)]
        if not act:
            continue
        code = r['LCSC Part #'].strip()
        mpn, pkg = easyeda(code)
        st, note, f = check(code, mpn, pkg)
        res.append({'refs': ','.join(act), 'code': code, 'mpn': mpn, 'package': pkg, 'status': st, 'note': note, 'file': f})
    cnt = {}
    for x in res:
        cnt[x['status']] = cnt.get(x['status'], 0) + 1
    print(f'datasheet_audit {a.board}: {len(res)} active part types; ' + ', '.join(f'{k} {v}' for k, v in sorted(cnt.items())))
    for x in res:
        if x['status'] != 'OK':
            print(f"  {x['status']:10} {x['refs'][:18]:18} {x['code']:10} {x['mpn'][:24]:24} {x['note'][:70]} [{x['file'][:40]}]")
    if a.json:
        json.dump(res, open(a.json, 'w'), indent=1)
    sys.exit(1 if any(x['status'] in ('WRONG', 'MISSING') for x in res) else 0)


if __name__ == '__main__':
    main()
