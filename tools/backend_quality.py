"""Bind an explicitly selected quality backend to reviewed build/native evidence."""
import json
from pathlib import Path
import re

import lean_workflow as lean

UPSTREAM = 'e5d52c4544795422b8b28077acc0605fdf11265a'
LOCK = '4761175c5d8df0ed4c2c69036df2686dc7e3a186cd085d2ae766936134cab9a6'
PATCH = Path(__file__).parent/'backend-patches/fastroute-quality-773/quality-first.patch'


def bind(binary, manifest):
    if manifest is None:
        return dict(mode='legacy-unverified', qualified=False)
    path = Path(manifest)
    data = json.loads(path.read_text())
    if not isinstance(data, dict):
        raise ValueError('quality backend provenance schema invalid')
    if (type(data.get('schema')) is not int or data.get('schema') != 1 or data.get('upstream_commit') != UPSTREAM or
            data.get('cargo_lock_sha256') != LOCK or data.get('patch_sha256') != lean.digest(PATCH)):
        raise ValueError('quality backend source/patch/lock provenance mismatch')
    if data.get('binary_sha256') != lean.digest(binary):
        raise ValueError('quality backend binary hash mismatch')
    validation = data.get('native_validation', {})
    if not isinstance(validation, dict):
        raise ValueError('quality backend native validation schema invalid')
    evidence = validation.get('evidence')
    if validation.get('status') != 'passed' or not isinstance(evidence, list) or not evidence:
        raise ValueError('quality backend native validation evidence unavailable')
    for item in evidence:
        if (not isinstance(item, dict) or not isinstance(item.get('sha256'), str) or
                not isinstance(item.get('path'), str) or not re.fullmatch(r'[0-9a-f]{64}', item['sha256'])):
            raise ValueError('quality backend evidence schema invalid')
        target = Path(item.get('path', ''))
        if not target.is_absolute() or not target.is_file() or lean.digest(target) != item['sha256']:
            raise ValueError('quality backend native evidence hash mismatch')
    return dict(mode='quality-first', manifest=str(path.resolve()),
                manifest_sha256=lean.digest(path), binary_sha256=data['binary_sha256'],
                patch_sha256=data['patch_sha256'], upstream_commit=UPSTREAM, qualified=False)


def require_capability(help_text):
    if '--quality-first' not in help_text:
        raise ValueError('quality backend lacks required --quality-first capability')
