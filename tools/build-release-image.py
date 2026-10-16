#!/usr/bin/env python3
"""Build the bounded, pinned Gerber-capable derivative on the existing executor.

python3 tools/build-release-image.py NEW_RUN_DIR [--tag TAG]
Downloads unmodified, hash-pinned original wheels once; Docker install is offline.
The default native base ID is the existing image built by .cip/native.Dockerfile.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request

BASE = 'sha256:d7909a97456e89bef202e49c6c3c40bb14b6060a45f6559e08f3c3dc7e000fcf'
BASE_ALIAS = 'iot-lab-release-base:d7909a97456e'
# pip21.2.4 in the old local venv predates Python3.13. This bootstrap wheel is
# used only as an installer; it is not added to the native/system runtime.
WHEELS = [
 ('pip-25.0.1-py3-none-any.whl','c46efd13b6aa8279f33f2864459c8ce587ea6a1a59ee20de055868d8f7688f7f','c9/bc/b7db44f5f39f9d0494071bddae6880eb645970366d0a200022a1a93d57f5'),
 ('gerbonara-0.13.0-py3-none-any.whl','7b79b1c1caa667bd1557f9131e690f2cd5c6898131c991c21458bbe520a9431e','84/ce/1b38df83f7ac315de81f9cdc5cff7cb0ba3cabd9aaa86f505ccd47125aec'),
 ('shapely-2.0.7-cp313-cp313-manylinux_2_17_x86_64.manylinux2014_x86_64.whl','adeddfb1e22c20548e840403e5e0b3d9dc3daf66f05fa59f1fcf5b5f664f0e98','f5/8a/2545cc2a30afc63fc6176c1da3b76af28ef9c7358ed4f68f7c6a9d86cf5b'),
 ('click-8.1.8-py3-none-any.whl','63c132bbbed01578a06712a2d1f497bb62d9c1c0d329b7903a866228027263b2','7e/d4/7ebdbd03970677812aac39c869717059dbb71a4cfc033ca6e5221787892c'),
 ('numpy-2.1.3-cp313-cp313-manylinux_2_17_x86_64.manylinux2014_x86_64.whl','5641516794ca9e5f8a4d17bb45446998c6554704d888f86df9b200e66bdcce56','70/50/73f9a5aa0810cdccda9c1d20be3cbe4a4d6ea6bfd6931464a44c95eef731'),
]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run', type=Path)
    parser.add_argument('--tag', default='iot-lab-release:10.0.6-gerber0.13.0')
    parser.add_argument('--wheel-cache', type=Path, help='reuse only original wheels with matching pinned SHA256')
    args = parser.parse_args()
    source = Path(__file__).resolve().parent
    inputs = {p:digest((source/p).read_bytes()) for p in ('release-native.Dockerfile','requirements-gerbercheck.txt','build-release-image.py')}
    recipe = digest(json.dumps(dict(base=BASE,inputs=inputs,wheels=WHEELS),sort_keys=True).encode())
    args.run.mkdir()  # New durable run record; never overwrite prior evidence.
    metadata = dict(base=BASE,base_alias=BASE_ALIAS,recipe_sha256=recipe,inputs=inputs,tag=args.tag,wheels=[])
    base=json.loads(subprocess.check_output(['docker','image','inspect',BASE],text=True,timeout=20))[0]
    if base['Id']!=BASE:
        raise ValueError('native base image identity mismatch')
    alias=subprocess.run(['docker','image','inspect',BASE_ALIAS],capture_output=True,text=True,timeout=20)
    if alias.returncode==0:
        if json.loads(alias.stdout)[0]['Id']!=BASE:
            raise ValueError('release-only base alias already points to another image')
    else:
        subprocess.run(['docker','image','tag',BASE,BASE_ALIAS],check=True,timeout=20)
    existing = subprocess.run(['docker','image','inspect',args.tag],capture_output=True,text=True,timeout=20)
    if existing.returncode == 0:
        image = json.loads(existing.stdout)[0]
        if image['Config'].get('Labels',{}).get('org.iot-lab.release-recipe') != recipe:
            raise ValueError('image tag exists with different inputs; choose a new --tag')
        metadata.update(image_id=image['Id'],reused=True)
    else:
        wheels=args.run/'wheels';wheels.mkdir()
        for name,expected,path in WHEELS:
            url='https://files.pythonhosted.org/packages/'+path+'/'+name
            print('START: pinned wheel '+name,flush=True)
            cached=args.wheel_cache/name if args.wheel_cache else None
            if cached and cached.is_file():
                raw=cached.read_bytes()
            else:
                with urllib.request.urlopen(url,timeout=30) as response:
                    raw=response.read()
            if digest(raw)!=expected:
                raise ValueError('original wheel hash mismatch: '+name)
            (wheels/name).write_bytes(raw)
            metadata['wheels'].append(dict(file=name,url=url,sha256=expected))
            print('PASS: original wheel '+name,flush=True)
        for name in ('release-native.Dockerfile','requirements-gerbercheck.txt'):
            shutil.copyfile(source/name,args.run/name)
        subprocess.run(['docker','build','--network=none','--pull=false','--build-arg','NATIVE_BASE='+BASE_ALIAS,
                        '--build-arg','RELEASE_RECIPE_SHA256='+recipe,'-f',str(args.run/'release-native.Dockerfile'),
                        '-t',args.tag,str(args.run)],check=True,timeout=300)
        image=json.loads(subprocess.check_output(['docker','image','inspect',args.tag],text=True,timeout=20))[0]
        metadata.update(image_id=image['Id'],reused=False)
    (args.run/'image.json').write_text(json.dumps(metadata,indent=2)+'\n')
    print('PASS: Gerber-capable release image '+metadata['image_id']+'; evidence='+str(args.run),flush=True)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print('FAIL: release image: '+str(error),file=sys.stderr)
        raise SystemExit(1)
