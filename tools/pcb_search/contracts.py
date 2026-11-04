"""Fingerprints and strict number, point and box checks for proposal inputs.

Input hashes bind evidence; they do not establish that the model is complete.
The route problem contract itself lives in core/src/contract.rs.
"""
import hashlib
import json
import math


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                     allow_nan=False).encode()).hexdigest()


def number(value, name, positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(name + ' must be finite')
    if value < 0 or (positive and value == 0):
        raise ValueError(name + ' out of range')
    return float(value)


def xy(value):
    if not isinstance(value, (list, tuple)) or len(value) != 2 or any(isinstance(v, bool) or not isinstance(v, (int, float))
                             or not math.isfinite(v) for v in value):
        raise ValueError('point requires two finite coordinates')
    return tuple(float(v) for v in value)


def box(value):
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise ValueError('box requires four coordinates')
    a, b = xy(value[:2]), xy(value[2:])
    if a[0] >= b[0] or a[1] >= b[1]:
        raise ValueError('box must have positive area')
    return a + b
