"""Hashes that bind a proposal to its native project. Rust: core/src/native/digest.rs."""
import hashlib
from pathlib import Path

from .contracts import fingerprint

def digest(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def source_set(board):
    files = [board.with_suffix(x) for x in ('.kicad_pcb', '.kicad_pro', '.kicad_dru', '.kicad_sch')]
    if any(not p.is_file() for p in files):
        raise ValueError('complete native project sidecars required')
    return {p.name: digest(p) for p in files}


def geometry_digest(path, omit_ids=()):
    """Hash all native board forms except explicitly named routing items.

    Only writer identity metadata is ignored. Placements, pads, nets, rules,
    zones, drawings, copper and board setup remain in the protected payload.
    """
    from placer.dru import _tree, _tokens
    forms = _tree(_tokens(Path(path).read_text()))
    if len(forms) != 1 or forms[0][0] != 'kicad_pcb':
        raise ValueError('unexpected native board root')
    remaining, seen, hashes = set(omit_ids), set(), []
    for form in forms[0][1:]:
        uid = next((v[1] for v in form[1:] if isinstance(v, list) and v[0] == 'uuid'), None)
        if uid in remaining:
            if form[0] not in ('segment', 'arc', 'via') or uid in seen:
                raise ValueError('only uniquely identified routing items may change')
            seen.add(uid)
            continue
        if form[0] not in ('generator', 'generator_version'):
            hashes.append(fingerprint(form))
    if seen != remaining:
        raise ValueError('specified routing item absent from native board')
    return fingerprint(sorted(hashes))


