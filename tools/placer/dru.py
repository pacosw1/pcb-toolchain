"""Placement rules from a board .kicad_dru (single source: a DRU change flows into the placer model).

parse(text) -> {'domains': [(class pattern, gap to other nets, gap between two classes of the domain)],
                'holes': [(class pattern, (refs, ...), hole clearance)],
                'ignored': [names of clearance/creepage/hole rules the model cannot read]}
Read forms (gap = the larger of clearance and creepage):
  A.NetClass == 'P' && B.NetClass != 'P'                                -> domain P, gap to other nets
  A.NetClass == 'P' && B.NetClass == 'P' && A.NetClass != B.NetClass    -> gap between two classes of P
  A.NetClass == 'P' && ... (B.Reference == 'H1' || ...) + hole_clearance -> hole rule for those refs
Rules limited to one footprint, net names, courtyards or diff pairs are local exceptions: not read, not listed.
Other rules with a net-class condition and a clearance, creepage or hole constraint are listed in 'ignored'.
"""
import re

GAPS = ('clearance', 'creepage', 'hole_clearance')
LOCAL = ('memberOfFootprint', 'NetName', 'intersectsCourtyard', 'DiffPair', 'isCoupledDiffPair')


def _tokens(text):
    text = '\n'.join(line for line in text.splitlines() if not line.lstrip().startswith('#'))
    return re.findall(r'"(?:[^"\\]|\\.)*"|\(|\)|[^\s()]+', text)


def _tree(tokens):
    stack = [[]]
    for t in tokens:
        if t == '(':
            stack.append([])
        elif t == ')':
            x = stack.pop()
            stack[-1].append(x)
        else:
            stack[-1].append(t[1:-1] if t.startswith('"') else t)
    return stack[0]


def _mm(v):
    return float(v[:-2]) if v.endswith('mm') else float(v)


def _rules(text):
    for x in _tree(_tokens(text)):
        if not (isinstance(x, list) and x and x[0] == 'rule'):
            continue
        cond, gaps = '', {}
        for y in x[2:]:
            if y[0] == 'condition':
                cond = y[1]
            elif y[0] == 'constraint' and y[1] in GAPS:
                gaps[y[1]] = next(_mm(z[1]) for z in y[2:] if isinstance(z, list) and z[0] == 'min')
        yield x[1], cond, gaps


def parse(text):
    doms, cls, holes, ignored = {}, {}, [], []
    for name, cond, gaps in _rules(text):
        if not gaps or 'NetClass' not in cond or any(k in cond for k in LOCAL):
            continue
        c = cond.replace(' ', '')
        a = re.fullmatch(r"A\.NetClass=='([^']+)'&&B\.NetClass!='\1'", c)
        b = re.fullmatch(r"A\.NetClass=='([^']+)'&&B\.NetClass=='\1'&&A\.NetClass!=B\.NetClass", c)
        h = re.match(r"A\.NetClass=='([^']+)'&&", c)
        refs = re.findall(r"B\.Reference=='([^']+)'", c)
        gap = max(gaps.get('clearance', 0.0), gaps.get('creepage', 0.0))
        if a and gap:
            doms[a.group(1)] = max(doms.get(a.group(1), 0.0), gap)
        elif b and gap:
            cls[b.group(1)] = max(cls.get(b.group(1), 0.0), gap)
        elif h and refs and 'hole_clearance' in gaps:
            holes.append((h.group(1), tuple(refs), gaps['hole_clearance']))
        else:
            ignored.append(name)
    return {'domains': [(p, g, cls.get(p, 0.0)) for p, g in doms.items()], 'holes': holes,
            'ignored': sorted(set(ignored) | {p for p in cls if p not in doms})}
