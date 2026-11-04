"""DRU pair rules for the router (isolation boards, DESIGN.md 5b 2026-11-01 isolation).

A pair rule is a .kicad_dru clearance / creepage / hole_clearance constraint whose condition reads both items (for
example `A.NetClass == 'POE' && B.NetClass != 'POE'`). The per-net model (model.py) cannot hold it: the value depends
on the pair. This module gives each item a clearance group (items whose atoms are equal behave the same in every pair
rule) and resolves the value of each group pair with the KiCad 10 order, confirmed with kicad-cli DRC on test boards
(tools/router/test_pairrules.py, reports/2026-11-01-isolation.md):

  - the condition is tested with (A, B) and with (B, A);
  - of the matching rules of one constraint type, the LAST in the file wins (not the largest value);
  - a custom rule replaces the netclass clearance; no rule = the netclass clearance (the core default stays).

Creepage (KiCad: a surface path on one copper layer, around slots; no creepage between layers) is used in its safe
form: the straight copper-to-copper distance on a layer is never longer than the surface path, so a straight
clearance >= the creepage value on every layer is safe and conservative. KiCad DRC creepage stays the judge.

Spatial selectors (intersectsCourtyard('J1'), intersectsArea('X'), ...) are region atoms. Pads and zones get them
from the board geometry (pcbnew Collide). Routed tracks and vias get them in the core from the region polygons: a
piece intersects only when its own copper does, and KiCad evaluates the whole written segment, which contains the
piece, so KiCad's atom is True whenever the core's is. That is safe only when a True region atom never raises the
value (a relaxation, as POE 'PoE isolation inside J1'); a raising region atom on a routed item is refused (unknown).
The evaluator is route_rule_coverage._condition (three-valued, never executes the selector); the functions it does not
know are replaced by True / False first, from the item attributes, or left in place (UNKNOWN).
"""
import fnmatch
import re

import route_rule_coverage as rrc

PAIR_KINDS = ('clearance', 'creepage', 'hole_clearance')
REGION_FNS = ('intersectsCourtyard', 'intersectsFrontCourtyard', 'intersectsBackCourtyard', 'intersectsArea')
# a rule that reads one of these on B is a pair rule (B.Type alone is the zone rule of model.py; isCoupledDiffPair is
# the pairs stage)
PAIR_TRIGGER = re.compile(r"\bB\.(NetClass|NetName|Net|Reference|Pad_Number|Pad_Type|memberOfFootprint|intersects\w*|inside\w*|enclosedByArea|hasNetclass)\b"
                          r"|\bA\.\w+\s*[!=]=\s*B\.\w+")
CALL = re.compile(r"\b([AB])\.(\w+)\(\s*(?:'([^']*)')?\s*\)")
BIN = re.compile(r"\b([AB])\.(\w+)\s*(==|!=)\s*([AB])\.(\w+)\b(?!\s*\()")
CMP = re.compile(r"\b([AB])\.(\w+)\s*(==|!=)\s*'([^']*)'")
QUOTED = re.compile(r"""'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*\"""")


def _spans(expr):
    return [m.span() for m in QUOTED.finditer(expr)]


def _in_quotes(pos, spans):
    return any(a <= pos < b for a, b in spans)


def substitute(expr, a, b):
    """The condition with the functions rrc._condition does not know replaced by True / False (or left in place when
    the item has no value for it: UNKNOWN)."""
    sides = {'A': a, 'B': b}

    def call(m):
        it, fn, arg = sides[m[1]], m[2], m[3]
        if fn == 'memberOfFootprint':
            ref = it.get('Reference')
            v = bool(ref) and fnmatch.fnmatchcase(ref, arg or '')
        elif fn in REGION_FNS or fn.startswith('inside') or fn == 'enclosedByArea':
            v = (it.get('regions') or {}).get(f'{fn}:{arg}')
            if v is None:
                return m[0]
        elif fn == 'isCoupledDiffPair':
            pa, pb = a.get('Pair'), b.get('Pair')
            v = bool(pa) and pa == pb and a.get('NetName') != b.get('NetName')
        elif fn == 'hasNetclass':
            v = isinstance(it.get('NetClass'), str) and fnmatch.fnmatchcase(it['NetClass'], arg or '')
        else:
            return m[0]
        return ' True ' if v else ' False '

    def binary(m):
        l, r = sides[m[1]].get(m[2]), sides[m[4]].get(m[5])
        if l is None or r is None:
            return m[0]
        eq = l == r
        return ' True ' if (eq if m[3] == '==' else not eq) else ' False '

    for pat, fn in ((CALL, call), (BIN, binary)):
        spans, out, end = _spans(expr), [], 0
        for m in pat.finditer(expr):
            if _in_quotes(m.start(), spans):
                continue
            out.append(expr[end:m.start()])
            out.append(fn(m))
            end = m.end()
        out.append(expr[end:])
        expr = ''.join(out)
    return expr


def cond(expr, a, b):
    """Three-valued: True, False or rrc.UNKNOWN."""
    if expr in (None, '', 'True'):
        return True
    return rrc._condition(substitute(expr, a, b), a, b)


def atoms(expr):
    """Unary atoms of a condition, side-free: ('cmp', attr, literal), ('call', fn, arg); and the binary attributes
    (attributes compared between A and B; 'Pair' for isCoupledDiffPair). Region atoms are ('call', fn, arg) with fn in
    REGION_FNS."""
    un, bi = set(), set()
    if not isinstance(expr, str):
        return un, bi
    spans = _spans(expr)
    for m in BIN.finditer(expr):
        if not _in_quotes(m.start(), spans):
            bi.update((m[2], m[5]))
    for m in CALL.finditer(expr):
        if _in_quotes(m.start(), spans):
            continue
        if m[2] == 'isCoupledDiffPair':
            bi.add('Pair')
        else:
            un.add(('call', m[2], m[3] or ''))
    for m in CMP.finditer(expr):
        if not _in_quotes(m.start(), spans):
            un.add(('cmp', m[2], m[4]))
    return un, bi


def atom_value(atom, item):
    """Value of a unary atom for one item (the item on both sides), True / False / None (unknown)."""
    if atom[0] == 'cmp':
        v = rrc._condition(f"A.{atom[1]} == '{atom[2]}'", item, item)
    else:
        v = cond(f"A.{atom[1]}('{atom[2]}')" if atom[2] else f"A.{atom[1]}()", item, item)
    return v if isinstance(v, bool) else None


class Rules:
    """The pair-kind constraints of a .kicad_dru, in file order: (rule, kind, condition, min, layer)."""

    def __init__(self, forms):
        self.items = []
        for form in forms:
            if form == ['version', '1'] or len(form) < 2:
                continue
            c = (rrc._children(form, 'condition') or [[None, 'True']])[0][1]
            layer = (rrc._children(form, 'layer') or [[None, None]])[0][1]
            for con in rrc._children(form, 'constraint'):
                if con[1] not in PAIR_KINDS:
                    continue
                vals = {x[0]: x[1] for x in con[2:] if isinstance(x, list) and len(x) == 2}
                if 'min' in vals:
                    self.items.append((form[1], con[1], c, float(rrc._number(vals['min'])), layer))

    def trigger(self, hole_scope):
        """Names of the pair rules: creepage, a clearance that reads B (not only B.Type), a hole rule whose scope
        model.py does not know. None of them = the board has no pair rules (the model stays as before)."""
        out = []
        for rule, kind, c, _, _ in self.items:
            if kind == 'creepage' or (kind == 'clearance' and PAIR_TRIGGER.search(str(c or '')))\
                    or (kind == 'hole_clearance' and hole_scope(c) is None):
                out.append((rule, kind))
        return out

    def resolve(self, kind, a, b, start=None):
        """(value, rule) of the last matching rule of `kind` for the item pair (both orders), None when no rule
        matches, rrc.UNKNOWN when a rule that may match cannot be decided. A rule with a layer clause applies only on
        that layer: the result is the larger of 'it applies' and 'it does not' (safe on every layer)."""
        rows = [r for r in self.items if r[1] == kind]
        rows = rows[:start] if start is not None else rows
        for i in range(len(rows) - 1, -1, -1):
            rule, _, c, mn, layer = rows[i]
            va, vb = cond(c, a, b), cond(c, b, a)
            if va is True or vb is True:
                if layer:
                    rest = self.resolve(kind, a, b, start=i)
                    if rest is rrc.UNKNOWN:
                        return rrc.UNKNOWN
                    return (mn, rule) if rest is None or rest[0] <= mn else rest
                return mn, rule
            if va is rrc.UNKNOWN or vb is rrc.UNKNOWN:
                return rrc.UNKNOWN
        return None


HOLE = {'via', 'pad_pth', 'npth'}
COPPER = {'track', 'via', 'pad_smd', 'pad_pth', 'zone'}


def build(rules, hole_scope, routed, pads, zones, regions):
    """The clearance groups and their pair table.

    routed: {net: item} (attributes of a track of the net, no 'regions'); pads: [item] (with static 'regions');
    zones: [item]; regions: [key] (the region atoms 'fn:arg' in the core's bit order). Items: NetName, NetClass,
    Type, Pad_Type, Reference, Pad_Number, Pair, kind (track / via / pad_smd / pad_pth / npth / zone).
    Returns dict(groups, table (n x n, row major, 0 = no pair value), var {net: {track: [g per region bits], via:
    [...]}}, pad_groups [g per pad], zone_groups [g per zone], clearance (n x n: the clearance part only, for the pour
    model), rules (names that decided a table entry)) or raises ValueError with the unknown pair."""
    un, bi = set(), set()
    for _, _, c, _, _ in rules.items:
        u, b2 = atoms(c)
        un |= u
        bi |= b2
    un = sorted(un)
    bi = sorted(bi)
    reps, gid = [], {}

    def group(item):
        sig = (item['kind'],) + tuple(atom_value(t, item) for t in un) + tuple(item.get(x) for x in bi)
        if sig not in gid:
            gid[sig] = len(reps)
            reps.append(item)
        return gid[sig]

    var = {}
    for net, it in sorted(routed.items()):
        var[net] = {}
        for kind, typ in (('track', 'Track'), ('via', 'Via')):
            gs = []
            for bits in range(1 << len(regions)):
                rg = {k: bool(bits >> i & 1) for i, k in enumerate(regions)}
                gs.append(group(dict(it, Type=typ, kind=kind, regions=rg)))
            var[net][kind] = gs
    pad_groups = [group(p) for p in pads]
    zone_groups = [group(z) for z in zones]
    n = len(reps)
    table, clr, used = [0.0] * (n * n), [0.0] * (n * n), set()
    for i in range(n):
        for j in range(i, n):
            a, b = reps[i], reps[j]
            v, c0 = 0.0, 0.0
            for kind in PAIR_KINDS:
                if kind != 'hole_clearance' and not (a['kind'] in COPPER and b['kind'] in COPPER):
                    continue
                if kind == 'hole_clearance' and not (a['kind'] in HOLE or b['kind'] in HOLE):
                    continue
                r = rules.resolve(kind, a, b)
                if r is rrc.UNKNOWN:
                    raise ValueError(f'{kind}: pair not decidable: {_name(a)} / {_name(b)}')
                if r is None:
                    continue
                val, rule = r
                if kind == 'hole_clearance':
                    # only a hole rule model.py does not apply (the core measures it from the item copper: safe)
                    cond_txt = next(x[2] for x in rules.items if x[0] == rule and x[1] == kind)
                    if hole_scope(cond_txt) is not None:
                        continue
                if kind == 'clearance':
                    c0 = max(c0, val)
                if kind == 'creepage' and 'zone' in (a['kind'], b['kind']):
                    continue  # the zone fill keeps the clearance only (KiCad filler); a zone's creepage is DRC's
                v = max(v, val)
                used.add((rule, kind))
            table[i * n + j] = table[j * n + i] = round(v, 6)
            clr[i * n + j] = clr[j * n + i] = round(c0, 6)
    # a True region atom of a routed item must never raise a value (see the module text)
    for net, kv in var.items():
        for kind, gs in kv.items():
            for bits, g in enumerate(gs):
                for k in range(len(regions)):
                    if bits >> k & 1:
                        g0 = gs[bits & ~(1 << k)]
                        for h in range(n):
                            if table[g * n + h] > table[g0 * n + h] + 1e-9:
                                raise ValueError(f'region {regions[k]} raises the value for {net} {kind} vs {_name(reps[h])}: '
                                                 'a raising spatial rule on routed copper is not modelled')
    return dict(groups=n, table=table, clearance=clr, var=var, pad_groups=pad_groups, zone_groups=zone_groups,
                rules=sorted(used), reps=[_name(r) for r in reps])


def _name(it):
    s = f"{it['kind']} {it.get('NetName') or '(no net)'}"
    if it.get('Reference'):
        s += f" {it['Reference']}.{it.get('Pad_Number', '')}"
    rg = [k for k, v in (it.get('regions') or {}).items() if v]
    return s + (f" in {','.join(rg)}" if rg else '')


def region_keys(rules):
    """Region atoms of the pair rules in a fixed order (the core's bit order)."""
    keys = set()
    for _, _, c, _, _ in rules.items:
        for t in atoms(c)[0]:
            if t[0] == 'call' and (t[1].startswith('inside') or t[1] == 'enclosedByArea'):
                raise ValueError(f'{t[1]}: only intersects* region selectors are modelled for routed copper')
            if t[0] == 'call' and t[1] in REGION_FNS:
                keys.add(f'{t[1]}:{t[2]}')
    return sorted(keys)


__all__ = ['Rules', 'build', 'cond', 'atoms', 'region_keys', 'substitute', 'PAIR_KINDS']
