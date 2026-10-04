#!/usr/bin/env python3
"""JLC assembly stock and class for each part of a JLC BOM (read only: no login, no cart, no order).

  python3 tools/jlc_stock.py BOM-JLC.csv OUT.json [--boards 5] [--min-margin 10]

For each LCSC code of the BOM (column "LCSC Part #"): the public JLC SMT parts search
(POST https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList, keyword = C-number),
the record whose componentCode is the C-number. Saved per part: model, class (Basic / Extended), stock, price tiers,
refs, quantity per board and the sha256 of the response (the same format as registry/evidence/2026-09-27/BASE-PWR-stock.json).
Prints the lowest stocks and FAIL lines: a code with no exact record, or stock below qty x boards x --min-margin.
Exit 1 on a FAIL. Stock is not reserved: run it again on the day of the order.
"""
import argparse
import csv
import datetime
import hashlib
import json
import subprocess
import sys
import time

URL = 'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList'


def fetch(code):
    body = json.dumps({'keyword': code, 'currentPage': 1, 'pageSize': 10, 'searchSource': 'search'})
    for attempt in range(4):
        p = subprocess.run(['curl', '-s', '-f', '-m', '30', '-X', 'POST', URL, '-H', 'Content-Type: application/json', '-d', body],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if p.returncode == 0 and p.stdout:
            return p.stdout
        time.sleep(2 ** (attempt + 1))
    raise RuntimeError(f'{code}: no response from JLC ({p.stderr.decode()[:120]})')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('bom')
    ap.add_argument('out')
    ap.add_argument('--boards', type=int, default=5)
    ap.add_argument('--min-margin', type=int, default=10)
    a = ap.parse_args()
    lines = list(csv.DictReader(open(a.bom)))
    by_code = {}  # one code can be on more lines (same part, other Value text): add the refs
    for r in lines:
        e = by_code.setdefault(r['LCSC Part #'].strip(), {'Comment': r['Comment'], 'refs': []})
        e['refs'] += [x.strip() for x in r['Designator'].split(',') if x.strip()]
    parts, fails = {}, []
    for code, e in by_code.items():
        r = {'Comment': e['Comment']}
        refs = e['refs']
        raw = fetch(code)
        doc = json.loads(raw)
        lst = ((doc.get('data') or {}).get('componentPageInfo') or {}).get('list') or []
        rec = next((x for x in lst if x.get('componentCode') == code), None)
        if rec is None:
            fails.append(f'FAIL {code} ({r["Comment"]}): no exact catalog record')
            continue
        cls = {'base': 'Basic', 'expand': 'Extended'}.get(rec.get('componentLibraryType'), rec.get('componentLibraryType'))
        if rec.get('preferredComponentFlag'):
            cls = 'Preferred'
        parts[code] = {'model': rec.get('componentModelEn'), 'class': cls, 'stock': rec.get('stockCount'),
                       'prices': [{k: pr.get(k) for k in ('startNumber', 'endNumber', 'productPrice')} for pr in rec.get('componentPrices') or []],
                       'refs': ','.join(refs), 'qty': len(refs), 'response_sha256': hashlib.sha256(raw).hexdigest()}
        need = len(refs) * a.boards * a.min_margin
        if (rec.get('stockCount') or 0) < need:
            fails.append(f'FAIL {code} {rec.get("componentModelEn")}: stock {rec.get("stockCount")} < {need} '
                         f'(qty {len(refs)} x {a.boards} boards x margin {a.min_margin})')
        time.sleep(0.3)
    out = {'fetched_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'source_url': URL,
           'bom': a.bom, 'boards': a.boards, 'parts': parts}
    json.dump(out, open(a.out, 'w'), indent=2)
    unit = sum(v['qty'] * (v['prices'][0]['productPrice'] if v['prices'] else 0) for v in parts.values())
    ext = sorted({c for c, v in parts.items() if v['class'] == 'Extended'})
    print(f'jlc_stock: {len(parts)} of {len(by_code)} codes found ({len(lines)} BOM lines, {sum(len(e["refs"]) for e in by_code.values())} parts); Extended types {len(ext)}; '
          f'parts per board at the first price tier {unit:.2f} USD')
    for c, v in sorted(parts.items(), key=lambda kv: kv[1]['stock'] or 0)[:6]:
        print(f'  lowest: {c} {v["model"]} ({v["refs"]}) {v["class"]} stock {v["stock"]}')
    for f in fails:
        print(f)
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
