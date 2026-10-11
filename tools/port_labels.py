#!/usr/bin/env python3
"""Gate: every connector has port labels on F.SilkS (user rule 2026-09-27).

Label layers: F.SilkS by default. A board's port-labels.json may set "silk_layers" (for example
["F.SilkS", "B.SilkS"]) with a "silk_layers_reason" naming the user decision (BASE-PWR-B: D-132, user
2026-10-11, port labels may be on the bottom side). A label on any listed layer counts.

A connector is a top-side footprint with reference J*, P* or CN*. Each pad with a
net must have its own F.SilkS text (gr_text, or fp_text user of any footprint)
within --dist mm. A text names only its nearest checked pad. Each connector also
needs a title: a text within --title-dist mm of its pads that is not the only
label of a pad. References do not count: a text that is the exact reference of a
footprint and stands within 5 mm of that footprint (anchor or pad). The same text
far from that part ("C1" as an RTD lead name) is a label.

Skipped pads: no net, "unconnected-*", NC, CHASSIS or SHIELD nets, NPTH, mounting and shield pads
(number empty, MP, SH, EP, MH, S<n>, SH<n>). A footprint with no checked pad
(for example a mounting hole with a P reference) is not a port.

Exemptions: <board>/port-labels.json {"exempt": [{"ref", "pads": [..] | "all", "reason"},
{"ref", "title": true, "reason"}, {"ref", "skip": [..], "reason"}]}. "skip" removes
a pad (for example a mounting pad with a pin number) before labels are assigned.
Each entry needs a reason. An entry that matches
no failure fails the gate (STALE).

  python3 tools/port_labels.py BOARD.kicad_pcb [--json] [--dist 4] [--title-dist 8] [--exempt FILE]
Exit 1 on any failure.
"""
import json
import math
import os
import re
import sys

CONN = re.compile(r'^(J|P|CN)\d')
SKIP_NUM = re.compile(r'^(|MP\d*|SH\d*|EP|MH\d*|S\d*)$', re.I)
SKIP_NET = re.compile(r'^(unconnected-.*|/?NC|/?N/C|/?CHASSIS|/?SHIELD|/?SHLD)$', re.I)
REF_NEAR = 5.0   # mm: a reference text stands next to its own part
TOKEN = re.compile(r'\s*(?:(\()|(\))|"((?:[^"\\]|\\.)*)"|([^\s()"]+))')


def parse(text):
    """KiCad s-expression -> nested lists of str."""
    stack, cur = [], []
    for m in TOKEN.finditer(text):
        if m.group(1):
            stack.append(cur)
            cur = []
        elif m.group(2):
            done, cur = cur, stack.pop()
            cur.append(done)
        elif m.group(3) is not None:
            cur.append(m.group(3).replace('\\"', '"'))
        elif m.group(4):
            cur.append(m.group(4))
    return cur[0]


def kids(node, name):
    return [c for c in node[1:] if isinstance(c, list) and c and c[0] == name]


def one(node, name):
    k = kids(node, name)
    return k[0] if k else None


def at(node):
    a = one(node, 'at')
    return (float(a[1]), float(a[2]), float(a[3]) if len(a) > 3 else 0.0) if a else (0.0, 0.0, 0.0)


def pad_xy(fp_at, local):
    """Board position of a footprint-local point (KiCad: y down, angle counter-clockwise)."""
    fx, fy, rot = fp_at
    a = math.radians(rot)
    x = fx + local[0] * math.cos(a) + local[1] * math.sin(a)
    y = fy - local[0] * math.sin(a) + local[1] * math.cos(a)
    return (round(x, 6), round(y, 6))



SILK = {'F.SilkS'}   # label layers; port-labels.json silk_layers may add B.SilkS

def layer(node):
    lay = one(node, 'layer')
    return lay[1] if lay else None


def board_items(text):
    """Return (connectors, texts, refs). connectors: ref -> list of (num, net, x, y)."""
    root = parse(text)
    conns, texts, refs = {}, [], {}
    for f in kids(root, 'footprint'):
        fat = at(f)
        ref = next((p[2] for p in kids(f, 'property') if p[1] == 'Reference'), None)
        if ref is None:
            t = next((t for t in kids(f, 'fp_text') if t[1] == 'reference'), None)
            ref = t[2] if t else ''
        refs.setdefault(ref, []).extend([fat[:2]] + [pad_xy(fat, at(p)[:2]) for p in kids(f, 'pad')])
        for t in kids(f, 'fp_text'):
            if t[1] == 'user' and layer(t) in SILK and not one(t, 'hide'):
                lx, ly, _ = at(t)
                texts.append((t[2], pad_xy(fat, (lx, ly))))
        if not CONN.match(ref) or layer(f) != 'F.Cu':
            continue
        pads = []
        for p in kids(f, 'pad'):
            net = one(p, 'net')
            netname = net[-1] if net else ''
            if p[2] == 'np_thru_hole' or not netname or SKIP_NUM.match(p[1]) or SKIP_NET.match(netname):
                pads.append((p[1], None) + pad_xy(fat, at(p)[:2]))
            else:
                pads.append((p[1], netname) + pad_xy(fat, at(p)[:2]))
        if any(p[1] for p in pads):  # a footprint with no checked pad (mounting hole) is no port
            conns[ref] = pads
    for t in kids(root, 'gr_text'):
        if layer(t) in SILK:
            x, y, _ = at(t)
            texts.append((t[1], (x, y)))
    texts = [(s, xy) for s, xy in texts if s != '${REFERENCE}' and s.strip() and not is_reference(s, xy, refs)]
    return conns, texts


def is_reference(s, xy, refs, near=REF_NEAR):
    """A text is a reference designator only when it is the exact reference of a footprint AND it stands within
    near mm of that footprint (its anchor or a pad). A port label that reads like a reference ("C1" for RTD lead C,
    "RTD1 C", "COM") far from that part is a label (2026-10-07: the RTD labels were renamed 1A/1C/1B to pass)."""
    pts = refs.get(s)
    return bool(pts) and any(math.hypot(x - xy[0], y - xy[1]) <= near for x, y in pts)


def box_dist(xy, pads):
    xs = [p[2] for p in pads]
    ys = [p[3] for p in pads]
    dx = max(min(xs) - xy[0], xy[0] - max(xs), 0)
    dy = max(min(ys) - xy[1], xy[1] - max(ys), 0)
    return math.hypot(dx, dy)


def check(text, dist=4.0, title_dist=8.0, exempt=()):
    for e in exempt:
        if not str(e.get('reason', '')).strip():
            raise ValueError('exemption without a reason: %r' % (e,))
    conns, texts = board_items(text)
    stale = []
    for e in exempt:
        for n in e.get('skip', []):
            pads = conns.get(e['ref'], [])
            hit = [i for i, p in enumerate(pads) if p[0] == str(n) and p[1]]
            if not hit:
                stale.append('STALE exempt %s skip %s: no such pad with a net' % (e['ref'], n))
            for i in hit:
                pads[i] = (pads[i][0], None) + pads[i][2:]
    checked = [(ref, p) for ref, pads in conns.items() for p in pads if p[1]]
    labels = {}  # (ref, num) -> list of text indexes
    for i, (_, xy) in enumerate(texts):
        best = min(checked, key=lambda rp: math.hypot(rp[1][2] - xy[0], rp[1][3] - xy[1]), default=None)
        if best and math.hypot(best[1][2] - xy[0], best[1][3] - xy[1]) <= dist:
            labels.setdefault((best[0], best[1][0]), []).append(i)
    sole = {v[0] for v in labels.values() if len(v) == 1}
    missing = {(ref, p[0]): p[1] for ref, p in checked if not labels.get((ref, p[0]))}
    no_title = {ref for ref, pads in conns.items()
                if not any(i not in sole and box_dist(xy, pads) <= title_dist for i, (_, xy) in enumerate(texts))}
    ex_pads, ex_title = set(), set()
    for e in exempt:
        ref = e['ref']
        if 'skip' in e:
            continue
        if ref not in conns:
            stale.append('STALE exempt %s: no such connector' % ref)
        elif e.get('title'):
            ex_title.add(ref)
            if ref not in no_title:
                stale.append('STALE exempt %s title: the connector has a title' % ref)
        elif e.get('pads') == 'all':
            nums = [p[0] for p in conns[ref] if p[1]]
            ex_pads |= {(ref, n) for n in nums}
            if not any((ref, n) in missing for n in nums):
                stale.append('STALE exempt %s all pads: every pad has a label' % ref)
        else:
            for n in e.get('pads', []):
                ex_pads.add((ref, str(n)))
                if (ref, str(n)) not in missing:
                    stale.append('STALE exempt %s pad %s: the pad has a label' % (ref, n))
    natural = lambda k: (k[0], [int(s) if s.isdigit() else s for s in re.split(r'(\d+)', k[1])])
    failures = ['FAIL %s pad %s (%s): no %s label within %.1f mm' % (k[0], k[1], missing[k], '/'.join(sorted(SILK)), dist)
                for k in sorted(missing, key=natural) if k not in ex_pads]
    failures += ['FAIL %s: no title text within %.1f mm' % (ref, title_dist) for ref in sorted(no_title - ex_title)]
    return {'connectors': len(conns), 'pads': len(checked), 'failures': failures + stale}


def default_exempt(pcb):
    d = os.path.dirname(os.path.abspath(pcb))
    while True:
        f = os.path.join(d, 'port-labels.json')
        if os.path.exists(f):
            return f
        if os.path.basename(os.path.dirname(d)) == 'boards' or os.path.dirname(d) == d:
            return None
        d = os.path.dirname(d)


def main(argv):
    args = list(argv)
    opt = {'--dist': 4.0, '--title-dist': 8.0}
    for k in opt:
        if k in args:
            i = args.index(k)
            opt[k] = float(args[i + 1])
            del args[i:i + 2]
    ex_file = None
    if '--exempt' in args:
        i = args.index('--exempt')
        ex_file = args[i + 1]
        del args[i:i + 2]
    as_json = '--json' in args
    args = [a for a in args if a != '--json']
    if len(args) != 1:
        sys.exit(__doc__)
    pcb = args[0]
    ex_file = ex_file or default_exempt(pcb)
    if ex_file:
        cfg = json.load(open(ex_file))
        if 'silk_layers' in cfg:
            layers = cfg['silk_layers']
            if (not isinstance(layers, list) or not layers or not all(l in ('F.SilkS', 'B.SilkS') for l in layers)
                    or not str(cfg.get('silk_layers_reason', '')).strip()):
                sys.exit('port_labels: silk_layers needs F.SilkS/B.SilkS entries and a silk_layers_reason')
            SILK.clear()
            SILK.update(layers)
    exempt = []
    if ex_file:
        with open(ex_file) as fh:
            exempt = json.load(fh)['exempt']
    with open(pcb) as fh:
        text = fh.read()
    r = check(text, opt['--dist'], opt['--title-dist'], exempt)
    r['exempt_file'] = ex_file
    if as_json:
        print(json.dumps(r, indent=2))
    else:
        for f in r['failures']:
            print(f)
        print('port_labels: %d connectors, %d pads, %d failures%s'
              % (r['connectors'], r['pads'], len(r['failures']), ' (exempt: %s)' % ex_file if ex_file else ''))
    return 1 if r['failures'] else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
