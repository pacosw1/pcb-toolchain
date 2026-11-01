"""Pin-escape term: room for each IC pin with a net to leave its part (placement cost and legality).

IC = a part with reference prefix U and more than 3 copper pads (membership.py uses the same rule). A pin is a pad
on the outer edge of the pad box of its part (an exposed pad or an inner ball is not a pin). Its side (W, E, N, S)
is the box edge that it touches; a corner pad takes the side of its long axis.

Corridor (per pin, three directions: the outward normal and the normal turned by +45 and -45 degrees, the usual
fan-out angles): a track from the pad toe (the pad edge on the side) to one via.
  track radius  rt = track / 2 + clearance       (a track of the Default class keeps the clearance to other copper)
  via radius    rv = via_d / 2 + clearance       (the via keeps the clearance to other copper)
  length        L  = clearance + via_d / 2 + n * (via_d + clearance)
                n = 0 when the side pitch >= via_d + clearance (each pin has its own via in line), else
                n = ceil((via_d + clearance) / pitch): the pins within one via pitch of the pin escape on the same
                rays, so the ray holds the via of the pin beyond n staggered vias of its neighbours.
  NET-CORE (Default class 0.15 / 0.15 mm in NET-CORE.kicad_pro; via 0.6 mm: .kicad_dru "via size" rule and the
  board minimum via diameter 0.6 mm): rt 0.225, rv 0.45, L 1.95 mm on the 0.5 mm pitch of the LAN8742A (n 2).
  Check on the hand board: its PHY_LED1 via is 1.66 mm from the U7 pad 3 toe, inside L + rv = 2.4 mm.
A pin with a partner pad (same net, other part) within L of its toe, on its outer side, is free: the track goes to
that pad (a decap, a series resistor), and the net leaves from there.
A corridor is blocked by copper pads of other nets (all units, pads of the pin's own part excluded): the partner pads
of the pin net (its decap, its series resistor) do not block. A direction is free when every sample point on the
track (spacing <= rt) keeps rt to that copper and the via point keeps rv. blocked(direction) = penetration / rt,
clipped to [0, 1]; blocked(pin) = the smallest over the three directions; free(pin) = 1 - blocked(pin).

Side cost: need = the pins whose net has a pad on another part; deficit = max(0, need - sum of free(pin) over all
pins of the side) (the free escape width in pin slots against the nets that must leave). escape = sum of deficits.
Hard (legality, params esc_hard = 1): a side with need > 0 and every pin blocked.

Rules come from pr['escape_rules'] (kicad_io.read_problem: Default class + via size), else from
pr['route_rules']['classes']['Default'] and params via_d. Parameters: w_esc (weight; 0 = not computed), esc_hard.
Board edge, kept tracks and courtyards are not obstacles in this term (pads only; the courtyard spacing is its own
term).
"""
import math

import numpy as np

SIDE_TOL = 0.02  # mm: a pad touches a side of the pad box within this distance (footprint rounding)
DIRS = 3


def is_ic(ref, n_pads):
    i = 0
    while i < len(ref) and ref[i].isalpha():
        i += 1
    return ref[:i] == 'U' and n_pads > 3


def rules(pr, params=None):
    """{'track', 'clearance', 'via_d'} in mm."""
    r = pr.get('escape_rules')
    if r:
        return {'track': float(r['track']), 'clearance': float(r['clearance']), 'via_d': float(r['via_d'])}
    params = params or {}
    cls = ((pr.get('route_rules') or {}).get('classes') or {}).get('Default')  # [clearance, track]
    clr, track = (float(cls[0]), float(cls[1])) if cls else (0.2, 0.2)
    return {'track': track, 'clearance': clr, 'via_d': float(params.get('via_d', 0.6))}


def geometry(rl, pitch):
    """(rt, rv, L, samples t along the corridor, radius per sample) for one side pitch."""
    c, d = rl['clearance'], rl['via_d']
    rt, rv = rl['track'] / 2 + c, d / 2 + c
    n = 0 if pitch >= d + c - 1e-9 else int(math.ceil((d + c) / pitch - 1e-9))
    L = c + d / 2 + n * (d + c)
    k = int(math.ceil(L / rt)) + 1
    t = np.linspace(0.0, L, k)
    rad = np.full(k, rt)
    rad[-1] = rv
    return rt, rv, L, t, rad


def _turn(v, deg):
    a = math.radians(deg)
    return (v[0] * math.cos(a) - v[1] * math.sin(a), v[0] * math.sin(a) + v[1] * math.cos(a))


NORMAL = {'W': (-1.0, 0.0), 'E': (1.0, 0.0), 'N': (0.0, -1.0), 'S': (0.0, 1.0)}


def part_pins(rows, nets_other):
    """Pins of one IC part. rows = [(cu row index, [x0, y0, x1, y1, net])] in unit coordinates (r = 0);
    nets_other = net codes with a pad on another part. -> [dict(row, side, toe, normal, net, need, pitch)]."""
    if not rows:
        return []
    X0 = min(b[0] for _, b in rows)
    Y0 = min(b[1] for _, b in rows)
    X1 = max(b[2] for _, b in rows)
    Y1 = max(b[3] for _, b in rows)
    out = []
    for k, b in rows:
        touch = [s for s, hit in (('W', abs(b[0] - X0) < SIDE_TOL), ('E', abs(b[2] - X1) < SIDE_TOL),
                                  ('N', abs(b[1] - Y0) < SIDE_TOL), ('S', abs(b[3] - Y1) < SIDE_TOL)) if hit]
        if not touch:
            continue  # an inner pad (exposed pad, inner ball)
        if len(touch) > 1:  # a corner pad: the side of its long axis (W/E for a wide pad, N/S for a tall pad)
            wide = (b[2] - b[0]) > (b[3] - b[1])
            pick = [s for s in touch if (s in 'WE') == wide]
            touch = pick or touch
        s = touch[0]
        cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        toe = {'W': (b[0], cy), 'E': (b[2], cy), 'N': (cx, b[1]), 'S': (cx, b[3])}[s]
        net = int(b[4])
        out.append(dict(row=k, side=s, toe=toe, normal=NORMAL[s], net=net, need=int(net > 0 and net in nets_other)))
    for s in 'WENS':
        side = [p for p in out if p['side'] == s]
        along = sorted(p['toe'][1] if s in 'WE' else p['toe'][0] for p in side)
        gaps = [b - a for a, b in zip(along, along[1:]) if b - a > 1e-6]
        pitch = float(np.median(gaps)) if gaps else math.inf
        for p in side:
            p['pitch'] = pitch
    return out


class Model:
    """Static pin data of a problem (unit coordinates, 4 turns) and the corridor test."""

    def __init__(self, pr, params=None):
        self.rl = rules(pr, params)
        self.hard = bool((params or {}).get('esc_hard', 0))
        us = pr['units']
        owners = {}  # net code -> {(unit, ref)}
        self.part = []  # per unit: part id of each cu row (index of the ref in u['refs']; -1 unknown)
        for i, u in enumerate(us):
            refs = {r: k for k, r in enumerate(u.get('refs', []))}
            meta = u.get('cu_pads') or []
            ids = []
            for k, b in enumerate(u.get('cu', [])):
                ref = meta[k][0] if k < len(meta) else None
                ids.append(refs.get(ref, -1))
                if b[4] > 0 and ref is not None:
                    owners.setdefault(int(b[4]), set()).add((i, ref))
            self.part.append(np.array(ids, dtype=int))
        self.pins = []  # per unit: None or dict of arrays (r = 0) + 4 turns
        for i, u in enumerate(us):
            meta = u.get('cu_pads') or []
            by_ref = {}
            for k, b in enumerate(u.get('cu', [])):
                if k < len(meta) and meta[k][1] != 'npth':
                    by_ref.setdefault(meta[k][0], []).append((k, b))
            pins = []
            for ref, rows in by_ref.items():
                if not is_ic(ref, len(rows)):
                    continue
                other = {q for q, own in owners.items() if any(o != (i, ref) for o in own)}
                pid = u['refs'].index(ref) if ref in u.get('refs', []) else -1
                for p in part_pins(rows, other):
                    p['part'], p['ref'] = pid, ref
                    pins.append(p)
            self.pins.append(self._arrays(pins) if pins else None)

    def _arrays(self, pins):
        P = len(pins)
        sides = {}
        sid = np.array([sides.setdefault((p['part'], p['side']), len(sides)) for p in pins], dtype=int)
        geo = {}
        for p in pins:
            g = geo.setdefault(p['pitch'], geometry(self.rl, p['pitch']))
            p['geo'] = g
        k = max(len(p['geo'][3]) for p in pins)
        off = np.zeros((P, DIRS, k, 2))  # sample offsets from the toe, r = 0
        rad = np.zeros((P, k))
        for a, p in enumerate(pins):
            _, _, _, t, rr = p['geo']
            tt = np.concatenate([t, np.full(k - len(t), t[-1])])  # pad with the via point
            rp = np.concatenate([rr, np.full(k - len(rr), rr[-1])])
            for d, deg in enumerate((0.0, 45.0, -45.0)):
                v = _turn(p['normal'], deg)
                off[a, d, :, 0], off[a, d, :, 1] = tt * v[0], tt * v[1]
            rad[a] = rp
        toe = np.array([p['toe'] for p in pins], dtype=float)
        reach = float(max(p['geo'][2] + p['geo'][1] for p in pins))  # L + rv
        out = dict(n=P, toe=[], off=[], sid=sid, nside=len(sides),
                   net=np.array([p['net'] for p in pins], dtype=int),
                   need=np.array([p['need'] for p in pins], dtype=float),
                   part=np.array([p['part'] for p in pins], dtype=int), rad=rad,
                   rt=np.array([p['geo'][0] for p in pins], dtype=float), reach=reach,
                   L=np.array([p['geo'][2] for p in pins], dtype=float),
                   names=[(p['ref'], p['side']) for p in pins], rows=[p['row'] for p in pins])
        for r in range(4):  # KiCad turn of the unit (cost.rot_pt): (x, y) -> (y, -x) per step
            T, O = toe.copy(), off.copy()
            for _ in range(r):
                T = np.stack([T[:, 1], -T[:, 0]], axis=1)
                O = np.stack([O[..., 1], -O[..., 0]], axis=-1)
            out['toe'].append(T)
            out['off'].append(O)
        return out

    def units(self):
        return [i for i, q in enumerate(self.pins) if q is not None]

    def pin_boxes(self, i, pose_i):
        """(P, 4) world box of the corridors of each pin of unit i (with the via radius)."""
        q = self.pins[i]
        x, y, r = pose_i
        S = q['off'][r % 4] + q['toe'][r % 4][:, None, None, :] + (x, y)
        g = float(q['rad'].max())
        return np.stack([S[..., 0].min(axis=(1, 2)) - g, S[..., 1].min(axis=(1, 2)) - g,
                         S[..., 0].max(axis=(1, 2)) + g, S[..., 1].max(axis=(1, 2)) + g], axis=1)

    def blocked(self, i, pose_i, idx, cu, cu_unit, cu_part):
        """blocked(pin) in [0, 1] for the pins idx of unit i. cu (Q, 5) world copper boxes with net codes of the
        units near, cu_unit / cu_part (Q,) their unit and part ids."""
        q = self.pins[i]
        idx = np.asarray(idx, dtype=int)
        if not len(idx):
            return np.zeros(0)
        if not len(cu):
            return np.zeros(len(idx))
        x, y, r = pose_i
        S = q['off'][r % 4][idx] + q['toe'][r % 4][idx][:, None, None, :] + (x, y)  # (p, 3, k, 2)
        dx = np.maximum(np.maximum(cu[:, 0] - S[..., 0, None], S[..., 0, None] - cu[:, 2]), 0.0)
        dy = np.maximum(np.maximum(cu[:, 1] - S[..., 1, None], S[..., 1, None] - cu[:, 3]), 0.0)
        m = np.sqrt(dx * dx + dy * dy) - q['rad'][idx][:, None, :, None]  # (p, 3, k, Q)
        net = q['net'][idx]
        own = (cu_unit[None, :] == i) & (cu_part[None, :] == q['part'][idx][:, None])
        partner = (cu[:, 4][None, :] == net[:, None]) & (net[:, None] > 0)
        skip = own | partner  # (p, Q)
        m = np.where(skip[:, None, None, :], np.inf, m)
        mm = m.min(axis=(2, 3))  # (p, 3)
        rt = q['rt'][idx][:, None]
        b = np.clip(-mm / rt, 0.0, 1.0).min(axis=1)
        # a partner pad within L of the toe on the outer side: the pin connects to it directly
        T = S[:, 0, 0, :]  # toe (p, 2)
        nrm = (S[:, 0, -1, :] - T) / q['L'][idx][:, None]
        tx = np.maximum(np.maximum(cu[:, 0] - T[:, 0, None], T[:, 0, None] - cu[:, 2]), 0.0)
        ty = np.maximum(np.maximum(cu[:, 1] - T[:, 1, None], T[:, 1, None] - cu[:, 3]), 0.0)
        cx, cy = (cu[:, 0] + cu[:, 2]) / 2, (cu[:, 1] + cu[:, 3]) / 2
        out = (cx[None, :] - T[:, 0, None]) * nrm[:, 0, None] + (cy[None, :] - T[:, 1, None]) * nrm[:, 1, None]
        near = partner & ~own & (np.hypot(tx, ty) <= q['L'][idx][:, None]) & (out >= 0)
        return np.where(near.any(axis=1), 0.0, b)

    def side_cost(self, i, blocked):
        """(deficit, hard sides) of unit i from blocked (P,)."""
        q = self.pins[i]
        free = np.bincount(q['sid'], weights=1.0 - blocked, minlength=q['nside'])
        need = np.bincount(q['sid'], weights=q['need'], minlength=q['nside'])
        deficit = float(np.clip(need - free, 0.0, None).sum())
        full = np.bincount(q['sid'], weights=(blocked >= 1.0 - 1e-9).astype(float), minlength=q['nside'])
        size = np.bincount(q['sid'], minlength=q['nside'])
        hard = int(((need > 0) & (full >= size)).sum())
        return deficit, hard


def world_cu(pr, pose, model, units=None):
    """(cu (Q, 5), unit ids, part ids) of the units (all by default) at pose."""
    from .cost import world_cu as wcu
    units = range(len(pr['units'])) if units is None else units
    C, U, P = [], [], []
    for j in units:
        w = wcu(pr['units'][j], pose[j])
        if len(w):
            C.append(w)
            U.append(np.full(len(w), j, dtype=int))
            P.append(model.part[j][:len(w)])
    if not C:
        return np.zeros((0, 5)), np.zeros(0, dtype=int), np.zeros(0, dtype=int)
    return np.concatenate(C), np.concatenate(U), np.concatenate(P)


def unit_blocked(pr, pose, model, i, cu=None):
    q = model.pins[i]
    cu = cu or world_cu(pr, pose, model)
    return model.blocked(i, pose[i], np.arange(q['n']), *cu)


def escape(pr, pose, params=None, model=None):
    """(escape deficit sum, hard side count) of a pose (full evaluation)."""
    model = model or Model(pr, params)
    cu = world_cu(pr, pose, model)
    d, h = 0.0, 0
    for i in model.units():
        a, b = model.side_cost(i, unit_blocked(pr, pose, model, i, cu))
        d, h = d + a, h + b
    return d, h


def report(pr, pose, params=None, model=None, min_blocked=0.5):
    """Blocked pins and side deficits (for logs and repair): [dict(unit, ref, side, pad, net, blocked)]."""
    model = model or Model(pr, params)
    cu = world_cu(pr, pose, model)
    out = []
    for i in model.units():
        q = model.pins[i]
        b = unit_blocked(pr, pose, model, i, cu)
        meta = pr['units'][i].get('cu_pads') or []
        for a in np.nonzero((b >= min_blocked) & (q['need'] > 0))[0]:
            ref, side = q['names'][a]
            row = q['rows'][a]
            out.append(dict(unit=i, ref=ref, side=side, pad=str(meta[row][2]) if row < len(meta) else None,
                            net=int(q['net'][a]), blocked=round(float(b[a]), 3)))
    return out
