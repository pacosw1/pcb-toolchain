"""U1 pin swap proposal (pure core, no pcbnew).

A swappable net is a plain GPIO or an EXTI input of the IC. It may move to another swappable pin or to a
free usable pin. Peripheral (AF) pins stay fixed. Rules for a move (allowed()):
- an EXTI net keeps a line number that no other EXTI net uses (line = pin number in the port);
- an output never goes to the low-drive RTC pins PC13-PC15;
- a net on a 5 V tolerant (FT) pin goes only to an FT pin;
- analog-only pins and pins with 'not usable' or 'reserved' in the pin map note are not used.
Cost = HPWL of the swappable nets + w_x * crossings of the rat lines (pin to nearest other end),
counted against each other and against the fixed rat lines of the IC, + w_c per net off its present pin
(few changes are preferred).
Search = steepest descent over moves and swaps, with seeded random restarts. The result is a proposal
(a pin-map diff); it never edits a schematic.
"""
import math
import random
import re

LOW_DRIVE = ('PC13', 'PC14', 'PC15')


def port_line(name):
    m = re.match(r'P[A-K](\d+)', name)
    return int(m.group(1)) if m else None


def base_name(name):
    return re.split(r'[-_]', name)[0]


def usable(s):
    note = s.get('note', '').lower()
    return 'ANA' not in s['type'] and 'not usable' not in note and 'reserved' not in note


def allowed(n, pin, nets, slots, assign):
    net, s = nets[n], slots[pin]
    if pin != net['pin'] and not usable(s):
        return False
    if net['kind'] == 'out' and base_name(s['name']) in LOW_DRIVE:
        return False
    if net['ft'] and not s['type'].startswith('FT'):
        return False
    if net['kind'] == 'exti':
        line = port_line(s['name'])
        if line is None:
            return False
        for m, p in assign.items():
            if m != n and nets[m]['kind'] == 'exti' and port_line(slots[p]['name']) == line:
                return False
    return True


def _seg(n, pin, nets, slots):
    s = slots[pin]
    e = min(nets[n]['ends'], key=lambda q: math.hypot(q[0] - s['x'], q[1] - s['y']))
    return (s['x'], s['y'], e[0], e[1])


def _hpwl(n, pin, nets, slots):
    s = slots[pin]
    xs = [s['x']] + [q[0] for q in nets[n]['ends']]
    ys = [s['y']] + [q[1] for q in nets[n]['ends']]
    return max(xs) - min(xs) + max(ys) - min(ys)


def _cross(a, b):
    """True when the two segments cross properly (a shared end point is not a crossing)."""
    def orient(p, q, r):
        v = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
        return (v > 1e-12) - (v < -1e-12)
    p1, p2, p3, p4 = a[:2], a[2:], b[:2], b[2:]
    d1, d2, d3, d4 = orient(p3, p4, p1), orient(p3, p4, p2), orient(p1, p2, p3), orient(p1, p2, p4)
    return d1 * d2 < 0 and d3 * d4 < 0


def measure(assign, nets, slots, fixed, w_x=10.0, w_c=0.0):
    names = sorted(assign)
    segs = [_seg(n, assign[n], nets, slots) for n in names]
    hp = sum(_hpwl(n, assign[n], nets, slots) for n in names)
    x = sum(_cross(segs[i], segs[j]) for i in range(len(segs)) for j in range(i + 1, len(segs)))
    x += sum(_cross(a, b) for a in segs for b in fixed)
    ch = sum(1 for n in names if assign[n] != nets[n]['pin'])
    return {'hpwl': round(hp, 6), 'crossings': x, 'changes': ch, 'cost': round(hp + w_x * x + w_c * ch, 6)}


def _moves(assign, nets, slots):
    """All legal single moves (to a free pin) and swaps, in a fixed order."""
    held = {p: n for n, p in assign.items()}
    out = []
    names = sorted(assign)
    for n in names:
        for pin in sorted(slots):
            if pin == assign[n]:
                continue
            m = held.get(pin)
            if m is not None and m < n:
                continue  # each swap once
            new = dict(assign)
            new[n] = pin
            if m is not None:
                new[m] = assign[n]
            if allowed(n, pin, nets, slots, new) and (m is None or allowed(m, new[m], nets, slots, new)):
                out.append(new)
    return out


def _descend(assign, nets, slots, fixed, w_x, w_c):
    cur = measure(assign, nets, slots, fixed, w_x, w_c)['cost']
    while True:
        best = None
        for new in _moves(assign, nets, slots):
            c = measure(new, nets, slots, fixed, w_x, w_c)['cost']
            if c < cur - 1e-9 and (best is None or c < best[0]):
                best = (c, new)
        if best is None:
            return assign, cur
        cur, assign = best


def search(nets, slots, fixed, seed=0, w_x=10.0, restarts=5, kicks=3, w_c=0.0):
    start = {n: v['pin'] for n, v in nets.items()}
    best, cost = _descend(start, nets, slots, fixed, w_x, w_c)
    rng = random.Random(seed)
    for _ in range(restarts):
        a = dict(best)
        for _ in range(kicks):
            ms = _moves(a, nets, slots)
            if ms:
                a = ms[rng.randrange(len(ms))]
        a, c = _descend(a, nets, slots, fixed, w_x, w_c)
        if c < cost - 1e-9:
            best, cost = a, c
    diff = [{'net': n, 'from_pin': nets[n]['pin'], 'from_name': slots[nets[n]['pin']]['name'],
             'to_pin': best[n], 'to_name': slots[best[n]]['name']}
            for n in sorted(best) if best[n] != nets[n]['pin']]
    return {'assign': best, 'before': measure(start, nets, slots, fixed, w_x, w_c),
            'after': measure(best, nets, slots, fixed, w_x, w_c), 'diff': diff}
