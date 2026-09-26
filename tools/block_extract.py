#!/usr/bin/env python3
"""Cut a KiCad design block out of a flat board: schematic by box, PCB by reference list.

  $PY tools/block_extract.py SRC_DIR/BOARD BLOCK_DIR ID --sch-box X0 Y0 X1 Y1 \\
      --refs J2 F1 ... [--margin 2] [--swap D4=Diode_SMD:D_SMA]

1. Schematic: keep every item that lies fully inside --sch-box, the lib_symbols it uses and
   the root uuid (so footprint paths /<symbol uuid> keep parity). Project name becomes ID.
2. PCB: keep the --refs footprints, the tracks and vias of their nets inside the part box
   (+ --margin), copper zones of those nets clipped to that box, and non-edge drawings
   inside it. A new Edge.Cuts rectangle is the box. Rule areas and other items go.
3. --swap REF=LIB:NAME replaces a footprint from the KiCad library (position, fields,
   path and pad nets kept) and sets the same Footprint field in the schematic.
4. BOARD.kicad_pro and .kicad_dru are copied as ID.*. OUT is a proposal; DRC with
   --schematic-parity decides.
"""
import argparse
import os
import re
import shutil

KEEP_HEADS = {'version', 'generator', 'generator_version', 'uuid', 'paper', 'sheet_instances', 'embedded_fonts'}
DROP_HEADS = {'title_block'}


def _spans(text, start, end):
    """Spans of the direct children of the list that opens at text[start] == '('."""
    out, depth, i, q, s0 = [], 0, start, False, None
    while i < end:
        c = text[i]
        if q:
            if c == '\\':
                i += 1
            elif c == '"':
                q = False
        elif c == '"':
            q = True
        elif c == '(':
            depth += 1
            if depth == 2:
                s0 = i
        elif c == ')':
            if depth == 2:
                out.append((s0, i + 1))
            depth -= 1
            if depth == 0:
                break
        i += 1
    return out


def children(text):
    return [text[a:b] for a, b in _spans(text, text.index('('), len(text))]


def head(item):
    return re.match(r'\(\s*([^\s()]+)', item).group(1)


def points(item):
    h = head(item)
    if h == 'wire' or h == 'bus' or h == 'polyline':
        return [(float(x), float(y)) for x, y in re.findall(r'\(xy ([-\d.]+) ([-\d.]+)\)', item)]
    m = re.search(r'\(at ([-\d.]+) ([-\d.]+)', item)
    return [(float(m.group(1)), float(m.group(2)))] if m else []


def inside(p, box):
    return box[0] <= p[0] <= box[2] and box[1] <= p[1] <= box[3]


def crop_sch(text, box, block_id):
    kids = children(text)
    items = [k for k in kids if head(k) not in KEEP_HEADS | DROP_HEADS | {'lib_symbols'}
             and points(k) and all(inside(p, box) for p in points(k))]
    used = {m for k in items for m in re.findall(r'\(lib_id "([^"]+)"\)', k)}
    out = ['(kicad_sch']
    for k in kids:
        h = head(k)
        if h in KEEP_HEADS - {'sheet_instances', 'embedded_fonts'}:
            out.append('  ' + k)
        elif h == 'lib_symbols':
            libs = [s for s in children(k) if re.match(r'\(symbol "([^"]+)"', s).group(1) in used]
            out.append('  (lib_symbols\n' + ''.join('\t' + s + '\n' for s in libs) + '  )')
    out += ['\t' + re.sub(r'\(project "[^"]*"', f'(project "{block_id}"', k) for k in items]
    out += ['  ' + k for k in kids if head(k) in ('sheet_instances', 'embedded_fonts')]
    return '\n'.join(out) + '\n)\n'


def set_sch_footprint(text, ref, fp):
    for a, b in _spans(text, text.index('('), len(text)):
        k = text[a:b]
        if head(k) == 'symbol' and re.search(r'\(property "Reference" "%s"' % re.escape(ref), k):
            k2, n = re.subn(r'\(property "Footprint" "[^"]*"', f'(property "Footprint" "{fp}"', k, count=1)
            if n:
                return text[:a] + k2 + text[b:]
    raise KeyError(ref)


def main():
    import pcbnew as pn
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('board', help='path without extension, e.g. .../RELAY-4/RELAY-4')
    ap.add_argument('out_dir'); ap.add_argument('id')
    ap.add_argument('--sch-box', nargs=4, type=float, required=True)
    ap.add_argument('--refs', nargs='+', required=True)
    ap.add_argument('--margin', type=float, default=2.0)
    ap.add_argument('--swap', nargs='*', default=[])
    a = ap.parse_args()
    swaps = dict(s.split('=', 1) for s in a.swap)
    os.makedirs(a.out_dir, exist_ok=True)
    dst = os.path.join(a.out_dir, a.id)

    sch = crop_sch(open(a.board + '.kicad_sch').read(), a.sch_box, a.id)
    for r, f in swaps.items():
        sch = set_sch_footprint(sch, r, f)
    open(dst + '.kicad_sch', 'w').write(sch)
    for ext in ('.kicad_pro', '.kicad_dru'):
        if os.path.exists(a.board + ext):
            shutil.copy(a.board + ext, dst + ext)

    mm, F = pn.ToMM, pn.FromMM
    b = pn.LoadBoard(a.board + '.kicad_pcb')
    refs = set(a.refs)
    fps = [fp for fp in b.GetFootprints() if fp.GetReference() in refs]
    missing = refs - {fp.GetReference() for fp in fps}
    if missing:
        raise SystemExit(f'block_extract: refs not on the board: {sorted(missing)}')
    bb = fps[0].GetBoundingBox()
    for fp in fps[1:]:
        bb.Merge(fp.GetBoundingBox())
    m = F(a.margin)
    box = pn.BOX2I(pn.VECTOR2I(bb.GetX() - m, bb.GetY() - m), pn.VECTOR2I(bb.GetWidth() + 2 * m, bb.GetHeight() + 2 * m))
    # KiCad 10 Python: after BOARD.Remove() the SWIG proxies break, so read and add first, remove last.
    nets = {p.GetNetname() for fp in fps for p in fp.Pads() if p.GetNetname()}
    drop = [fp for fp in b.GetFootprints() if fp.GetReference() not in refs]
    drop += [t for t in b.GetTracks() if t.GetNetname() not in nets or not box.Contains(t.GetBoundingBox())]
    rect = pn.SHAPE_POLY_SET()
    rect.NewOutline()
    for x, y in ((box.GetX(), box.GetY()), (box.GetRight(), box.GetY()), (box.GetRight(), box.GetBottom()), (box.GetX(), box.GetBottom())):
        rect.Append(x, y)
    for z in b.Zones():
        if z.GetIsRuleArea() or z.GetNetname() not in nets:
            drop.append(z); continue
        z.Outline().BooleanIntersection(rect)
        if z.Outline().OutlineCount() == 0:
            drop.append(z)
    drop += [d for d in b.GetDrawings() if d.GetLayer() == pn.Edge_Cuts or not box.Contains(d.GetBoundingBox())]
    edge = pn.PCB_SHAPE(b, pn.SHAPE_T_RECT)
    edge.SetLayer(pn.Edge_Cuts); edge.SetWidth(F(0.05))
    edge.SetStart(box.GetPosition()); edge.SetEnd(pn.VECTOR2I(box.GetRight(), box.GetBottom()))
    b.Add(edge)
    for r, f in swaps.items():
        old = next(fp for fp in fps if fp.GetReference() == r)
        lib, name = f.split(':', 1)
        new = pn.FootprintLoad(os.path.join(os.environ.get('KICAD_FP', '/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints'), lib + '.pretty'), name)
        new.SetFPID(pn.LIB_ID(lib, name))
        if old.GetLayer() != new.GetLayer():
            new.Flip(new.GetPosition(), pn.FLIP_DIRECTION_TOP_BOTTOM)
        new.SetPosition(old.GetPosition()); new.SetOrientation(old.GetOrientation())
        new.SetPath(old.GetPath())
        have = {g.GetName(): g for g in new.GetFields()}
        for fld in old.GetFields():
            n = fld.GetName()
            if n in ('Reference', 'Value', 'Footprint'):
                continue
            if n not in have:
                nf = pn.PCB_FIELD(new, 0, n); nf.SetVisible(False); new.Add(nf); have[n] = nf
            have[n].SetText(fld.GetText())
        new.SetReference(old.GetReference()); new.SetValue(old.GetValue())
        pads = {p.GetNumber(): p.GetNetname() for p in old.Pads()}
        netinfo = b.GetNetInfo()
        for p in new.Pads():
            if p.GetNumber() in pads:
                p.SetNet(netinfo.GetNetItem(pads[p.GetNumber()]))
        b.Add(new); drop.append(old)
    ntr = sum(1 for t in b.GetTracks() if t not in drop)
    nz = sum(1 for z in b.Zones() if z not in drop)
    for item in drop:
        b.Remove(item)
    W, H = mm(box.GetWidth()), mm(box.GetHeight())
    b.Save(dst + '.kicad_pcb')
    print(f'block_extract: {a.id}: {len(refs)} parts, box {W:.1f} x {H:.1f} mm, {ntr} tracks/vias, {nz} zones -> {a.out_dir}')


if __name__ == '__main__':
    main()
