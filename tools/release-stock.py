#!/usr/bin/env python3
"""Read-only JLC assembly availability for an exact fabrication candidate.

Save original responses and source/time/hash attribution. No login, cart, order
or supplier contact. Quantities cover N boards of any one population; mixed
population totals must be planned separately. No arbitrary stock margin.
"""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import sys
import urllib.request

URL = 'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('candidate', type=Path)
    parser.add_argument('out', type=Path)
    parser.add_argument('--boards', required=True, type=int)
    args = parser.parse_args()
    if args.boards <= 0:
        raise ValueError('--boards must be positive')
    manifest_bytes = (args.candidate / 'release-manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    if manifest.get('schema_version') != 1 or manifest.get('scope') != 'cad_fabrication_candidate':
        raise ValueError('verified fabrication candidate required')
    args.out.mkdir()  # Refuse existing output; original receipts are immutable.
    required = {}
    for population in manifest['assembly']['populations'].values():
        codes = list(population['references'].values())
        for code in set(codes):
            if not code.startswith('C') or not code[1:].isdigit():
                raise ValueError('invalid exact LCSC code')
            required[code] = max(required.get(code, 0), codes.count(code) * args.boards)
    if not required:
        raise ValueError('candidate contains no fitted parts')
    day = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
    receipt = dict(schema_version=1, board=manifest['board'], candidate_sha256=hashlib.sha256(manifest_bytes).hexdigest(),
                   source_url=URL, order_day_utc=day, boards=args.boards, parts={})
    failures = []
    for code, quantity in sorted(required.items()):
        print('START: assembly stock ' + code, flush=True)
        body = json.dumps(dict(keyword=code, currentPage=1, pageSize=10, searchSource='search')).encode()
        request = urllib.request.Request(URL, data=body, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
        fetched = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (args.out / (code + '.json')).write_bytes(raw)
        receipt['parts'][code] = dict(required=quantity, fetched_at_utc=fetched, response=code+'.json',
                                      response_sha256=hashlib.sha256(raw).hexdigest())
        rows = ((json.loads(raw).get('data') or {}).get('componentPageInfo') or {}).get('list') or []
        matches = [row for row in rows if row.get('componentCode') == code]
        count = matches[0].get('stockCount') if len(matches) == 1 else None
        if not isinstance(count, int) or count < quantity or fetched[:10] != day:
            failures.append(code)
        print(('PASS' if code not in failures else 'FAIL') + ': ' + code + ' assembly stock=' + str(count) + ' required=' + str(quantity), flush=True)
    (args.out / 'stock.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(('FAIL: unavailable or stale assembly stock: ' + ', '.join(failures)) if failures else 'PASS: original JLC stock receipts saved; stock is not reserved')
    return bool(failures)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print('FAIL: assembly stock: ' + str(error), file=sys.stderr)
        raise SystemExit(2)
