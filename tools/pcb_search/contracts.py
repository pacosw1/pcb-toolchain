"""Fingerprints. Rust: core/src/pyjson.rs. TS: lib/fingerprint.ts."""
import hashlib
import json


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                     allow_nan=False).encode()).hexdigest()
