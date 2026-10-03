#!/usr/bin/env python3
"""Capture supplier CAD through the connected EasyEDA Pro bridge, then convert locally.

Read-only in EasyEDA: metadata, public source fetches and model downloads only.
Never creates an EasyEDA project or library. Existing captures are reused.
Usage: python3 tools/fetch-pq-bridge-assets.py C432212 C2671345 ...
"""
import argparse
import base64
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'hardware-design/registry/cad-assets'
BRIDGE = 'http://127.0.0.1:49620/execute'
CONVERTER_PY = '/Library/Developer/CommandLineTools/usr/bin/python3'


def bridge(code):
    request = urllib.request.Request(BRIDGE, data=json.dumps({'code': code}).encode(),
                                     headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=55) as response:
        result = json.load(response)
    if not result.get('success'):
        raise RuntimeError(result.get('error', 'bridge failure'))
    return result.get('result')


def fetch_bytes(url):
    value = bridge('const r=await fetch(' + json.dumps(url) + ');'
                   'const a=new Uint8Array(await r.arrayBuffer());let s="";'
                   'for(let i=0;i<a.length;i+=32768)'
                   's+=String.fromCharCode.apply(null,a.subarray(i,i+32768));'
                   'return {status:r.status,b64:btoa(s)};')
    if value['status'] != 200:
        raise RuntimeError(f'HTTP {value["status"]}: {url}')
    return base64.b64decode(value['b64'])


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def capture(code):
    if not re.fullmatch(r'C\d+', code):
        raise ValueError('Expected exact LCSC C-number')
    folder = ASSETS / code
    folder.mkdir(parents=True, exist_ok=True)
    dev_path = folder / 'bridge-device.json'
    if dev_path.exists():
        device = json.loads(dev_path.read_text())
    else:
        devices = bridge('return await eda.lib_Device.getByLcscIds([' + json.dumps(code) + ']);')
        device = next(d for d in devices if d.get('supplierId') == code)
        dev_path.write_text(json.dumps(device, ensure_ascii=False, indent=2) + '\n')
    source = folder / 'easyeda-bridge-source.json'
    source_url = f'https://easyeda.com/api/products/{code}/components?version=6.4.19.5'
    if not source.exists():
        raw = fetch_bytes(source_url)
        data = json.loads(raw)
        if not data.get('success') or not data.get('result'):
            raise RuntimeError(f'{code}: source has no CAD result')
        source.write_bytes(raw)
    data = json.loads(source.read_bytes())['result']
    if data.get('title') != device.get('manufacturerId'):
        # Exact supplier identity remains mandatory; aliases must be reviewed manually.
        supplier = data.get('lcsc') or data.get('szlcsc') or {}
        if str(supplier.get('number', supplier.get('id', ''))) != code:
            raise RuntimeError(f'{code}: title/identity mismatch: {data.get("title")} vs {device.get("manufacturerId")}')
    output = folder / f'{code}.kicad_sym'
    if not output.exists():
        program = ('import json\nfrom easyeda2kicad.easyeda.easyeda_api import EasyedaApi\n'
                   'from easyeda2kicad.__main__ import main\n'
                   f'source=json.load(open({str(source)!r}))["result"]\n'
                   'EasyedaApi.get_cad_data_of_component=lambda self,lcsc_id: source\n'
                   f'raise SystemExit(main({["--lcsc_id", code, "--symbol", "--footprint", "--output", str(output)]!r}))\n')
        run = subprocess.run([CONVERTER_PY, '-c', program], capture_output=True, text=True)
        if run.returncode:
            raise RuntimeError(run.stderr[-1500:])
    model = None
    model_error = None
    shapes = data.get('packageDetail', {}).get('dataStr', {}).get('shape', [])
    for shape in shapes:
        if not shape.startswith('SVGNODE~'):
            continue
        node = json.loads(shape.split('~', 1)[1])
        attrs = node.get('attrs', {})
        if attrs.get('c_etype') != 'outline3D':
            continue
        title = attrs['title']
        if '/' in title or '\\' in title or '..' in title:
            raise ValueError('Unsafe model title')
        model_path = folder / f'{code}.3dshapes' / f'{title}.step'
        model_url = f'https://modules.easyeda.com/qAxj6KHrDKw4blvCG8QJPs7Y/{attrs["uuid"]}'
        if not model_path.exists():
            try:
                raw = fetch_bytes(model_url)
                if not raw.startswith(b'ISO-10303-21;'):
                    raise RuntimeError('Model response is not STEP')
                model_path.parent.mkdir(parents=True, exist_ok=True)
                model_path.write_bytes(raw)
            except Exception as error:
                model_error = str(error)
                break
        model = {'file': str(model_path.relative_to(folder)), 'source_url': model_url,
                 'sha256': digest(model_path), 'transform': device.get('otherProperty', {}).get('3D Model Transform')}
        break
    manifest = {'lcsc': code, 'mpn': device.get('manufacturerId'), 'state': 'bridge-captured-candidate',
                'captured_at_utc': dt.datetime.now(dt.timezone.utc).isoformat(),
                'source_url': source_url, 'source_sha256': digest(source),
                'pro_device_uuid': device['uuid'],
                'pro_symbol_uuid': device.get('symbolUuid') or device.get('otherProperty', {}).get('Symbol'),
                'pro_footprint_uuid': device.get('footprintUuid'),
                'conversion': 'easyeda2kicad 0.8.0, offline source injection; no hand-drawn pin map',
                'symbol': {'file': output.name, 'sha256': digest(output)},
                'footprints': [{'file': str(p.relative_to(folder)), 'sha256': digest(p)}
                               for p in sorted((folder / f'{code}.pretty').glob('*.kicad_mod'))],
                'model': model, 'model_error': model_error,
                'review': 'Pinout, ratings, land geometry, paste, and placement orientation require verification.'}
    (folder / 'PQ-BRIDGE-MANIFEST.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return {'lcsc': code, 'mpn': manifest['mpn'], 'symbol': output.name,
            'footprints': len(manifest['footprints']), 'step': bool(model)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('codes', nargs='+')
    args = parser.parse_args()
    for code in args.codes:
        try:
            print(json.dumps(capture(code)), flush=True)
        except Exception as error:
            print(json.dumps({'lcsc': code, 'error': str(error)}), flush=True)
            raise
