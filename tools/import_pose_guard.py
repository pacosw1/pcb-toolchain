"""Preserve native integer poses across the declared Specctra export grid.

KiCad exports coordinates in um with a resolution divisor (um 10 is 100 nm).
Only a translation onto the uniquely nearest grid point can be restored. This
is not permission to move parts: all original poses and pad identities must be
exact again before the caller performs copper guards and independent DRC.
"""
import re
from pathlib import Path


def grid_nm(dsn, ses):
    def read(path):
        text = Path(path).read_text()
        matches = re.findall(r'\(resolution\s+(\w+)\s+(\d+)\s*\)', text)
        if not matches or len(set(matches)) != 1:
            raise ValueError('missing or ambiguous Specctra resolution')
        unit, divisor = matches[0]
        divisor = int(divisor)
        if unit != 'um' or divisor <= 0 or 1000 % divisor:
            raise ValueError('unsupported Specctra resolution')
        return 1000 // divisor
    exported, imported = read(dsn), read(ses)
    if exported != imported:
        raise ValueError('DSN/SES resolution mismatch')
    return exported


def snapshot(board):
    result = {}
    refs = set()
    for fp in board.GetFootprints():
        uid, ref = fp.m_Uuid.AsString(), fp.GetReference()
        if not uid or uid in result or ref in refs:
            raise ValueError('missing/duplicate footprint UUID or reference')
        refs.add(ref)
        pos = fp.GetPosition()
        pads = {}
        for pad in fp.Pads():
            pid = pad.m_Uuid.AsString()
            if not pid or pid in pads:
                raise ValueError('missing/duplicate pad UUID')
            pp = pad.GetPosition()
            pads[pid] = dict(number=pad.GetNumber(), net=pad.GetNetname(),
                             netcode=pad.GetNetCode(), layers=pad.GetLayerSet().FmtBin(),
                             angle=pad.GetOrientation().AsDegrees(),
                             position=(pp.x, pp.y))
        result[uid] = dict(ref=ref, position=(pos.x, pos.y),
                           angle=fp.GetOrientation().AsDegrees(), layer=fp.GetLayer(),
                           locked=fp.IsLocked(), pads=pads)
    return result


def restoration_plan(before, after, step):
    """Validate all changes before mutation; return UUID -> original position."""
    if not isinstance(step, int) or not 1 <= step <= 1000:
        raise ValueError('unsupported grid step')
    if before.keys() != after.keys():
        raise ValueError('SES added/removed footprints')
    restore = {}
    for uid, old in before.items():
        new = after[uid]
        for field in ('ref', 'angle', 'layer', 'locked'):
            if old[field] != new[field]:
                raise ValueError('SES changed footprint ' + field + ': ' + old['ref'])
        delta = tuple(b - a for a, b in zip(old['position'], new['position']))
        for a, b in zip(old['position'], new['position']):
            if a == b:
                continue
            q, r = divmod(a, step)
            # Equidistant ties are not a uniquely attributable rounding change.
            nearest = (q + int(2 * r > step)) * step
            if 2 * r == step or b != nearest or 2 * abs(b - a) > step:
                raise ValueError('SES displaced footprint beyond export rounding: ' + old['ref'])
        if old['pads'].keys() != new['pads'].keys():
            raise ValueError('SES added/removed pads: ' + old['ref'])
        for pid, pad in old['pads'].items():
            updated = new['pads'][pid]
            for field in ('number', 'net', 'netcode', 'layers', 'angle'):
                if pad[field] != updated[field]:
                    raise ValueError('SES changed pad identity: ' + old['ref'])
            if tuple(updated['position'][i] - pad['position'][i] for i in (0, 1)) != delta:
                raise ValueError('SES changed pad geometry: ' + old['ref'])
        if any(delta):
            restore[uid] = old['position']
    return restore


def restore(board, before, step):
    import pcbnew
    imported = snapshot(board)
    plan = restoration_plan(before, imported, step)
    for fp in board.GetFootprints():
        position = plan.get(fp.m_Uuid.AsString())
        if position is not None:
            fp.SetPosition(pcbnew.VECTOR2I(*position))
    if snapshot(board) != before:
        raise ValueError('SES footprint/pad restoration was not exact')
    return [{'uuid': uid, 'ref': before[uid]['ref'], 'position_nm': list(pos),
             'imported_position_nm': list(imported[uid]['position']),
             'delta_nm': [b-a for a,b in zip(pos, imported[uid]['position'])]}
            for uid, pos in sorted(plan.items())]
