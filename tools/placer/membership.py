#!/usr/bin/env python3
"""Block and component membership from the schematic, before placement (CLAUDE.md 4: blocks and components).

  $PY tools/placer/membership.py derive BOARD.kicad_sch BOARD.kicad_pcb -o members.json
        [--draw OUT.kicad_pcb] [--tighten] [--reference REF.kicad_pcb]

Sources (they exist before placement, so a spread board gets the same answer as a compact one):
  - Component = the schematic "Group" field of each symbol (the generator writes one group per schematic
    section: soc, pwr, eth1, ...). Without the field: the bold section title above the symbol.
  - Block = one IC (ref U, more than 3 pads) plus the passives its datasheet requires, in the same group.
    A passive (R, C, L, FB, D, Y) joins the IC that its schematic Description names (for example
    "U4 VIN 4.7 uF next to pin 4"); else the block with the largest net affinity:
    sum over its nets (not GND) of 1 / (parts on the net - 1) x (block members on the net). A part with a signal
    net (RAIL_DEG parts or fewer) ties through its signal nets only (an LED series resistor does not join an IC
    through the 3.3 V rail); a part on rails only (a decap) ties through the rails. Assignment is greedy, the
    strongest tie first, so a chain (crystal -> load cap) follows its IC. A part whose Description names a
    connector of its group and no IC is connector support (CLAUDE.md: connectors and their protection are placed on
    the board; a connector block needs 2 or more uses): not in a block. Connectors, switches, indicator LEDs
    (Description "LED"), test points and mounting holes are not in a block (they are placed on the board).
    A block has 2 or more parts.
  - Pad nets come from the board (the board nets are the schematic nets: parity 0).

--draw writes a copy with each block border (User.1, 4 lines, label above the top-left corner) and each component
border (User.2) around the member courtyards, as tools/build-net-core-pcb.py draws them. The problem reader takes
the explicit membership with `cli.py read --blocks members.json`.
--tighten (before --draw): in each block with no fixed part, each passive moves toward the IC along the line from
the IC centre to its own centre (same side of the IC, same turn: the datasheet topology stays) to the nearest legal
place against the parts already placed in the block (courtyard gap TIGHT_GAP). The search packs the blocks after.
--reference: the match of the derived blocks with the User.1 borders of a reference board (validation only).
"""
import argparse
import json
import math
import os
import re
import sys

PASSIVE = ('R', 'C', 'L', 'FB', 'D', 'Y')
CONNECTOR = ('J', 'P', 'CN')
GROUND = ('GND',)
RAIL_DEG = 6        # a net on more parts is a rail: only a part with no signal net (a decap) ties through rails
TIGHT_GAP = 0.25    # mm courtyard to courtyard inside a block (D-040 passive class is 0.5 between units)
BLOCK_MARGIN = 0.3  # border = member courtyards + this (tools/build-net-core-pcb.py)
COMP_MARGIN = 0.5


def prefix(ref):
    m = re.match(r'[A-Za-z_]+', ref)
    return m.group(0) if m else ''


# ---------- schematic ----------

def _sexpr_items(text):
    """Top-level (symbol ...) and (text ...) items of a .kicad_sch, as raw strings (lib_symbols skipped)."""
    out, i, n = [], 0, len(text)
    depth = 0
    start = None
    while i < n:
        c = text[i]
        if c == '"':
            i += 1
            while i < n and text[i] != '"':
                i += 2 if text[i] == '\\' else 1
        elif c == '(':
            depth += 1
            if depth == 2:
                start = i
        elif c == ')':
            if depth == 2 and start is not None:
                out.append(text[start:i + 1])
                start = None
            depth -= 1
        i += 1
    return out


def parse_schematic(text):
    """{ref: {'group', 'desc', 'xy'}} for each placed symbol (power symbols skipped), and the section titles
    [(y, title)] (bold texts)."""
    parts, titles = {}, []
    for it in _sexpr_items(text):
        if it.startswith('(text '):
            m = re.match(r'\(text "((?:[^"\\]|\\.)*)".*?\(at ([-\d.]+) ([-\d.]+)', it, re.S)
            if m and '(bold yes)' in it:
                titles.append((float(m.group(3)), m.group(1)))
        elif it.startswith('(symbol '):
            if '(lib_id "power:' in it:
                continue
            at = re.search(r'\(at ([-\d.]+) ([-\d.]+)', it)
            props = dict(re.findall(r'\(property "([^"]+)" "((?:[^"\\]|\\.)*)"', it))
            ref = props.get('Reference', '')
            if not ref or ref.startswith('#'):
                continue
            parts[ref] = {'group': props.get('Group'), 'desc': props.get('Description', ''),
                          'xy': (float(at.group(1)), float(at.group(2))) if at else (0.0, 0.0)}
    titles.sort()
    for ref, p in parts.items():
        if not p['group']:  # the section title above the symbol
            above = [t for y, t in titles if y <= p['xy'][1]]
            p['group'] = above[-1] if above else 'board'
    return parts, titles


# ---------- membership ----------

def is_anchor(ref, npads):
    return prefix(ref) == 'U' and npads > 3


def derive(sch, pads, ground=GROUND):
    """sch {ref: {'group', 'desc'}}; pads {ref: [net, ...]} (one entry per pad). Returns
    {'blocks': {name: [refs]}, 'components': {group: [block names and loose refs]}, 'why': {ref: reason}}."""
    nets = {r: {n for n in ns if n and n not in ground and not n.startswith('unconnected-')} for r, ns in pads.items()}
    deg = {}
    for r, ns in nets.items():
        for n in ns:
            deg[n] = deg.get(n, 0) + 1
    group = {r: (sch.get(r) or {}).get('group') or 'board' for r in pads}
    anchors = sorted(r for r in pads if is_anchor(r, len(pads[r])))
    block = {a: a for a in anchors}  # ref -> anchor
    why = {a: 'anchor' for a in anchors}
    indicator = {r for r in pads if prefix(r) == 'D' and re.search(r'\bLED\b', (sch.get(r) or {}).get('desc', ''))}
    for r in indicator:
        why[r] = 'indicator LED (not a datasheet part of an IC)'
    free = sorted(r for r in pads if r not in block and prefix(r) in PASSIVE and r not in indicator)
    signal = {r: {n for n in nets[r] if deg[n] <= RAIL_DEG} for r in pads}
    # 1. the Description names one IC of the same group; a part that names a connector and no IC is connector
    #    support (placed with the connector on the board, not in a block)
    def names(desc, r):
        return re.search(r'(?<![A-Za-z0-9])%s(?![0-9])' % r, desc)
    conns = [r for r in pads if prefix(r) in CONNECTOR]
    for r in list(free):
        desc = (sch.get(r) or {}).get('desc', '')
        named = [a for a in anchors if group[a] == group[r] and names(desc, a)]
        if not named and any(group[j] == group[r] and names(desc, j) for j in conns):
            why[r] = 'connector support (Description names a connector)'
            free.remove(r)
        elif len(named) == 1:
            block[r] = named[0]
            why[r] = 'description names %s' % named[0]
            free.remove(r)
    # 2. greedy net affinity, strongest first
    while free:
        best = None
        for r in free:
            sc = {}
            for m, a in block.items():
                if group[m] != group[r]:
                    continue
                for n in (signal[r] or nets[r]) & nets[m]:  # a part with a signal net ties through it only
                    sc[a] = sc.get(a, 0.0) + 1.0 / max(deg[n] - 1, 1)
            for a, s in sc.items():
                key = (s, len(pads[a]), a)
                if best is None or key > best[0]:
                    best = (key, r, a)
        if best is None:
            break
        _, r, a = best
        block[r] = a
        why[r] = 'net affinity %.3f to %s' % (best[0][0], a)
        free.remove(r)
    blocks = {}
    for r, a in sorted(block.items()):
        blocks.setdefault(a, []).append(r)
    blocks = {block_name(a, sch): sorted(m, key=natural) for a, m in blocks.items() if len(m) >= 2}
    in_block = {r for m in blocks.values() for r in m}
    comps = {}
    for name, m in blocks.items():
        comps.setdefault(group[m[0]], []).append(name)
    for r in sorted(pads, key=natural):
        if r not in in_block and not re.fullmatch(r'H\d+', r) and prefix(r) != 'TP':
            comps.setdefault(group[r], []).append(r)
            why.setdefault(r, 'loose (no block)')
    comps = {g: m for g, m in comps.items() if len(m) >= 2}
    return {'blocks': blocks, 'components': comps, 'why': why}


def block_name(anchor, sch):
    return anchor


def natural(ref):
    m = re.match(r'([A-Za-z_]+)(\d*)(.*)', ref)
    return (m.group(1), int(m.group(2) or 0), m.group(3))


def match(derived, reference):
    """Part-level agreement of two block memberships {name: [refs]}: for each reference block the derived block
    with the largest overlap; Jaccard per block and the share of reference block parts that the best derived block
    holds."""
    rows, hit, total = [], 0, 0
    for name, refs in sorted(reference.items()):
        rs = set(refs)
        best = max(derived.items(), key=lambda kv: len(rs & set(kv[1])), default=(None, []))
        inter = rs & set(best[1])
        jac = len(inter) / len(rs | set(best[1])) if best[0] else 0.0
        rows.append({'reference': name, 'derived': best[0], 'jaccard': round(jac, 3), 'common': len(inter),
                     'missing': sorted(rs - set(best[1]), key=natural),
                     'extra': sorted(set(best[1]) - rs, key=natural)})
        hit += len(inter)
        total += len(rs)
    return {'parts_in_best_block': hit, 'reference_parts': total, 'share': round(hit / max(total, 1), 3),
            'blocks': rows}


# ---------- geometry (pure) ----------

def overlap(a, b, gap=0.0):
    return a[0] < b[2] + gap and b[0] < a[2] + gap and a[1] < b[3] + gap and b[1] < a[3] + gap


def shift(rc, dx, dy):
    return (rc[0] + dx, rc[1] + dy, rc[2] + dx, rc[3] + dy)


def tighten_block(anchor_rect, parts, inside, gap=TIGHT_GAP, steps=20):
    """anchor_rect (x0, y0, x1, y1); parts {ref: rect}. Each part, nearest first, moves toward the anchor
    centre along its own centre line, to the smallest t in (0, 1] (t = 1: no move) where its rect keeps `gap`
    to the anchor and to the parts placed before it, and inside(rect) is true. Returns {ref: (dx, dy)}."""
    cx, cy = (anchor_rect[0] + anchor_rect[2]) / 2, (anchor_rect[1] + anchor_rect[3]) / 2
    placed = [anchor_rect]
    out = {}

    def centre(rc):
        return (rc[0] + rc[2]) / 2, (rc[1] + rc[3]) / 2
    for ref in sorted(parts, key=lambda r: (math.hypot(centre(parts[r])[0] - cx, centre(parts[r])[1] - cy), r)):
        rc = parts[ref]
        px, py = centre(rc)
        vx, vy = px - cx, py - cy
        best = (0.0, 0.0)
        for k in range(1, steps + 1):
            t = k / steps
            dx, dy = (t - 1) * vx, (t - 1) * vy
            q = shift(rc, dx, dy)
            if inside(q) and not any(overlap(q, p, gap) for p in placed):
                best = (dx, dy)
                break
        out[ref] = best
        placed.append(shift(rc, *best))
    return out


def border(rects, margin):
    return (min(r[0] for r in rects) - margin, min(r[1] for r in rects) - margin,
            max(r[2] for r in rects) + margin, max(r[3] for r in rects) + margin)


# ---------- board (pcbnew) ----------

def reference_from_builder(path, name='BLOCKS'):
    """The {label: [refs]} dict literal `name` of a board builder script (validation only; evaluated with
    range() as the only builtin, no import)."""
    import ast
    tree = ast.parse(open(path).read())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(t, 'id', None) == name for t in node.targets):
            code = compile(ast.Expression(node.value), path, 'eval')
            return eval(code, {'__builtins__': {'range': range}})
    raise ValueError('%s: no %s' % (path, name))


def board_pads(board):
    return {fp.GetReference(): [p.GetNetname() for p in fp.Pads()] for fp in board.GetFootprints()}


def fixed_refs(board, edge_dist=1.5):
    """Parts the problem reader keeps fixed (kicad_io.part_fixed): their blocks stay soft (cohesion only)."""
    from placer import kicad_io
    outline, _ = kicad_io.outline_of(board)
    locked = [t for t in board.GetTracks() if t.IsLocked()]
    return sorted(fp.GetReference() for fp in board.GetFootprints()
                  if kicad_io.part_fixed(fp, kicad_io.pads_box(fp, kicad_io.fp_rect(fp)), outline, (), locked,
                                         edge_dist))


def tighten(board, m, fixed):
    import pcbnew
    from placer import kicad_io
    by = {fp.GetReference(): fp for fp in board.GetFootprints()}
    outline, _ = kicad_io.outline_of(board)
    xs, ys = [p[0] for p in outline], [p[1] for p in outline]
    ob = (min(xs) + 0.3, min(ys) + 0.3, max(xs) - 0.3, max(ys) - 0.3)
    moved = {}
    for name, refs in m['blocks'].items():
        if set(refs) & set(fixed):
            continue
        anchor = max(refs, key=lambda r: (len(by[r].Pads()), r))
        rects = {r: kicad_io.pads_box(by[r], kicad_io.fp_rect(by[r])) for r in refs}
        d = tighten_block(rects[anchor], {r: rects[r] for r in refs if r != anchor},
                          lambda q: q[0] >= ob[0] and q[1] >= ob[1] and q[2] <= ob[2] and q[3] <= ob[3])
        for r, (dx, dy) in d.items():
            if abs(dx) > 1e-6 or abs(dy) > 1e-6:
                by[r].Move(pcbnew.VECTOR2I(int(round(dx * 1e6)), int(round(dy * 1e6))))
                moved[r] = [round(dx, 4), round(dy, 4)]
    return moved


def clear_layers(board, names=('User.1', 'User.2')):
    lays = {board.GetLayerID(n) for n in names}
    for d in [d for d in board.GetDrawings() if d.GetLayer() in lays]:
        board.Delete(d)


def draw(board, m):
    """User.1 block borders + labels, User.2 component borders + labels around the member courtyards."""
    import pcbnew
    from placer import kicad_io
    by = {fp.GetReference(): fp for fp in board.GetFootprints()}
    clear_layers(board)

    def seg(a, b, layer, w):
        s = pcbnew.PCB_SHAPE(board)
        s.SetShape(pcbnew.SHAPE_T_SEGMENT)
        s.SetLayer(layer)
        s.SetStart(pcbnew.VECTOR2I(int(round(a[0] * 1e6)), int(round(a[1] * 1e6))))
        s.SetEnd(pcbnew.VECTOR2I(int(round(b[0] * 1e6)), int(round(b[1] * 1e6))))
        s.SetWidth(int(w * 1e6))
        board.Add(s)

    def rect(r, layer, w):
        pts = [(r[0], r[1]), (r[2], r[1]), (r[2], r[3]), (r[0], r[3])]
        for a, b in zip(pts, pts[1:] + pts[:1]):
            seg(a, b, layer, w)

    def label(t, x, y, h, layer):
        o = pcbnew.PCB_TEXT(board)
        o.SetText(t)
        o.SetLayer(layer)
        o.SetTextSize(pcbnew.VECTOR2I(int(h * 1e6), int(h * 1e6)))
        o.SetTextThickness(int(max(0.12, h * 0.15) * 1e6))
        o.SetHorizJustify(pcbnew.GR_TEXT_H_ALIGN_LEFT)
        o.SetPosition(pcbnew.VECTOR2I(int(round(x * 1e6)), int(round(y * 1e6))))
        board.Add(o)
    boxes = {}
    for name, refs in m['blocks'].items():
        r = border([kicad_io.pads_box(by[x], kicad_io.fp_rect(by[x])) for x in refs], BLOCK_MARGIN)
        boxes[name] = r
        rect(r, pcbnew.User_1, 0.08)
        label(name, r[0] + 0.2, r[1] + 0.5, 0.6, pcbnew.User_1)
    for name, members in m['components'].items():
        rs = [boxes[x] if x in boxes else kicad_io.pads_box(by[x], kicad_io.fp_rect(by[x])) for x in members]
        r = border(rs, COMP_MARGIN)
        rect(r, pcbnew.User_2, 0.12)
        label(name, r[0] + 0.2, r[3] - 0.5, 0.7, pcbnew.User_2)
    return boxes


def reference_blocks(board):
    """{label: [refs]} of the User.1 borders of a board (anchor inside the border; validation only)."""
    import pcbnew
    from placer import kicad_io
    out = {}
    for k, (box, ids, lab) in enumerate(kicad_io.block_borders(board)):
        refs = [fp.GetReference() for fp in board.GetFootprints()
                if kicad_io.inside_box(pcbnew.ToMM(fp.GetPosition().x), pcbnew.ToMM(fp.GetPosition().y), box)]
        out[lab or 'BLOCK%d' % (k + 1)] = sorted(refs, key=natural)
    return out


def block_area(board, blocks):
    """Sum of the member courtyard bounding boxes (mm2) per block, and the total."""
    from placer import kicad_io
    by = {fp.GetReference(): fp for fp in board.GetFootprints()}
    rows = {}
    for name, refs in blocks.items():
        rs = [kicad_io.pads_box(by[r], kicad_io.fp_rect(by[r])) for r in refs if r in by]
        b = border(rs, 0.0)
        rows[name] = round((b[2] - b[0]) * (b[3] - b[1]), 1)
    return round(sum(rows.values()), 1), rows


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    d = sub.add_parser('derive')
    d.add_argument('sch')
    d.add_argument('pcb')
    d.add_argument('-o', required=True)
    d.add_argument('--draw', metavar='OUT.kicad_pcb')
    d.add_argument('--tighten', action='store_true')
    d.add_argument('--reference', metavar='REF.kicad_pcb')
    d.add_argument('--reference-builder', metavar='BUILD.py', help='BLOCKS dict of a board builder (validation)')
    a = sub.add_parser('area')
    a.add_argument('members', help='membership JSON, or a builder .py (its BLOCKS dict)')
    a.add_argument('boards', nargs='+')
    args = ap.parse_args(argv)
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    import pcbnew
    if args.cmd == 'area':
        blocks = (reference_from_builder(args.members) if args.members.endswith('.py')
                  else json.load(open(args.members))['blocks'])
        for p in args.boards:
            tot, rows = block_area(pcbnew.LoadBoard(p), blocks)
            print(json.dumps({'board': p, 'block_box_sum_mm2': tot, 'blocks': rows}))
        return 0
    sch, _ = parse_schematic(open(args.sch).read())
    board = pcbnew.LoadBoard(args.pcb)
    m = derive(sch, board_pads(board))
    m['source'] = {'schematic': os.path.abspath(args.sch), 'board': os.path.abspath(args.pcb)}
    m['fixed'] = fixed_refs(board)
    m['soft_blocks'] = sorted(n for n, refs in m['blocks'].items() if set(refs) & set(m['fixed']))
    if args.reference or args.reference_builder:
        ref = (reference_from_builder(args.reference_builder) if args.reference_builder
               else reference_blocks(pcbnew.LoadBoard(args.reference)))
        m['match'] = match(m['blocks'], ref)
        m['match']['reference_blocks'] = ref
    if args.draw:
        if args.tighten:
            m['tightened'] = tighten(board, m, m['fixed'])
        draw(board, m)
        pro = os.path.splitext(args.draw)[0] + '.kicad_pro'
        keep = open(pro).read() if os.path.exists(pro) else None
        pcbnew.SaveBoard(args.draw, board)
        if keep is not None:  # SaveBoard rewrites the .kicad_pro next to the board
            open(pro, 'w').write(keep)
    json.dump(m, open(args.o, 'w'), indent=1)
    print(json.dumps({'blocks': len(m['blocks']), 'soft_blocks': m['soft_blocks'], 'components': len(m['components']),
                      'match_share': m.get('match', {}).get('share'), 'tightened': len(m.get('tightened', {}))}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
