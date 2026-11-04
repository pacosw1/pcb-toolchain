#!/usr/bin/env python3
"""Read-only: get the EasyEDA 3D model STEP of an LCSC part through the EasyEDA bridge (web-app fetch).

Usage: python3 tools/easyeda-bridge-model.py C_NUMBER OUT.step (bridge at http://127.0.0.1:49620, EasyEDA tab connected).
It creates or changes nothing in the EasyEDA account: lib_Device.getByLcscIds and a fetch of the model file only.
"""
import sys, json, re, base64, hashlib, urllib.request
code, out = sys.argv[1], sys.argv[2]
def bridge(js):
    req = urllib.request.Request('http://127.0.0.1:49620/execute', data=json.dumps({'code': js}).encode(), headers={'Content-Type': 'application/json'})
    r = json.load(urllib.request.urlopen(req, timeout=300))
    assert r.get('success'), r
    return r['result']
dev = bridge(f'return await eda.lib_Device.getByLcscIds(["{code}"])')[0]
title = dev['model3DName']
import subprocess
s = json.dumps(json.loads(subprocess.run(['curl', '-s', '-f', '-m', '60', f'https://easyeda.com/api/products/{code}/components?version=6.4.19.5'], capture_output=True, check=True).stdout))
m = re.search(r'\\"uuid\\":\\"([0-9a-f]{32})\\",\\"c_etype\\":\\"outline3D\\",\\"id\\":\\"g1_outline\\",\\"title\\":\\"([^\\]+)\\"', s)
uuid, t2 = m.group(1), m.group(2)
assert t2 == title, (t2, title)
url = f'https://modules.easyeda.com/qAxj6KHrDKw4blvCG8QJPs7Y/{uuid}'
res = bridge(f'const r = await fetch("{url}"); const b = new Uint8Array(await r.arrayBuffer()); let s=""; for (let i=0;i<b.length;i+=32768) s+=String.fromCharCode.apply(null,b.subarray(i,i+32768)); return {{status:r.status, b64: btoa(s)}};')
assert res['status'] == 200, res['status']
data = base64.b64decode(res['b64'])
assert data[:13] == b'ISO-10303-21;', data[:20]
open(out, 'wb').write(data)
print(json.dumps({'lcsc': code, 'pro_device_uuid': dev['uuid'], 'pro_model_uuid': dev['model3DUuid'], 'model_title': title,
                  'transform': dev['otherProperty'].get('3D Model Transform'), 'step_uuid': uuid, 'url': url,
                  'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}))
