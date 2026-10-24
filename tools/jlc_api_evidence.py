#!/usr/bin/env python3
"""Save JLC parts-API evidence per C-number (read only: no login, no cart), the format the schematic generators read:
registry/evidence/<date>/<C>.api.json = {fetched_at_utc, source_url, request, response_sha256, record}.
Usage: python3 tools/jlc_api_evidence.py C123 C456 ...   (existing files are kept)"""
import datetime, glob, hashlib, json, os, subprocess, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EV = os.path.join(ROOT, 'hardware-design/registry/evidence')
URL = 'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList'
day = datetime.date.today().isoformat()
for c in sys.argv[1:]:
    if glob.glob(os.path.join(EV, '*', c + '.api.json')):
        print(f'{c}: kept'); continue
    req = {'keyword': c, 'currentPage': 1, 'pageSize': 10}
    raw = subprocess.run(['curl', '-s', '-f', '-m', '30', '-X', 'POST', URL, '-H', 'Content-Type: application/json',
                          '-d', json.dumps(req)], capture_output=True, check=True).stdout
    lst = (((json.loads(raw).get('data') or {}).get('componentPageInfo') or {}).get('list')) or []
    rec = next((r for r in lst if r.get('componentCode') == c), None)
    if rec is None:
        raise SystemExit(f'{c}: not in the JLC parts API')
    os.makedirs(os.path.join(EV, day), exist_ok=True)
    out = {'fetched_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'source_url': URL, 'request': req,
           'response_sha256': hashlib.sha256(raw).hexdigest(), 'record': rec}
    json.dump(out, open(os.path.join(EV, day, c + '.api.json'), 'w'), indent=1)
    print(f"{c}: {rec.get('componentModelEn')} stock {rec.get('stockCount')} {rec.get('componentLibraryType')}")
