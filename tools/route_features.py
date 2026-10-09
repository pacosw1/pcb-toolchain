#!/usr/bin/env python3
"""Routing-flow feature switches (tools/route-features.json) and the DSN side of them (2026-10-09).

  python3 tools/route_features.py show [BOARD | PCB]        the resolved switches (defaults, gate.json, environment)
  python3 tools/route_features.py rules PCB [--layers F.Cu,B.Cu]
                                                           what the rule compiler makes of the board .kicad_dru

Resolution order (later wins): tools/route-features.json -> <board>/gate.json "route_features" (merged per feature)
-> environment ROUTE_FEATURES="name=1,name=0" ("all=1" / "all=0" set every flag first). The board is ROUTE_BOARD
(name under hardware-design/boards/) or found from the PCB path (<board>/cad/<X>/<X>.kicad_pcb).

DSN helpers used by tools/fastroute_job.py (the ideas come from TraceMaker's rule-to-legality compiler, doc 05 s27, and
its keep-vias-off-pads option, s26; this code is our own):
  compile_dru(dru_text, nets, net_class, pad_layers, layers, extra) -> per-net allowed layers, class_class clearances, notes
  apply_layer_masks(dsn, masks)      split DSN classes so each mask group gets (use_layer ...) in its circuit
  add_class_class(dsn, pairs)        (class_class (classes A B) (rule (clearance um))) in the network section
  add_via_keepouts(dsn, polys)       (via_keepout "" (polygon LAYER 0 x y ...)) in the structure section
No pcbnew import here: the caller gives the board data.
"""
import fnmatch
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULTS = os.path.join(ROOT, 'tools', 'route-features.json')
FLAGS = ('triage_opens', 'rule_compiler', 'via_off_small_pads', 'pin_escape_check', 'via_halo')


# ---------------------------------------------------------------- configuration
def board_dir(pcb=None, board=None):
    """Board folder (hardware-design/boards/<B>) or None."""
    board = board or os.environ.get('ROUTE_BOARD', '')
    if board:
        d = os.path.join(ROOT, 'hardware-design', 'boards', board)
        return d if os.path.isdir(d) else None
    if pcb:
        d = os.path.dirname(os.path.abspath(pcb))
        for _ in range(4):
            if os.path.isfile(os.path.join(d, 'gate.json')):
                return d
            d = os.path.dirname(d)
    return None


def load(pcb=None, board=None):
    cfg = json.load(open(DEFAULTS))['features']
    bd = board_dir(pcb, board)
    if bd and os.path.isfile(os.path.join(bd, 'gate.json')):
        over = json.load(open(os.path.join(bd, 'gate.json'))).get('route_features', {})
        for k, v in over.items():
            cfg.setdefault(k, {}).update(v)
    env = os.environ.get('ROUTE_FEATURES', '')
    items = [kv.split('=', 1) for kv in env.split(',') if '=' in kv]
    for k, v in items:          # all= first, so "all=0,via_halo=1" works
        if k.strip() == 'all':
            for f in FLAGS:
                cfg[f]['on'] = v.strip() not in ('0', 'off', 'false', '')
    for k, v in items:
        k = k.strip()
        if k in cfg:
            cfg[k]['on'] = v.strip() not in ('0', 'off', 'false', '')
    cfg['_board_dir'] = bd
    return cfg


def on(cfg, name):
    return bool(cfg.get(name, {}).get('on'))


def summary(cfg):
    return ' '.join(f"{f}={'on' if on(cfg, f) else 'off'}" for f in FLAGS)


# ---------------------------------------------------------------- .kicad_dru
def sexpr(text):
    """Tiny s-expression reader (strings in double quotes, # comments)."""
    toks = re.findall(r'"(?:[^"\\]|\\.)*"|[()]|[^\s()"]+', re.sub(r'(?m)^\s*#.*$', '', text))
    stack, cur = [], []
    for t in toks:
        if t == '(':
            stack.append(cur)
            cur = []
        elif t == ')':
            done, cur = cur, stack.pop()
            cur.append(done)
        else:
            cur.append(t[1:-1] if t.startswith('"') else t)
    return cur


class Unknown(Exception):
    pass


class Glob(str):
    """KiCad rule strings compare with wildcards (* and ?)."""
    def __eq__(self, other):
        return fnmatch.fnmatchcase(str(self), str(other)) or fnmatch.fnmatchcase(str(other), str(self))

    def __ne__(self, other):
        return not self.__eq__(other)

    __hash__ = str.__hash__


class Obj:
    """One side (A or B) of a rule condition. Only NetClass, NetName, Type, inDiffPair are known; anything else raises
    Unknown and the rule is reported as not compiled."""
    def __init__(self, net=None, cls=None, kind=None):
        self._net, self._cls, self._kind = net, cls, kind

    def __getattr__(self, k):
        if k == 'NetClass' and self._cls is not None:
            return Glob(self._cls)
        if k == 'NetName' and self._net is not None:
            return Glob(self._net)
        if k == 'Type' and self._kind is not None:
            return Glob(self._kind)
        if k == 'inDiffPair' and self._net is not None:
            n = self._net
            return lambda base: any(n == base + s for s in ('_P', '_N', '+', '-', 'P', 'N'))
        raise Unknown(k)


def cond_eval(cond, A, B):
    expr = cond.replace('&&', ' and ').replace('||', ' or ')
    expr = re.sub(r'!(?!=)', ' not ', expr)
    return bool(eval(expr, {'__builtins__': {}}, {'A': A, 'B': B}))


def mm(v):
    m = re.match(r'([\d.]+)\s*(mm|mil|in)?', v)
    x = float(m.group(1))
    return x * {'mil': 0.0254, 'in': 25.4}.get(m.group(2) or 'mm', 1.0)


def dru_rules(text):
    out = []
    for r in sexpr(text):
        if not isinstance(r, list) or not r or r[0] != 'rule':
            continue
        rule = {'name': r[1], 'layer': None, 'condition': 'True', 'constraints': []}
        for e in r[2:]:
            if not isinstance(e, list):
                continue
            if e[0] == 'layer':
                rule['layer'] = e[1]
            elif e[0] == 'condition':
                rule['condition'] = e[1]
            elif e[0] == 'constraint':
                rule['constraints'].append(e[1:])
        out.append(rule)
    return out


def compile_dru(dru_text, nets, net_class, pad_layers, layers, extra=()):
    """nets: routed net names; net_class: net -> DSN class; pad_layers: net -> set of SMD pad layers ('*' = a
    through-hole pad); layers: job signal layers (ordered). extra: config rules {nets, classes, deny_layers, no_via}.
    Returns (masks {net: [layers]} for nets that lose a layer, pairs {(cls_a, cls_b): clearance_mm}, notes [str])."""
    deny, noval, notes = {}, set(), []
    pairs = {}
    classes = sorted(set(net_class.values()))
    for r in dru_rules(dru_text):
        for c in r['constraints']:
            kind = c[0]
            if kind == 'disallow':
                what = set(c[1:])
                hit = 0
                try:
                    for n in nets:
                        if 'track' in what and cond_eval(r['condition'], Obj(n, net_class.get(n), 'Track'), Obj()):
                            if r['layer'] is None:
                                notes.append(f"rule '{r['name']}': disallow track on every layer for {n}: not compiled")
                            else:
                                deny.setdefault(n, set()).add(r['layer'])
                                hit += 1
                        if 'via' in what and cond_eval(r['condition'], Obj(n, net_class.get(n), 'Via'), Obj()):
                            noval.add(n)
                            hit += 1
                    if what & {'track', 'via'}:
                        notes.append(f"rule '{r['name']}': disallow {'/'.join(sorted(what & {'track', 'via'}))} -> {hit} net(s)")
                except Unknown as e:
                    notes.append(f"rule '{r['name']}': term {e} not supported, not compiled")
                except Exception as e:  # noqa: BLE001  a condition we cannot read is reported, not guessed
                    notes.append(f"rule '{r['name']}': condition not read ({e}), not compiled")
            elif kind == 'clearance':
                mn = [x for x in c[1:] if isinstance(x, list) and x[0] == 'min']
                if not mn or 'B.' not in r['condition']:
                    continue
                v = mm(mn[0][1])
                try:
                    hit = 0
                    for ca in classes:
                        for cb in classes:
                            if cond_eval(r['condition'], Obj(cls=ca), Obj(cls=cb)):
                                key = tuple(sorted((ca, cb)))
                                pairs[key] = max(pairs.get(key, 0), v)
                                hit += 1
                    notes.append(f"rule '{r['name']}': clearance {v:g} mm -> {hit} class pair(s)")
                except Unknown as e:
                    notes.append(f"rule '{r['name']}': clearance term {e} not supported, not compiled")
                except Exception as e:  # noqa: BLE001
                    notes.append(f"rule '{r['name']}': clearance condition not read ({e}), not compiled")
    for x in extra or ():
        sel = [n for n in nets if any(fnmatch.fnmatchcase(n, g) for g in x.get('nets', []))
               or net_class.get(n) in x.get('classes', [])]
        for n in sel:
            deny.setdefault(n, set()).update(x.get('deny_layers', []))
            if x.get('no_via'):
                noval.add(n)
        notes.append(f"extra rule {x.get('about', x)}: {len(sel)} net(s)")
    masks = {}
    for n in nets:
        allow = [l for l in layers if l not in deny.get(n, set())]
        if n in noval:
            smd = pad_layers.get(n, set()) - {'*'}
            one = [l for l in allow if (not smd or smd == {l})]
            if len(smd) > 1 or not one:
                notes.append(f"via ban on {n}: SMD pads on {sorted(smd)}, allowed {allow}: cannot be one layer, left as is")
            else:
                allow = one[:1] if smd else [l for l in allow if l in ('F.Cu', 'B.Cu')][:1] or allow[:1]
        if not allow:
            notes.append(f"{n}: every job layer denied, left as is")
            continue
        if allow != list(layers):
            masks[n] = allow
    return masks, pairs, notes


# ---------------------------------------------------------------- DSN edits
CLASS_RE = re.compile(r'\(class (\S+) ((?:"[^"]*"|[^()"])*?)(\(circuit.*?\n    \))', re.S)


def dsn_classes(text):
    """{net: class} from the DSN network section."""
    out = {}
    for m in CLASS_RE.finditer(text):
        for t in re.findall(r'"[^"]*"|\S+', m.group(2)):
            out[t.strip('"')] = m.group(1)
    return out


def apply_layer_masks(text, masks):
    """Each net with a mask moves to a copy of its class "<class>__L<k>" whose circuit has (use_layer ...)."""
    if not masks:
        return text
    groups = {}
    for n, ls in masks.items():
        groups.setdefault(tuple(ls), set()).add(n)
    keys = {g: i for i, g in enumerate(sorted(groups))}
    add = []

    def split(m):
        head, names, tail = m.group(1), m.group(2), m.group(3)
        toks = re.findall(r'"[^"]*"|\S+', names)
        keep = [t for t in toks if t.strip('"') not in masks]
        moved = {}
        for t in toks:
            n = t.strip('"')
            if n in masks:
                moved.setdefault(tuple(masks[n]), []).append(t)
        for ls, ts in moved.items():
            t2 = re.sub(r'\(circuit', '(circuit\n        (use_layer ' + ' '.join(ls) + ')', tail, count=1)
            add.append(f"    (class {head}__L{keys[ls]} " + ' '.join(ts) + "\n      " + t2.lstrip())
        if not moved:
            return m.group(0)
        return f"(class {head} " + ' '.join(keep) + "\n      " + tail.lstrip()
    text = CLASS_RE.sub(split, text)
    i = text.rfind("    (class ")
    j = text.find("\n    )", i) + len("\n    )")
    return text[:j] + "\n" + "\n".join(add) + text[j:]


def add_class_class(text, pairs):
    """pairs: {(kicad_class_a, kicad_class_b): mm}. Every DSN class whose base name (before __ or _RPV) is one of the
    pair gets the rule, so split classes keep it."""
    if not pairs:
        return text
    dsn = sorted({m.group(1) for m in CLASS_RE.finditer(text)})
    base = lambda c: re.sub(r'(__L\d+|_RPV)+$', '', c)  # noqa: E731
    lines = []
    for (ca, cb), v in sorted(pairs.items()):
        for x in dsn:
            for y in dsn:
                if x <= y and {base(x), base(y)} == {ca, cb} and (ca != cb or base(x) == base(y) == ca):
                    lines.append(f"    (class_class (classes {x} {y})\n      (rule (clearance {int(round(v * 1000))}))\n    )")
    i = text.rfind("    (class ")
    j = text.find("\n    )", i) + len("\n    )")
    return text[:j] + "\n" + "\n".join(lines) + text[j:]


def add_via_keepouts(text, polys):
    """polys: [(layer, [(x_mm, y_mm), ...])] in board coordinates; DSN uses um with y negated."""
    if not polys:
        return text
    out = []
    for layer, pts in polys:
        p = pts + pts[:1]
        coords = '  '.join(f"{x * 1000:.0f} {-y * 1000:.0f}" for x, y in p)
        out.append(f'    (via_keepout "" (polygon {layer} 0  {coords}))')
    i = text.find('(structure')
    j = text.find('\n    (via', i)          # before the (via ...) padstack list of the structure
    if j < 0:
        j = text.find('\n    (rule', i)
    return text[:j] + '\n' + '\n'.join(out) + text[j:]


def halo_nets(cfg, nets, net_class, bd):
    """Nets that get the via halo padstack (feature via_halo)."""
    h = cfg['via_halo']
    want = set()
    globs = list(h.get('nets', []))
    if bd and h.get('fast_nets_file') and os.path.isfile(os.path.join(bd, h['fast_nets_file'])):
        globs += json.load(open(os.path.join(bd, h['fast_nets_file']))).get('fast', [])
    if bd and h.get('learn_noroom') and os.path.isfile(os.path.join(bd, '.gate', 'halo-nets.json')):
        globs += json.load(open(os.path.join(bd, '.gate', 'halo-nets.json'))).get('nets', [])
    for n in nets:
        if any(fnmatch.fnmatchcase(n, g) for g in globs) or net_class.get(n) in h.get('classes', []):
            want.add(n)
    if not globs and not h.get('classes'):
        want = set(nets)   # no list: every routed net
    return sorted(want)


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ('show', 'rules'):
        sys.exit(__doc__)
    if sys.argv[1] == 'show':
        arg = sys.argv[2] if len(sys.argv) > 2 else ''
        cfg = load(pcb=arg if arg.endswith('.kicad_pcb') else None, board=None if arg.endswith('.kicad_pcb') else arg)
        print(summary(cfg))
        print(json.dumps({k: v for k, v in cfg.items() if k != '_board_dir'}, indent=1))
        return
    pcb = sys.argv[2]
    layers = sys.argv[sys.argv.index('--layers') + 1].split(',') if '--layers' in sys.argv else ['F.Cu', 'B.Cu']
    import pcbnew
    b = pcbnew.LoadBoard(pcb)
    tmp = '/tmp/route_features_rules.dsn'
    pcbnew.ExportSpecctraDSN(b, tmp)
    nc = dsn_classes(open(tmp).read())
    pl = {}
    for fp in b.GetFootprints():
        for p in fp.Pads():
            pl.setdefault(p.GetNetname(), set()).add('*' if p.GetDrillSize().x else p.GetLayerName())
    dru = os.path.splitext(pcb)[0] + '.kicad_dru'
    masks, pairs, notes = compile_dru(open(dru).read() if os.path.isfile(dru) else '', sorted(nc), nc, pl, layers,
                                      load(pcb)['rule_compiler'].get('extra', []))
    print('\n'.join(notes))
    print(f'masks {len(masks)}: ' + ', '.join(f'{n}={"/".join(v)}' for n, v in sorted(masks.items())[:30]))
    print('class_class: ' + ', '.join(f'{a}-{b} {v:g}' for (a, b), v in sorted(pairs.items())))


if __name__ == '__main__':
    main()
