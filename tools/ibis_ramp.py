#!/usr/bin/env python3
"""ibis_ramp: the output edge of a vendor IBIS model (D-124b, 2026-10-09).

Reads only what the detour budget needs from an IBIS file (ANSI/EIA-656, IBIS 3.2 to 7): per [Model] the
Model_type, C_comp (typ, min, max) and the [Ramp] section (dV/dt_r, dV/dt_f for typ, min, max and R_load), and
the [Pin] lists (signal -> model name). The file is streamed line by line; it is never read into a report.

[Ramp] (IBIS 4.1 section 6): dV/dt_r = (20 % to 80 % voltage swing) / (time of that swing) into R_load, for the
rising edge; dV/dt_f for the falling edge. The edge time used is the dt: a 20-80 % time, which is shorter than the
10-90 % time of the same edge (1.33 x for a linear ramp), so it is the conservative one for the detour budget.
Corners: the columns are typ, min (slow, weak) and max (fast, strong). ramp_edges() takes the shortest dt of the
corners asked (default typ and max): the fastest edge.

  python3 tools/ibis_ramp.py FILE.ibs MODEL      print the ramp and C_comp of one model
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
                                                         'ramp': {}, 'r_load': None})
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
    print(f"{m['name']} {m['type']} C_comp {m['c_comp']} R_load {m['r_load']} ramp {m['ramp']} -> {e}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
