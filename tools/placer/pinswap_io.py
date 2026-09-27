"""Board adapter for the pin swap (needs pcbnew).

read_pins(board, pinmap) builds the pinswap problem from a pin map JSON ({'ref', 'pins': [{number, name, net,
function, af, pin_type, exti, note}]}) and the pad positions of the board. It fails closed (ValueError) when a
pin map net does not agree with the board pad net.
apply(board, diff, out) writes a COPY with the U1 pad nets changed per the diff, for a routing benchmark only.
It removes the copper that touched a changed pad. The schematic is never changed; parity fails on the copy.
"""
import fnmatch
import json
import math

import pcbnew

from . import kicad_io

POWER = ('GND', '+*', 'VDD*', 'VSS*', 'VCAP*', 'VREF*', 'VBAT*', 'NC')


def _xy(p):
    q = p.GetPosition()
    return kicad_io.mm(q.x), kicad_io.mm(q.y)


def _short(net):
    return net.split('/')[-1]


def kind_of(p):
    """'exti', 'out', 'in', 'free' (unused pin) or None (fixed)."""
    f = p.get('function') or ''
    if p.get('af'):
        return None
    if f == 'unused':
        return 'free'
    if 'EXTI' in f and p.get('exti') is not None:
        return 'exti'
    if f.startswith('GPIO out'):
        return 'out'
    if f.startswith('GPIO in'):
        return 'in'
    return None


def read_pins(board_path, pinmap_path, ref=None):
    pm = json.load(open(pinmap_path))
    ref = ref or pm.get('ref', 'U1')
    board = pcbnew.LoadBoard(board_path)
    fp = board.FindFootprintByReference(ref)
    if fp is None:
        raise ValueError('%s not on the board' % ref)
    pads = {p.GetNumber(): p for p in fp.Pads()}
    others = {}
    for p in board.GetPads():
        if p.GetParentFootprint().GetReference() != ref and p.GetNetname():
            others.setdefault(p.GetNetname(), []).append(list(_xy(p)))
    nets, slots, fixed = {}, {}, []
    for pin in pm['pins']:
        pad = pads.get(str(pin['number']))
        if pad is None:
            raise ValueError('%s pin %s not on the board' % (ref, pin['number']))
        net = pad.GetNetname()
        free = not net or net.startswith('unconnected-')
        if (pin['net'] == 'NC') != free or (not free and _short(net) != pin['net']):
            raise ValueError('%s pin %s (%s): pin map net %s, board net %s' % (
                ref, pin['number'], pin['name'], pin['net'], net))
        k = kind_of(pin)
        x, y = _xy(pad)
        s = {'name': pin['name'], 'type': pin.get('pin_type') or '', 'x': x, 'y': y, 'note': pin.get('note') or ''}
        ends = others.get(net, [])
        if k == 'free':
            slots[pin['number']] = s
        elif k and ends:
            slots[pin['number']] = s
            nets[net] = {'kind': k, 'pin': pin['number'], 'ft': s['type'].startswith('FT'), 'ends': ends}
        elif not free and ends and not any(fnmatch.fnmatchcase(_short(net), q) for q in POWER):
            e = min(ends, key=lambda q: math.hypot(q[0] - x, q[1] - y))
            fixed.append((x, y, e[0], e[1]))
    return nets, slots, fixed


def apply(board_path, diff, out, ref='U1'):
    if out == board_path:
        raise ValueError('apply writes a copy only: out must differ from the input board')
    board = pcbnew.LoadBoard(board_path)
    pads = {p.GetNumber(): p for p in board.FindFootprintByReference(ref).Pads()}
    changed = {str(d['from_pin']) for d in diff} | {str(d['to_pin']) for d in diff}
    by_net = {}
    for n in changed:
        if pads[n].GetNetname():
            by_net.setdefault(pads[n].GetNetname(), []).append(pads[n])
    free = list(board.GetTracks())
    find = kicad_io._clusters(free)
    hit = kicad_io._hit(free, find, by_net)
    remove = [t for k, t in enumerate(free) if find(k) in hit]
    for n in changed:
        pads[n].SetNetCode(0)
    for d in diff:
        pads[str(d['to_pin'])].SetNet(board.FindNet(d['net']))
    for t in remove:
        board.Delete(t)
    pcbnew.SaveBoard(out, board)
    return {'changed_pads': len(changed), 'removed_tracks': len(remove)}
