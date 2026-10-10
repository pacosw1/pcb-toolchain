#!/usr/bin/env python3
"""ibis_ramp: the output drive of a vendor IBIS model (D-124b, corrected by D-124c, 2026-10-09).

Reads only what the detour budget needs from an IBIS file (ANSI/EIA-656, IBIS 3.2 to 7): per [Model] the
Model_type, C_comp (typ, min, max) and the [Ramp] section (dV/dt_r, dV/dt_f for typ, min, max and R_load), and
the [Pin] lists (signal -> model name). The file is streamed line by line; it is never read into a report.

[Ramp] (IBIS 4.1 section 6): dV/dt_r = (20 % to 80 % voltage swing) / (time of that swing) into R_load, for the
rising edge; dV/dt_f for the falling edge. The edge time used is the dt: a 20-80 % time, which is shorter than the
10-90 % time of the same edge (1.33 x for a linear ramp), so it is the conservative one for the detour budget.
Corners: the columns are typ, min (slow, weak) and max (fast, strong). ramp_edges() takes the shortest dt of the
corners asked (default typ and max): the fastest edge.

D-124c (2026-10-09): the [Ramp] is measured into the ramp fixture (R_load, 50 ohm recommended: IBIS Modeling
Cookbook v4, IBIS Open Forum, section 3.2.1 p. 18, https://ibis.org/cookbook/cookbook-v4.pdf [P]; R_load = 50 in all
our TI files), so it is much faster than the edge into a real board load (TCA9535 INT read 0.16 ns). The edge is now
the same t >= C x dV / I as for parts without IBIS (tools/net_drivers.py), with I from the [Pulldown] and [Pullup]
V-I tables (vi_edges):
  - the V-I tables are static (DC) output currents: "slow enough that the current measurement at each time point
    is effectively DC"; [Pulldown] is ground-relative, [Pullup] is Vcc-relative (table V = Vcc - Vout; current into
    the pin is positive) (Cookbook section 3.1.1 and 3.1.1.1, p. 13-14 [P]);
  - a capacitor C driven by a static V-I curve: C dV/dt = I(V), so the 10-90 % time is t = C x integral dV / I(V)
    over 0.1 V .. 0.9 V of the swing [D]. Using the MEAN current over that range, t = C x 0.8 V / I_avg, gives a time
    no longer than that integral (arithmetic mean >= harmonic mean), and the driver's turn-on time is left out: so
    the estimate is the faster (stricter) one. Howard Johnson, "Big Buffer", Signal Consistency newsletter vol. 8
    issue 07 (2005), https://sigcon.com/Pubs/news/8_07.htm [S], uses the V-I curve current the same way
    (TR = 2.3 x (VCC / ISHORT) x CLOAD for 0-90 %, one linear resistance); for a linear V-I curve our mean-current
    10-90 % time is 1.6 RC, shorter than his 2.2 RC (10-90 %).
  - swing: push-pull, the corner's [Pullup Reference] (else [Voltage Range]) voltage; open drain, the pull-up rail.
  - corners: typ and max (IBIS: max is the strong, fast corner); the faster edge is used.

  python3 tools/ibis_ramp.py FILE.ibs MODEL      print the ramp, V-I currents and C_comp of one model
"""
import os
import re
import sys

SUFFIX = {'T': 1e12, 'G': 1e9, 'M': 1e6, 'k': 1e3, 'm': 1e-3, 'u': 1e-6, 'n': 1e-9, 'p': 1e-12, 'f': 1e-15}
CORNERS = ('typ', 'min', 'max')
_cache = {}


class IbisError(ValueError):
    pass


def number(text):
    """An IBIS number: 3.22pF, 16.66p, 2.85826e-010, 1.0nH, 50 -> float in SI units. NA -> None."""
    t = text.strip()
    if t.upper() == 'NA':
        return None
    m = re.fullmatch(r'([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)([TGMkmunpf]?)[A-Za-z]*', t)
    if not m:
        raise IbisError(f'not an IBIS number: {text!r}')
    return float(m.group(1)) * SUFFIX.get(m.group(2), 1.0)


def _ramp_value(text):
    """'1.49/3.24E-10' -> (1.49, 3.24e-10); NA -> None."""
    if text.strip().upper() == 'NA':
        return None
    dv, dt = text.split('/')
    return number(dv), number(dt)


def parse(lines):
    """{'models': {lower name: {'name', 'type', 'c_comp': [typ, min, max] F, 'ramp': {'r': [3], 'f': [3]},
    'r_load'}}, 'pins': {component: {pin number: (signal, model name)}}}."""
    models, pins = {}, {}
    model = comp = None
    section = ''
    for raw in lines:
        line = raw.split('|', 1)[0].rstrip()
        if not line.strip():
            continue
        head = re.match(r'\s*\[([^\]]+)\]\s*(.*)', line)
        if head:
            section, arg = head.group(1).strip().lower(), head.group(2).strip()
            if section == 'model':
                name = arg.split()[0]
                model = models.setdefault(name.lower(), {'name': name, 'type': None, 'c_comp': None,
                                                         'ramp': {}, 'r_load': None, 'vi': {},
                                                         'vrange': None, 'pullup_ref': None})
            elif section in ('voltage range', 'pullup reference') and model is not None:
                vals = [number(w) for w in arg.split()[:3]]
                vals += [None] * (3 - len(vals))
                model['vrange' if section == 'voltage range' else 'pullup_ref'] = [v if v is not None else vals[0] for v in vals]
            elif section in ('pulldown', 'pullup') and model is not None:
                model['vi'][section] = []
            elif section == 'component':
                comp, model = arg, None
                pins.setdefault(comp, {})
            elif section == 'end':
                model = None
            continue
        words = line.split()
        if section == 'pin' and comp is not None and len(words) >= 3:
            pins[comp][words[0]] = (words[1], words[2])
        elif section == 'model' and model is not None:
            key = words[0].lower()
            if key == 'model_type' and len(words) > 1:
                model['type'] = words[1]
            elif key == 'c_comp' and len(words) >= 2:
                vals = [number(w) for w in words[1:4]]
                vals += [None] * (3 - len(vals))
                model['c_comp'] = [v if v is not None else vals[0] for v in vals]
        elif section in ('pulldown', 'pullup') and model is not None and len(words) >= 2:
            try:
                vals = [number(w) for w in words[:4]]
            except IbisError:
                continue
            vals += [None] * (4 - len(vals))
            model['vi'][section].append((vals[0], [v if v is not None else vals[1] for v in vals[1:]]))
        elif section == 'ramp' and model is not None:
            key = words[0].lower()
            if key in ('dv/dt_r', 'dv/dt_f') and len(words) >= 2:
                vals = [_ramp_value(w) for w in words[1:4]]
                vals += [None] * (3 - len(vals))
                model['ramp'][key[-1]] = [v if v is not None else vals[0] for v in vals]
            else:
                m = re.match(r'r_load\s*=\s*(\S+)', line.strip(), re.I)
                if m:
                    model['r_load'] = number(m.group(1))
    return {'models': models, 'pins': pins}


def load(path):
    """Parse an IBIS file once (cached by path)."""
    path = os.path.abspath(path)
    if path not in _cache:
        if not os.path.isfile(path):
            raise IbisError(f'no IBIS file {path}')
        with open(path, errors='replace') as f:
            _cache[path] = parse(f)
    return _cache[path]


def ramp_edges(model, corners=('typ', 'max')):
    """{'tr_ns', 'tf_ns', 'corner_r', 'corner_f'}: the shortest 20-80 % time of the corners asked."""
    out = {}
    for edge in ('r', 'f'):
        vals = model['ramp'].get(edge)
        if not vals:
            raise IbisError(f"model {model['name']}: no [Ramp] dV/dt_{edge}")
        best = min((vals[CORNERS.index(c)][1], c) for c in corners if vals[CORNERS.index(c)])
        out[f't{edge}_ns'] = best[0] * 1e9
        out[f'corner_{edge}'] = best[1]
    return out


def vi_avg_current(rows, corner, v_lo, v_hi):
    """Mean |I| (A) of a V-I table column over the table voltages v_lo..v_hi (linear between the points, held
    flat outside the table)."""
    pts = sorted((v, i[CORNERS.index(corner)]) for v, i in rows)
    if not pts:
        raise IbisError('empty V-I table')

    def at(x):
        if x <= pts[0][0]:
            return pts[0][1]
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            if x0 <= x <= x1:
                return y0 if x1 == x0 else y0 + (y1 - y0) * (x - x0) / (x1 - x0)
        return pts[-1][1]
    xs = [v_lo] + [x for x, _ in pts if v_lo < x < v_hi] + [v_hi]
    area = sum((abs(at(a)) + abs(at(b))) / 2 * (b - a) for a, b in zip(xs, xs[1:]))
    return area / (v_hi - v_lo)


def vi_edges(model, c_f, swing_v=None, open_drain=False, corners=('typ', 'max'), i_limit_a=None):
    """D-124c edge of an output into C (F): t = C x 0.8 V / I_avg, I_avg = mean |I| over 10-90 % of the swing.
    Falling: [Pulldown] at Vout = 0.1 V .. 0.9 V. Rising: [Pullup], Vcc-relative, the same range. Swing: swing_v
    (the pull-up rail of an open drain) else the corner's [Pullup Reference] or [Voltage Range]. i_limit_a: a series
    resistor limit. Returns {'tf_ns', 'corner_f', 'i_f', 'v_f'} and for push-pull also tr: the fastest corner."""
    kind = (model.get('type') or '').lower()
    if not kind or kind.startswith('input') or kind in ('terminator', 'series', 'series_switch'):
        raise IbisError(f"model {model['name']}: Model_type {model.get('type')} is not an output")
    if open_drain and not swing_v:
        raise IbisError(f"model {model['name']}: open drain needs the pull-up voltage")
    out = {}
    for edge, table in (('f', 'pulldown'), ('r', 'pullup')):
        if edge == 'r' and open_drain:
            continue
        rows = model['vi'].get(table)
        if not rows:
            raise IbisError(f"model {model['name']}: no [{table.title()}] table")
        best = None
        for c in corners:
            ref = model['pullup_ref'] or model['vrange']
            v = swing_v if open_drain and swing_v else (ref[CORNERS.index(c)] if ref else swing_v)
            if not v:
                raise IbisError(f"model {model['name']}: no swing voltage ([Voltage Range] or pull-up rail)")
            i = vi_avg_current(rows, c, 0.1 * v, 0.9 * v)
            if not i > 0:
                raise IbisError(f"model {model['name']}: no {table} current over 10-90 % ({c} corner)")
            if i_limit_a is not None:
                i = min(i, i_limit_a)
            t = c_f * 0.8 * v / i * 1e9
            if best is None or t < best[0]:
                best = (t, c, i, v)
        out[f't{edge}_ns'], out[f'corner_{edge}'], out[f'i_{edge}'], out[f'v_{edge}'] = best
    return out


def main(argv=None):
    a = sys.argv[1:] if argv is None else argv
    if len(a) != 2:
        print(__doc__)
        return 2
    m = load(a[0])['models'].get(a[1].lower())
    if m is None:
        print(f'no model {a[1]}')
        return 1
    e = ramp_edges(m) if m['ramp'] else {}
    print(f"{m['name']} {m['type']} C_comp {m['c_comp']} R_load {m['r_load']} ramp {m['ramp']} -> {e} (not used, D-124c)")
    if m['vi'].get('pulldown'):
        od = not m['vi'].get('pullup')
        ref = m['pullup_ref'] or m['vrange'] or [None] * 3
        print(f"V-I edge into 1 pF: {vi_edges(m, 1e-12, swing_v=ref[0], open_drain=od)}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
