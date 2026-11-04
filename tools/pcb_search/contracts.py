"""Fingerprints and the strict number check for proposal inputs. Rust: core/src/pyjson.rs, core/src/contract.rs."""
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
