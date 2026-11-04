#!/usr/bin/env python3
"""Connector pin labels and group titles on F.SilkS (and B.SilkS, "back": true), then the silk marks, references and brand block of a board
(user request 2026-10-07 "logos and clear labels, bigger if possible"; model: the AIO labels, D-102).

  $PY tools/board_labels.py <BOARD> [--dry-run] [--pcb PATH] [--labels-only]      (KiCad python: pcbnew)

SILKSCREEN ONLY: the tool writes F.SilkS texts, reference fields and B.SilkS brand shapes. It never moves a
footprint, pad, track, via or zone.

Reads hardware-design/boards/<BOARD>/board-labels.json:
  {"remove": [["24V", 145.6, 107.05], ...], "remove_groups": ["j6-labels"],   (legacy label groups this tool replaces)        legacy loose F.SilkS texts that this tool replaces (text, x, y;
                                                     matched within 0.3 mm). A rerun finds none: that is not an error.
   "pin_h": [1.0, 0.9], "title_h": [1.5, 1.27, 1.0],          sizes to try, largest first (defaults)
   "connectors": [{"ref": "J1", "dir": "E",                         labels go from the pins toward this side (N/S/E/W)
                   "pins": [["1", "24V", "/VIN_RAW"], ...],          pad, label, expected net (string or list), and an
                                       optional dict: {"dir", "max_gap", "max_shift", "far": mm (a pin exempted in port-labels.json),
                                        "angle": 90 (vertical, last resort)}
                   "title": ["24V DC IN", "18-32V"],                 title lines (horizontal); or a list of wordings
                                                                     [["24V DC IN", "18-32V"], ["24V IN", "18-32V DC"]]
                   "title_near": [x, y], "pin_h": [...], "title_h": [...], "max_gap": 3.0, "title_dx": 12,
                   "rows": 3 (staggered label rows for a fine pitch), "pin_gap_x": 0.5}],
   "free_texts": [{"text": ["FIELD 24V BUS"], "near": [x, y], "h": [2.0, 1.5]}],   board texts (not a port)
   "brand": {"name": "PWR-24V-5V", "rev": "A", "logo_mm": [26, 22, 18, 16], "text_mm": [2.0, 1.5, 1.2],
             "near": [x, y]}}

Steps (each rerun gives the same result):
1. All reference fields go to F.Fab (tools/silk_refs.py); the old "board-labels" and "silk-marks" groups and the
   legacy texts in "remove" are deleted.
2. Pin labels, one per listed pad: horizontal, on the board side of the terminal (dir), aligned to the pin (the
   label anchor is nearer to its own pad than to any other connector pad, within 4 mm: tools/port_labels.py), clear
   of every pad (0.2 mm; NPTH 0.3 mm), via (0.15 mm), footprint silk and other board silk (0.1 mm), part body
   (courtyard less 0.2 mm; first clear of the vias, then over the tented vias before a smaller size), M3 screw head (r 3.0 mm round a hole >= 3 mm), other labels (0.2 mm) and 0.5 mm inside
   the board outline. All the pins of one connector get one size: the largest of pin_h where every pin fits.
   Stroke: 0.15 mm per mm of text height, 0.15 mm minimum.
3. Titles: after all pin labels, each title block (its lines kept together) goes to the free place nearest to
   title_near (default: past the pin labels, along dir), with every line within 7.9 mm of the connector pads (gate:
   8 mm). The largest size of title_h that fits (glyph width 1.0, then 0.8 of the height).
   A pin or title with no free place stops the tool (fail closed); nothing is written.
4. tools/silk_marks.py <BOARD> (silk-marks.json: ratings, mating labels, barrier line, kept references) and
   tools/brand_mark.py (the largest logo_mm / text_mm block that fits on B.SilkS near "near").
5. "back": true (user request 2026-10-07: the bottom side may be easier to read while wiring): the same pin labels and
   titles on B.SilkS, mirrored, aligned to the same pins (group "board-labels-back"; back_pass). It runs last and only
   adds B.SilkS texts, so the front stays the same. Obstacles: through-hole pads and holes (0.2 mm; NPTH 0.3 mm), pads
   on B.Cu / B.Mask, vias (0.15 mm, always: no tented-via fallback), all B.SilkS (brand block, footprint silk; 0.1
   mm), M3 screw heads, other back labels and 0.5 mm inside the outline. Same sizes, wordings and pin-to-label rule
   (nearest own pad, within 3.9 mm) as the front; a pin label that does not fit on the dir side goes to the other side
   of its pin. An SMD connector (GH, FPC: no pad on the bottom) gets its labels
   and title under its body (courtyard) first. A pin or title with no free place is skipped and listed (not an error).
--labels-only: steps 1-3 (and 5).
"""
import json
import math
import os
import subprocess
import sys

import pcbnew

M, T = pcbnew.FromMM, pcbnew.ToMM
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
from brand_mark import keep_stackup, stackup_block  # noqa: E402
from silk_refs import refs_off_silk  # noqa: E402

GROUP = 'board-labels'
GROUP_BACK = 'board-labels-back'   # the B.SilkS copy ("back": true), user request 2026-10-07
GROUP_INFO = 'board-info-back'     # reference blocks on B.SilkS ("info_back"), user request 2026-10-11
PAD_GAP, NPTH_GAP, VIA_GAP, SILK_GAP, EDGE_GAP = 0.2, 0.3, 0.15, 0.1, 0.5
PIN_GAP_X, PIN_GAP_Y = 0.5, 0.08   # between two pin labels: side by side / one over the other (1.25 mm pitch columns)
TITLE_GAP = 0.6                     # between a title and any other label
PIN_MIN = 1.0          # target pin label height; a smaller size of pin_h is used per pin only where 1.0 mm does not fit
SCREW_R = 3.0          # M3 pan head 5.5 mm + margin: silk under the head is hidden
PIN_DIST, TITLE_DIST = 3.9, 7.9   # tools/port_labels.py limits 4.0 / 8.0, less a margin
DIRS = {'N': (0, -1), 'S': (0, 1), 'E': (1, 0), 'W': (-1, 0)}
HJ = {'L': pcbnew.GR_TEXT_H_ALIGN_LEFT, 'C': pcbnew.GR_TEXT_H_ALIGN_CENTER, 'R': pcbnew.GR_TEXT_H_ALIGN_RIGHT}
VJ = {'T': pcbnew.GR_TEXT_V_ALIGN_TOP, 'C': pcbnew.GR_TEXT_V_ALIGN_CENTER, 'B': pcbnew.GR_TEXT_V_ALIGN_BOTTOM}


def stroke(h):
    return max(0.15, round(0.15 * h, 3))


def text_item(b, text, h, w, x, y, hj, vj, back=False):
    """hj 'L' / 'C' / 'R'; 'R90': right justified, turned 90 degrees (a pin label with angle 90, see place_pins).
    back: B.SilkS, mirrored (reads correctly from the bottom side)."""
    ang = 90 if hj.endswith('90') else 0
    hj = hj[0]
    t = pcbnew.PCB_TEXT(b)
    t.SetText(text)
    t.SetLayer(pcbnew.B_SilkS if back else pcbnew.F_SilkS)
    if back:
        t.SetMirrored(True)
    t.SetTextSize(pcbnew.VECTOR2I(M(w), M(h)))
    t.SetTextThickness(M(stroke(h)))
    t.SetHorizJustify(HJ[hj])
    t.SetVertJustify(VJ[vj])
    t.SetTextAngleDegrees(ang)
    t.SetPosition(pcbnew.VECTOR2I(M(x), M(y)))
    return t


_ext = {}


def extent(b, text, h, w, hj, vj, back=False):
    """Glyph box of the text relative to its anchor: (dx0, dy0, dx1, dy1) mm."""
    k = (text, h, w, hj, vj, back)
    if k not in _ext:
        bb = text_item(b, text, h, w, 0, 0, hj, vj, back).GetEffectiveTextShape().BBox()
        _ext[k] = (T(bb.GetLeft()), T(bb.GetTop()), T(bb.GetRight()), T(bb.GetBottom()))
    return _ext[k]


def pick(b, text, h, w, u, vertical, back):
    """Justification (hj, vj) that puts the glyph box on the side u = (ux, uy) of its anchor, centred across u.
    Measured from the glyph box, so a mirrored (B.SilkS) text gets the right side too."""
    ux, uy = u
    if vertical:
        opts = [('L90', 'C'), ('R90', 'C')] if uy else [('C90', 'C')]
    else:
        opts = [('L', 'C'), ('R', 'C')] if ux else [('C', 'T'), ('C', 'B')]

    def along(o):
        e = extent(b, text, h, w, o[0], o[1], back)
        return (e[0] + e[2]) / 2 * ux + (e[1] + e[3]) / 2 * uy
    return max(opts, key=along)


def hit(r, o):
    return r[0] < o[2] and o[0] < r[2] and r[1] < o[3] and o[1] < r[3]


def grow(r, g):
    return (r[0] - g, r[1] - g, r[2] + g, r[3] + g)


def bbox_mm(bb, g=0.0):
    return (T(bb.GetLeft()) - g, T(bb.GetTop()) - g, T(bb.GetRight()) + g, T(bb.GetBottom()) + g)


class Board:
    def __init__(self, b, removed_ids, back=False):
        """back: the obstacles of the B.SilkS pass (all parts are on the top side): through-hole pads and holes, pads
        on B.Cu / B.Mask, vias, B.SilkS (footprint and board, the brand block included), screw heads, board edge."""
        self.b = b
        self.back = back
        self.smd = {}   # back: ref -> courtyard box of a connector with no through-hole pin (labels go under it)
        outline = pcbnew.SHAPE_POLY_SET()
        b.GetBoardPolygonOutlines(outline, False)
        self.inner = pcbnew.SHAPE_POLY_SET(outline)
        self.inner.Deflate(M(EDGE_GAP), pcbnew.CORNER_STRATEGY_ROUND_ALL_CORNERS, M(0.02))
        obs, self.screws, self.why = [], [], []
        silk_layer = pcbnew.B_SilkS if back else pcbnew.F_SilkS
        for f in b.GetFootprints():
            for p in f.Pads():
                npth = p.GetAttribute() == pcbnew.PAD_ATTRIB_NPTH
                if back and not (p.GetDrillSize().x or p.IsOnLayer(pcbnew.B_Cu) or p.IsOnLayer(pcbnew.B_Mask)):
                    pass   # a top SMD pad: not on the bottom side
                else:
                    obs.append(bbox_mm(p.GetBoundingBox(), NPTH_GAP if npth else PAD_GAP))
                    self.why.append(f'pad {f.GetReference()}.{p.GetNumber()}')
                if p.GetDrillSize().x >= M(3.0):
                    self.screws.append((T(p.GetPosition().x), T(p.GetPosition().y)))
            c = f.GetCourtyard(pcbnew.F_CrtYd)
            if back and not c.IsEmpty() and not any(p.GetDrillSize().x for p in f.Pads()):
                self.smd[f.GetReference()] = bbox_mm(c.BBox())
            if not back and not c.IsEmpty() and not any(p.GetDrillSize().x >= M(3.0) for p in f.Pads()):
                bb = c.BBox()
                obs.append(bbox_mm(bb, -0.2))
                self.why.append(f'body {f.GetReference()}')
            for g in f.GraphicalItems():
                if g.GetLayer() == silk_layer and (g.GetClass() != 'PCB_TEXT' or g.IsVisible()):
                    obs.append(bbox_mm(g.GetBoundingBox(), SILK_GAP))
                    self.why.append(f'silk {f.GetReference()}')
            for fld in (f.Reference(), f.Value()):
                if fld.GetLayer() == silk_layer and fld.IsVisible():
                    obs.append(bbox_mm(fld.GetBoundingBox(), SILK_GAP))
                    self.why.append(f'field {f.GetReference()}')
        for t in b.GetTracks():
            if t.GetClass() == 'PCB_VIA':
                obs.append(bbox_mm(t.GetBoundingBox(), VIA_GAP))
                self.why.append(f'via {t.GetNetname()}')
        for d in b.GetDrawings():
            if d.GetLayer() == silk_layer and id(d) not in removed_ids:
                g = d.GetParentGroup()
                if g and g.GetName() in (GROUP, 'silk-marks', GROUP_BACK):
                    continue
                obs.append(bbox_mm(d.GetBoundingBox(), SILK_GAP))
                self.why.append('board silk ' + (d.GetText() if d.GetClass() == 'PCB_TEXT' else d.GetClass()))
        for g in b.Groups():   # the brand block is one obstacle: no label in the gaps between its letters
            if g.GetName().startswith('brand ') and any(i.GetLayer() == silk_layer for i in g.GetItems()):
                obs.append(bbox_mm(g.GetBoundingBox(), SILK_GAP))
                self.why.append('brand block')
        self.obs = obs
        self.placed = []   # (rect, text, kind): kind 'pin' or 'title'
        self.pin_gap_x = PIN_GAP_X   # a connector may ask for more (pin_gap_x)

    def local(self, win, vias=True):
        """Obstacles in the window; vias=False leaves out the vias (tented: the silk prints over them)."""
        vias = vias or self.back   # back: always clear of the vias (no tented-via fallback)
        return [o for o, w in zip(self.obs, self.why) if hit(o, win) and (vias or not w.startswith('via '))]

    def inside(self, r):
        for k in range(9):
            x = r[0] + (r[2] - r[0]) * (k % 3) / 2
            y = r[1] + (r[3] - r[1]) * (k // 3) / 2
            if not self.inner.Contains(pcbnew.VECTOR2I(M(x), M(y))):
                return False
        return True

    def screw(self, r):
        return any(math.hypot(max(r[0] - x, 0, x - r[2]), max(r[1] - y, 0, y - r[3])) < SCREW_R for x, y in self.screws)

    def clash(self, r, kind):
        out = []
        for p, t, k in self.placed:
            gx, gy = (self.pin_gap_x, PIN_GAP_Y) if kind == k == 'pin' else (TITLE_GAP, TITLE_GAP)
            if hit((r[0] - gx, r[1] - gy, r[2] + gx, r[3] + gy), p):
                out.append(t)
        return out

    def free(self, r, local, kind='pin'):
        if any(hit(r, o) for o in local):
            return False
        if self.clash(r, kind):
            return False
        return self.inside(r) and not self.screw(r)


def port_pads(b, refs):
    """All numbered pads of the connectors (J, P, CN): (ref, num, x, y)."""
    import re
    out = []
    for f in b.GetFootprints():
        if re.match(r'^(J|P|CN)\d', f.GetReference()):
            for p in f.Pads():
                if p.GetNumber() and p.GetDrillSize().x < M(3.0):
                    out.append((f.GetReference(), p.GetNumber(), T(p.GetPosition().x), T(p.GetPosition().y)))
    return out


def place_pins(B, conn, pads_all, cfg):
    """Pin labels of one connector. All pins get the largest size of pin_h at which every pin fits; when no size
    fits all, each pin gets the largest size at which it fits (reported). Returns (items, notes) or SystemExit."""
    b = B.b
    ref = conn['ref']
    fp = b.FindFootprintByReference(ref)
    if fp is None:
        raise SystemExit(f'board_labels: no footprint {ref}')
    pads = {p.GetNumber(): p for p in fp.Pads()}
    errs = []
    for pin in conn['pins']:
        num, text, net = pin[:3]
        p = pads.get(num)
        want = net if isinstance(net, list) else [net]
        if p is None or p.GetNetname() not in want:
            errs.append(f'{ref}.{num} "{text}": pad net {p.GetNetname() if p else None}, expected {want}')
    if errs:
        raise SystemExit('board_labels: label/net mismatch:\n  ' + '\n  '.join(errs))
    max_gap = conn.get('max_gap', 3.0)
    max_shift = conn.get('max_shift', 0.8)
    shifts = [0.0] + [v * sg for v in [round(0.1 * k, 2) for k in range(1, int(max_shift / 0.1 + 1e-6) + 1)] for sg in (1, -1)]

    def one(pin, h, vias=True):
        num, text = pin[0], pin[1]
        opt = pin[3] if len(pin) > 3 else {}
        dx, dy = DIRS[opt.get('dir', conn['dir'])]
        p = pads[num]
        px, py = T(p.GetPosition().x), T(p.GetPosition().y)
        pb = bbox_mm(p.GetBoundingBox())
        if dx:   # E / W: level with the pin, justified away from it
            hj, vj = ('L' if dx > 0 else 'R'), 'C'
            edge = pb[2] if dx > 0 else pb[0]
        else:    # N / S: centred on the pin
            hj, vj = 'C', ('T' if dy > 0 else 'B')
            edge = pb[3] if dy > 0 else pb[1]
        if opt.get('angle') == 90:   # vertical: only where no horizontal place exists (reported)
            hj, vj = ('R90' if dy else 'C90'), 'C'
        modes = [('out', hj, vj)]
        if B.back:   # mirrored text: the justification comes from the glyph box
            vert = opt.get('angle') == 90
            # then the other side of the pin (no part on the bottom: the side behind the terminal body is free)
            modes = [('out',) + pick(b, text, h, h, (dx, dy), vert, True),
                     ('opp',) + pick(b, text, h, h, (-dx, -dy), vert, True)]
            if ref in B.smd:   # SMD connector: no pad on the bottom; first under the connector body (courtyard)
                modes.insert(0, ('in',) + pick(b, text, h, h, (-dx, -dy), vert, True))
        local = B.local((px - 12, py - 12, px + 12, py + 12), vias)
        lim = opt.get('far', PIN_DIST)   # far: a pin with a gate exemption (port-labels.json): its label may stand further
        shs = shifts if 'max_shift' not in opt else \
            [0.0] + [round(0.1 * k, 2) * sg for k in range(1, int(opt['max_shift'] / 0.1 + 1e-6) + 1) for sg in (1, -1)]
        row = conn['pins'].index(pin) % conn.get('rows', 1)   # staggered rows (fine pitch): row k starts k lines out
        for mode, hj, vj in modes:
            e = extent(b, text, h, h, hj, vj, B.back)
            g0 = PAD_GAP + 0.05 + row * (e[3] - e[1] + PIN_GAP_Y + 0.1) if not dx else PAD_GAP + 0.05
            if mode == 'in':
                g0 -= PAD_GAP + 0.05
            edge_o = (pb[0] if dx > 0 else pb[2]) if dx else (pb[1] if dy > 0 else pb[3])   # 'opp': far pad edge
            for k in range(int(opt.get('max_gap', max_gap) / 0.05) + 1):
                g = g0 + 0.05 * k
                for sh in shs:
                    if mode == 'in':   # from the pad centre into the body
                        x, y = (px - dx * g, py + sh) if dx else (px + sh, py - dy * g)
                    elif mode == 'opp':
                        x, y = (edge_o - dx * g, py + sh) if dx else (px + sh, edge_o - dy * g)
                    else:
                        x, y = (edge + dx * g, py + sh) if dx else (px + sh, edge + dy * g)
                    # gate: the anchor is nearest to its own pad among all connector pads, within PIN_DIST
                    d, r_, n_ = min((math.hypot(qx - x, qy - y), r_, n_) for r_, n_, qx, qy in pads_all)
                    if (r_, n_) != (ref, num) or d > lim:
                        continue
                    r = (x + e[0], y + e[1], x + e[2], y + e[3])
                    if mode == 'in':
                        c = B.smd[ref]
                        if not (c[0] <= r[0] and c[1] <= r[1] and r[2] <= c[2] and r[3] <= c[3]):
                            continue
                    if B.free(r, local):
                        return (ref, num, text, h, h, x, y, hj, vj), r
        x, y = (edge + dx * 0.5, py) if dx else (px, edge + dy * 0.5)
        r = (x + e[0], y + e[1], x + e[2], y + e[3])
        why = [w for o, w in zip(B.obs, B.why) if hit(r, o)] + [f'label {t}' for t in B.clash(r, 'pin')]
        why += ['board edge'] if not B.inside(r) else []
        why += ['screw head'] if B.screw(r) else []
        return None, f'{ref} pin {num} "{text}" at {h} mm (0.5 mm from the pad: {", ".join(sorted(set(why)))})'

    sizes = conn.get('pin_h', cfg.get('pin_h', [1.0, 0.9]))
    B.pin_gap_x = conn.get('pin_gap_x', PIN_GAP_X)
    # first clear of the vias; then (tented vias, all boards) over them, before a size below PIN_MIN
    for h, vias in [(h, v) for v in (True, False) for h in sizes if h >= PIN_MIN]:
        mark = len(B.placed)
        out = []
        for pin in conn['pins']:
            it, r = one(pin, h, vias)
            if it is None:
                break
            B.placed.append((r, pin[1], 'pin'))
            out.append(it)
        else:
            return out, ([] if vias else [f'{ref} pins: over tented vias']) + \
                [f'{ref} pin {p[0]} "{p[1]}": vertical' for p in conn['pins'] if len(p) > 3 and p[3].get('angle')]
        del B.placed[mark:]
    out, notes, fails = [], [], []
    for pin in conn['pins']:     # no size >= PIN_MIN fits all: each pin the largest size <= PIN_MIN that fits
        for h in [v for v in sizes if v <= PIN_MIN]:
            it, r = one(pin, h, False)
            if it is not None:
                B.placed.append((r, pin[1], 'pin'))
                out.append(it)
                if h < PIN_MIN:
                    notes.append(f'{ref} pin {pin[0]} "{pin[1]}": {h} mm')
                break
        else:
            fails.append(r)
    if fails and B.back:   # back: a pin with no free place is skipped (listed), the others stay
        return out, notes + ['SKIPPED ' + f for f in fails]
    if fails:
        return SystemExit('\n  '.join(fails))
    return out, notes


def place_title(B, conn, cfg):
    """The title block of one connector: the largest size of title_h (glyph width 1.0, then 0.8 of the height) that
    has a free place; at one size, the place nearest to title_near. The lines are centred, or left / right justified
    with the anchor toward the connector (the gate measures the anchor)."""
    b = B.b
    ref = conn['ref']
    title = conn.get('title') or []
    if not title:
        return []
    alts = title if isinstance(title[0], list) else [title]   # wordings, preferred first; the size goes before the wording
    if ref:
        fp = b.FindFootprintByReference(ref)
        pads = [(T(p.GetPosition().x), T(p.GetPosition().y)) for p in fp.Pads() if p.GetNumber() and p.GetDrillSize().x < M(3.0)]
        x0, y0 = min(x for x, _ in pads), min(y for _, y in pads)
        x1, y1 = max(x for x, _ in pads), max(y for _, y in pads)
        reach = lambda x, y: math.hypot(max(x0 - x, 0, x - x1), max(y0 - y, 0, y - y1)) <= TITLE_DIST
    else:   # a board text (free_texts): no connector
        x0, y0 = x1, y1 = conn['title_near']
        reach = lambda x, y: True
    dx, dy = DIRS[conn.get('dir', 'N')]
    if B.back and ref in B.smd:   # SMD connector, back: the title goes under the connector body first
        c = B.smd[ref]
        nx, ny = (c[0] + c[2]) / 2, (c[1] + c[3]) / 2
    elif B.back and conn.get('back_title_near'):   # back only: a different place (e.g. the brand block is in the way)
        nx, ny = conn['back_title_near']
    elif conn.get('title_near'):
        nx, ny = conn['title_near']
    else:
        nx, ny = (x0 + x1) / 2 + dx * 6, (y0 + y1) / 2 + dy * 6
    span = conn.get('title_dx', 12)
    n4 = int(span * 4)
    steps = sorted(((i, j) for i in range(-n4, n4 + 1) for j in range(-n4, n4 + 1)), key=lambda q: q[0] ** 2 + q[1] ** 2)
    win = (nx - span - 30, ny - span - 15, nx + span + 30, ny + span + 15)
    locals_ = {True: B.local(win), False: B.local(win, False)}
    for h, vias, lines, wf in [(h, v, ln, wf) for h in conn.get('title_h', cfg.get('title_h', [1.5, 1.27, 1.0]))
                               for v in (True, False) for ln in alts for wf in (1.0, 0.8)]:
        local = locals_[vias]
        n = len(lines)
        for _ in (0,):
            w = round(h * wf, 3)
            pitch = round(h * 1.4, 3)
            ext = {hj: [extent(b, ln, h, w, hj, 'C', B.back) for ln in lines] for hj in conn.get('title_just', 'CLR')}
            for i, j in steps:
                cx, cy = nx + i * 0.25, ny + j * 0.25
                ys = [cy + (k - (n - 1) / 2) * pitch for k in range(n)]
                if not all(reach(cx, y) for y in ys):
                    continue
                for hj, es in ext.items():
                    rs = [(cx + e[0], y + e[1], cx + e[2], y + e[3]) for e, y in zip(es, ys)]
                    if all(B.free(r, local, 'title') for r in rs):
                        for r, ln in zip(rs, lines):
                            B.placed.append((r, ln, 'title'))
                        return [(ref, None, ln, h, w, cx, y, hj, 'C') for ln, y in zip(lines, ys)]
    if B.back and span < 12:   # back: the brand block can fill the small search box; widen it (the front keeps title_dx)
        return place_title(B, dict(conn, title_dx=12), cfg)
    raise SystemExit(f'board_labels: {ref} title {alts}: no free place within {TITLE_DIST} mm of the pads')


def main():
    args = sys.argv[1:]
    board = args[0]
    dry = '--dry-run' in args
    import project_root
    bd = os.path.join(project_root.root_str(), 'hardware-design', 'boards', board)
    cfg = json.load(open(os.path.join(bd, 'board-labels.json')))
    pcb = os.path.join(bd, json.load(open(os.path.join(bd, 'gate.json')))['project'] + '.kicad_pcb')
    if '--pcb' in args:
        pcb = args[args.index('--pcb') + 1]
    stack = (stackup_block(open(pcb).read()) or (None,))[0]
    src = open(pcb).read()
    moved, n = refs_off_silk(src)
    if n and not dry:
        open(pcb, 'w').write(moved)
    b = pcbnew.LoadBoard(pcb)
    if n and dry:
        print(f'  (dry run: {n} references would move to F.Fab first)')
    for g in list(b.Groups()):
        if g.GetName() in (GROUP, 'silk-marks', GROUP_BACK) or g.GetName() in cfg.get('remove_groups', []):
            for it in list(g.GetItems()):
                b.Delete(it)
            b.Delete(g)
    removed = []
    for d in list(b.GetDrawings()):
        if d.GetClass() == 'PCB_TEXT' and d.GetLayer() == pcbnew.F_SilkS and not d.GetParentGroup():
            x, y = T(d.GetPosition().x), T(d.GetPosition().y)
            if any(d.GetText() == t and math.hypot(x - rx, y - ry) <= 0.3 for t, rx, ry in cfg.get('remove', [])):
                removed.append(d)
    for d in removed:
        b.Delete(d)
    print(f'board_labels {board}: {n} references to F.Fab, {len(removed)} legacy texts removed')
    B = Board(b, set())
    pads_all = port_pads(b, None)
    items, errs, notes = [], [], []
    for conn in cfg['connectors']:
        if conn.get('pins'):
            r = place_pins(B, conn, pads_all, cfg)
            B.pin_gap_x = PIN_GAP_X
            if isinstance(r, SystemExit):
                errs.append(str(r))
            else:
                items += r[0]
                notes += r[1]
    if errs and '--keep-going' not in args:
        raise SystemExit('board_labels: pin labels with no free place:\n  ' + '\n  '.join(errs))
    for conn in cfg['connectors']:
        try:
            items += place_title(B, conn, cfg)
        except SystemExit as e:
            errs.append(str(e))
    for ft in cfg.get('free_texts', []):   # board texts (legend, board title): same search, no connector
        try:
            items += place_title(B, {'ref': None, 'title': ft['text'], 'title_near': ft['near'],
                                     'title_h': ft.get('h', [1.5, 1.27, 1.0]), 'title_dx': ft.get('dx', 6),
                                     'title_just': 'C'}, cfg)
        except SystemExit as e:
            errs.append(str(e))
    if errs and '--keep-going' in args:
        print('  NOT PLACED (--keep-going):\n  ' + '\n  '.join(errs))
    if errs and '--keep-going' not in args:   # --keep-going: write what fits (a scratch copy, for review)
        raise SystemExit('board_labels: titles with no free place:\n  ' + '\n  '.join(errs))
    group = pcbnew.PCB_GROUP(b)
    group.SetName(GROUP)
    b.Add(group)
    for ref, num, text, h, w, x, y, hj, vj in items:
        t = text_item(b, text, h, w, x, y, hj, vj)
        b.Add(t)
        group.AddItem(t)
        print(f'  {ref or "board"}.{num or "title"} "{text}" {h:g}x{w:g} mm at ({x:.2f}, {y:.2f})')
    sizes = {}
    for ref, num, text, h, w, *_ in items:
        sizes.setdefault((ref, num is None), set()).add(h)
    print('  sizes: ' + ', '.join(f'{r} {"title" if t else "pins"} {"/".join(f"{h:g}" for h in sorted(s))}'
                                  for (r, t), s in sizes.items()))
    for n_ in notes:
        print('  SMALLER: ' + n_)
    if dry:
        print(f'board_labels {board}: dry run, {len(items)} texts')
        return
    pcbnew.SaveBoard(pcb, b)
    keep_stackup(pcb, stack)
    print(f'board_labels {board}: {len(items)} texts in group "{GROUP}"')
    if '--labels-only' not in args:
        silk_and_brand(board, pcb, cfg, args)
    if cfg.get('back'):
        back_pass(board, pcb, cfg)
    if cfg.get('info_back'):
        info_pass(board, pcb, cfg)


def back_pass(board, pcb, cfg):
    """Step 5 ("back": true): the same pin labels and titles on B.SilkS, mirrored, aligned to the same pins. It runs
    last, so it sees the brand block and never changes a front item. Same sizes and search as the front; the obstacles
    are the bottom side ones (Board(back=True)); vias always stay clear. An SMD connector (no pad on the bottom) gets
    its labels under its body first. A pin or title with no free place is skipped and listed (not an error)."""
    stack = (stackup_block(open(pcb).read()) or (None,))[0]
    b = pcbnew.LoadBoard(pcb)
    for g in list(b.Groups()):
        if g.GetName() == GROUP_BACK:
            for it in list(g.GetItems()):
                b.Delete(it)
            b.Delete(g)
    B = Board(b, set(), back=True)
    pads_all = port_pads(b, None)
    items, skipped, notes = [], [], []
    for conn in cfg['connectors']:
        if conn.get('pins'):
            r = place_pins(B, conn, pads_all, cfg)
            B.pin_gap_x = PIN_GAP_X
            if isinstance(r, SystemExit):
                skipped.append(str(r))
            else:
                items += r[0]
                notes += r[1]
    for conn in cfg['connectors']:
        try:
            items += place_title(B, conn, cfg)
        except SystemExit as e:
            skipped.append(str(e))
    skipped += [n_[8:] for n_ in notes if n_.startswith('SKIPPED ')]
    notes = [n_ for n_ in notes if not n_.startswith('SKIPPED ')]
    group = pcbnew.PCB_GROUP(b)
    group.SetName(GROUP_BACK)
    b.Add(group)
    for ref, num, text, h, w, x, y, hj, vj in items:
        t = text_item(b, text, h, w, x, y, hj, vj, back=True)
        b.Add(t)
        group.AddItem(t)
        print(f'  back {ref}.{num or "title"} "{text}" {h:g}x{w:g} mm at ({x:.2f}, {y:.2f})')
    for n_ in notes:
        print('  back SMALLER: ' + n_)
    for n_ in skipped:
        print('  back SKIPPED: ' + n_)
    pcbnew.SaveBoard(pcb, b)
    keep_stackup(pcb, stack)
    print(f'board_labels {board}: {len(items)} back texts in group "{GROUP_BACK}", {len(skipped)} skipped')


def silk_and_brand(board, pcb, cfg, args):
    py = sys.executable
    pcb_arg = ['--pcb', pcb] if '--pcb' in args else []
    subprocess.run([py, os.path.join(ROOT, 'tools', 'silk_marks.py'), board] + pcb_arg, check=True)
    br = cfg.get('brand')
    if br:
        for logo in br.get('logo_mm', [16]):
            for tm in br.get('text_mm', [1.2]):
                base = [py, os.path.join(ROOT, 'tools', 'brand_mark.py'), pcb, '--name', br['name'], '--rev', br['rev'],
                        '--logo-mm', str(logo), '--text-mm', str(tm)] + (['--near'] + [str(v) for v in br['near']]
                                                                          if br.get('near') else [])
                if subprocess.run(base + ['--dry-run'], capture_output=True).returncode == 0:
                    subprocess.run(base, check=True)
                    return
        raise SystemExit(f'board_labels {board}: no place for the brand block')




def info_lines(b, block, cfg):
    """The lines of one info_back block. Sources: the board itself (part values, test-point nets) and the config
    (curated wording). kind 'text': its lines; 'columns': its columns of lines; 'parts': [ref, function] -> "REF VALUE  function" (VALUE from the
    footprint); 'testpoints': every TPn with its net (from the pads), in columns of 'rows' lines."""
    kind = block.get('kind', 'text')
    if kind == 'text':   # "{date}": RENDER_DATE (the fab-set date of tools/fab-workflow.sh), else today
        import datetime
        date = os.environ.get('RENDER_DATE') or datetime.date.today().isoformat()
        return [[ln.replace('{date}', date) for ln in block['lines']]]
    if kind == 'columns':   # curated lines in columns: {"columns": [[...], [...]]}
        return [list(c) for c in block['columns']]
    if kind == 'parts':
        out = []
        for ent in block['parts']:   # [ref, function] -> "REF VALUE  function"; [ref, None, short] -> "REF short"
            ref, fn = ent[0], ent[1]
            fp = b.FindFootprintByReference(ref)
            if fp is None:
                raise SystemExit(f'board_labels: info_back parts: no footprint {ref}')
            if len(ent) > 2:   # a short part name must be the start of the footprint value (the BOM part)
                if not fp.GetValue().startswith(ent[2]):
                    raise SystemExit(f'board_labels: info_back parts: {ref} "{ent[2]}" is not the start of {fp.GetValue()}')
                out.append(f'{ref} {ent[2]}' + (f'  {fn}' if fn else ''))
            else:
                out.append(f'{ref} {fp.GetValue()}  {fn}')
        rows = int(block.get('rows', len(out)))
        return [out[i:i + rows] for i in range(0, len(out), rows)]
    if kind == 'testpoints':
        import re
        tps = []
        for fp in b.GetFootprints():
            m = re.match(r'^TP(\d+)$', fp.GetReference())
            if m:
                nets = sorted({p.GetNetname() for p in fp.Pads() if p.GetNetname()})
                tps.append((int(m.group(1)), f"{'' if block.get('bare') else 'TP'}{m.group(1)} "   # bare: no TP prefix
                                              f"{(nets[0] if nets else '-').lstrip('/').replace('PWR-24V/', '')}"))
        lines = [t for _, t in sorted(tps)]
        rows = int(block.get('rows', 10))
        return [lines[i:i + rows] for i in range(0, len(lines), rows)]
    raise SystemExit(f'board_labels: info_back: unknown kind {kind}')


def info_pass(board, pcb, cfg):
    """Step 6 ("info_back", user request 2026-10-11: useful reference on the bottom silkscreen): blocks of text on
    B.SilkS, mirrored, each column kept together, placed at the free spot nearest to its "near" (default: board
    centre) with the same bottom obstacles as the back labels (pads, holes, vias 0.15 mm, other B.SilkS 0.1 mm, screw
    heads, 0.5 mm inside the outline) and TITLE_GAP to every other placed block. Text height h (default 1.0 mm,
    PIN_MIN), stroke by stroke(h). A block with no free place is skipped and listed (not an error)."""
    stack = (stackup_block(open(pcb).read()) or (None,))[0]
    b = pcbnew.LoadBoard(pcb)
    for g in list(b.Groups()):
        if g.GetName() == GROUP_INFO:
            for it in list(g.GetItems()):
                b.Delete(it)
            b.Delete(g)
    B = Board(b, set(), back=True)
    # every other B.SilkS text (the back pin labels and titles) is a placed block: TITLE_GAP to it (Board leaves the
    # label groups out of its obstacles, the label passes rebuild them)
    for d_ in b.GetDrawings():
        if isinstance(d_, pcbnew.PCB_TEXT) and d_.GetLayer() == pcbnew.B_SilkS:
            q = d_.GetEffectiveTextShape().BBox()
            B.placed.append(((T(q.GetLeft()), T(q.GetTop()), T(q.GetRight()), T(q.GetBottom())), d_.GetText(), 'title'))
    bb = b.GetBoardEdgesBoundingBox()
    X0, Y0, X1, Y1 = T(bb.GetLeft()), T(bb.GetTop()), T(bb.GetRight()), T(bb.GetBottom())
    group = pcbnew.PCB_GROUP(b)
    group.SetName(GROUP_INFO)
    b.Add(group)
    placed, skipped = 0, []
    blocks = []
    for block in cfg['info_back']:   # "split": every column is its own block (fits between the vias), same near
        if block.get('kind') == 'panel':
            blocks.append(block)
            continue
        cols_ = info_lines(b, block, cfg)
        if block.get('split') and len(cols_) > 1:
            blocks += [dict(block, kind='text', lines=c, id=f"{block.get('id', 'info')}.{k + 1}") for k, c in enumerate(cols_)]
        else:
            blocks.append(block)
    tented = 'back yes' in ' '.join(open(pcb).read().split('(tenting', 1)[-1].split(')', 3)[:3]).replace('(', ' ')
    lay = cfg.get('info_layout')
    if lay:
        placed += info_grid(b, B, blocks, lay, group, tented, (X0, Y0, X1, Y1), skipped)
        laid = {i for row in lay['rows'] for i in row}
        blocks = [bl for bl in blocks if bl.get('id') not in laid]
    for block in blocks:
        if block.get('kind') == 'panel' and block.get('rect'):   # fixed panel box (alignment): checked, no search
            r = tuple(block['rect'])
            win = (r[0] - 0.5, r[1] - 0.5, r[2] + 0.5, r[3] + 0.5)
            loc = [o for o, w_ in zip(B.obs, B.why) if hit(o, win) and not (tented and w_.startswith('via '))]
            if B.free(r, loc, 'title') and info_panel(b, B, block, group, tented, (X0, Y0, X1, Y1), rect=r):
                placed += 1
                print(f"  info {block.get('id')}: panel at fixed rect {r}")
            else:
                skipped.append(f"{block.get('id')}: fixed rect {r} not free")
            continue
        if block.get('kind') == 'panel':
            r_ = info_panel(b, B, block, group, tented, (X0, Y0, X1, Y1))
            if r_:
                placed += 1
            else:
                skipped.append(f"{block.get('id')}: no free place")
            continue
        h = float(block.get('h', PIN_MIN))
        pitch = h * float(block.get('line_pitch', 1.45))
        cols = info_lines(b, block, cfg)
        col_gap = float(block.get('col_gap', 2.0))
        # column boxes relative to the block origin (top left of the first column), left justified lines
        boxes, x = [], 0.0
        for col in cols:
            w = max((extent(b, t, h, h, 'L', 'T', True)[2] - extent(b, t, h, h, 'L', 'T', True)[0]) for t in col)
            boxes.append((x, w, col))
            x += w + col_gap
        W, H = x - col_gap, pitch * max(len(c) for c in cols)
        near = block.get('near', [(X0 + X1) / 2, (Y0 + Y1) / 2])
        best = None
        step = 0.5
        ys = [Y0 + k * step for k in range(int((Y1 - Y0) / step))]
        xs = [X0 + k * step for k in range(int((X1 - X0) / step))]
        for y in ys:
            for x0 in xs:
                r = (x0, y, x0 + W, y + H)
                d = math.hypot((r[0] + r[2]) / 2 - near[0], (r[1] + r[3]) / 2 - near[1])
                if best is not None and d >= best[0]:
                    continue
                if B.free(r, B.local((r[0] - 0.5, r[1] - 0.5, r[2] + 0.5, r[3] + 0.5)), 'title'):
                    best = (d, r)
        if best is None:
            skipped.append(f'{block.get("id", block.get("kind"))}: no free place for {W:.1f} x {H:.1f} mm')
            continue
        r = best[1]
        B.placed.append((r, block.get('id', 'info'), 'title'))
        for cx, cw, col in boxes:
            for i, text in enumerate(col):
                e = extent(b, text, h, h, 'L', 'T', True)
                # mirrored text: the lines share their right edge in board coordinates, so they read left aligned
                # from the bottom side; the glyph box (not the anchor) is placed
                ax, ay = r[0] + cx + cw - e[2], r[1] + i * pitch - e[1]
                t = text_item(b, text, h, h, ax, ay, 'L', 'T', back=True)
                b.Add(t)
                group.AddItem(t)
        placed += 1
        print(f'  info {block.get("id", block.get("kind"))}: {W:.1f} x {H:.1f} mm at ({r[0]:.2f}, {r[1]:.2f}), h {h:g} mm, '
              f'{sum(len(c) for c in cols)} lines')
    pcbnew.SaveBoard(pcb, b)
    keep_stackup(pcb, stack)
    print(f'board_labels {board}: {placed} info blocks in group "{GROUP_INFO}"' +
          ''.join(f'\n  NOT PLACED info {s_}' for s_ in skipped))


def info_panel(b, B, block, group, tented, outline, rect=None, measure=False):
    """A framed panel on B.SilkS (info_back kind "panel", user request 2026-10-11: board description, features,
    warnings, key parts; "aesthetic"). Laid out in bottom-view coordinates (u to the right as seen from below = -x on
    the board, v down) and mirrored onto the board: a frame with 0.8 mm chamfered corners, a header (h_head, with an
    optional "icon" glyph, e.g. the warning sign) and a rule under it, then the body lines (h; "• " bullets as given).
    Frame and rule: 0.15 mm lines (stroke(1.0)). Placement: the free spot nearest to "near"; on a board with tented
    back vias (setup tenting back yes) the panel may print over vias (solder mask covers them; pads, holes, screw
    heads, other silk and the outline still keep clear), like the front labels' tented-via fallback."""
    h = float(block.get('h', PIN_MIN))
    hh = float(block.get('h_head', 1.6))
    pad = float(block.get('pad', 1.0))
    pitch = h * float(block.get('line_pitch', 1.6))
    lw = stroke(1.0)
    icon = block.get('icon', '')
    head = block.get('header', '')
    cols = info_lines(b, dict(block, kind=block.get('body_kind', 'text')), None)
    cols[-1] = cols[-1] + list(block.get('extra', []))
    cgap = float(block.get('col_gap', 2.5))
    lines = max(cols, key=len)   # the body height is the longest column
    wid = lambda t, hgt: (extent(b, t, hgt, hgt, 'L', 'T', True)[2] - extent(b, t, hgt, hgt, 'L', 'T', True)[0])
    ih = hh * 1.5 if icon else 0.0          # icon "warning": a drawn triangle (the stroke-font sign does not render)
    head_w = (ih * 1.15 + 0.8 if icon else 0.0) + (wid(head, hh) if head else 0.0)
    colw = [max([wid(t, h) for t in c] or [0.0]) for c in cols]
    body_w = sum(colw) + cgap * (len(cols) - 1)
    W = 2 * pad + max(head_w, body_w, float(block.get('min_w', 0)))
    head_h = max(hh, ih) if (head or icon) else 0.0
    H = 2 * pad + head_h + (pad * 1.3 if head_h else 0.0) + len(lines) * pitch - (pitch - h if lines else 0.0)
    if measure:
        return W, H
    X0, Y0, X1, Y1 = outline
    near = block.get('near', [(X0 + X1) / 2, (Y0 + Y1) / 2])
    best = None if rect is None else (0.0, rect)   # rect: a grid cell from info_layout (frame stretched to it)
    if rect is not None:
        W, H = rect[2] - rect[0], rect[3] - rect[1]
    step = 0.5
    y = Y0 if rect is None else Y1   # no search for a given cell
    while y + H < Y1:
        x = X0
        while x + W < X1:
            r = (x, y, x + W, y + H)
            d = math.hypot((r[0] + r[2]) / 2 - near[0], (r[1] + r[3]) / 2 - near[1])
            if best is None or d < best[0]:
                loc = B.local((r[0] - 0.5, r[1] - 0.5, r[2] + 0.5, r[3] + 0.5))
                if tented:
                    win = (r[0] - 0.5, r[1] - 0.5, r[2] + 0.5, r[3] + 0.5)
                    loc = [o for o, w_ in zip(B.obs, B.why) if hit(o, win) and not w_.startswith('via ')]
                if B.free(r, loc, 'title'):
                    best = (d, r)
            x += step
        y += step
    if best is None:
        print(f"  info {block.get('id')}: no free place for {W:.1f} x {H:.1f} mm")
        return None
    r = best[1]
    B.placed.append((r, block.get('id', 'panel'), 'title'))
    vx = lambda u: r[2] - u            # bottom view: u from the panel's left edge as seen from below
    items = []
    def seg(u0, v0, u1, v1):
        sh = pcbnew.PCB_SHAPE(b)
        sh.SetShape(pcbnew.SHAPE_T_SEGMENT)
        sh.SetLayer(pcbnew.B_SilkS)
        sh.SetWidth(M(lw))
        sh.SetStart(pcbnew.VECTOR2I(M(vx(u0)), M(r[1] + v0)))
        sh.SetEnd(pcbnew.VECTOR2I(M(vx(u1)), M(r[1] + v1)))
        items.append(sh)
    c = 0.8   # chamfer
    for a in ((c, 0, W - c, 0), (W, c, W, H - c), (W - c, H, c, H), (0, H - c, 0, c),
              (0, c, c, 0), (W - c, 0, W, c), (W, H - c, W - c, H), (c, H, 0, H - c)):
        seg(*a)
    def txt(t, hgt, u_left, v_top):
        e = extent(b, t, hgt, hgt, 'L', 'T', True)
        w_ = e[2] - e[0]
        # the glyph box spans u_left .. u_left + w_ (bottom view) = board x vx(u_left + w_) .. vx(u_left)
        it = text_item(b, t, hgt, hgt, vx(u_left + w_) - e[0], r[1] + v_top - e[1], 'L', 'T', back=True)
        items.append(it)
        return w_
    v = pad
    if head_h:
        u = pad
        if icon:
            tw, t0 = ih * 1.15, v + (head_h - ih) / 2      # triangle: base tw, height ih
            seg(u, t0 + ih, u + tw, t0 + ih)
            seg(u + tw, t0 + ih, u + tw / 2, t0)
            seg(u + tw / 2, t0, u, t0 + ih)
            bang = '!'
            bh = ih * 0.55
            txt(bang, bh, u + tw / 2 - wid(bang, bh) / 2, t0 + ih * 0.36)
            u += tw + 0.8
        if head:
            txt(head, hh, u, v + (head_h - hh) / 2)
        v += head_h + pad * 0.65
        seg(pad * 0.5, v, W - pad * 0.5, v)
        v += pad * 0.65
    u = pad
    for c, cw in zip(cols, colw):
        for i, t in enumerate(c):
            txt(t, h, u, v + i * pitch)
        u += cw + cgap
    for it in items:
        b.Add(it)
        group.AddItem(it)
    print(f"  info {block.get('id')}: panel {W:.1f} x {H:.1f} mm at ({r[0]:.2f}, {r[1]:.2f}), {len(lines)} lines")
    return r


def info_grid(b, B, blocks, lay, group, tented, outline, skipped):
    """info_layout (user 2026-10-11: "aligned to some kind of grid ... it looks messy"): the listed panels as one grid
    as seen from the bottom: rows of panels, every column the same width (the widest panel, at least col_w), every
    panel of a row the same height (the tallest of the row), gutter mm between columns, row_gap between rows. The grid
    origin (its top left corner seen from below) snaps to snap mm and goes to the free position nearest to "near"
    (board centre by default) where every cell is free (the info_panel rules: tented vias allowed, pads, holes, screw
    heads, other silk and the outline clear). "span_single": a one-panel row spans the grid width. "at": [xr, yt] a fixed
    origin (checked, no search). Returns the number of panels drawn. A panel block outside the grid may give a fixed
    "rect" [x0, y0, x1, y1] (board mm; checked like a grid cell)."""
    by_id = {bl.get('id'): bl for bl in blocks}
    rows = [[by_id[i] for i in row] for row in lay['rows']]
    size = {bl['id']: info_panel(b, B, bl, group, tented, outline, measure=True) for row in rows for bl in row}
    ncol = max(len(r) for r in rows)
    spans = {r[0]['id'] for r in rows if len(r) == 1 and lay.get('span_single')}   # full-width rows: not in col_w
    col_w = max([float(lay.get('col_w', 0))] + [w for i, (w, _) in size.items() if i not in spans])
    gut, rgap, snap = float(lay.get('gutter', 3.0)), float(lay.get('row_gap', 3.0)), float(lay.get('snap', 0.5))
    row_h = [max(size[bl['id']][1] for bl in r) for r in rows]
    GW, GH = ncol * col_w + (ncol - 1) * gut, sum(row_h) + (len(rows) - 1) * rgap
    X0, Y0, X1, Y1 = outline
    near = lay.get('near', [(X0 + X1) / 2, (Y0 + Y1) / 2])
    def cells(xr, yt):   # xr: board x of the grid's left edge seen from below (= its right edge on the board)
        out, v = [], yt
        for ri, r in enumerate(rows):
            if len(r) == 1 and lay.get('span_single'):   # a one-panel row spans the whole grid width
                out.append((r[0], (xr - GW, v, xr, v + row_h[ri])))
            else:
                for ci, bl in enumerate(r):
                    u0 = ci * (col_w + gut)
                    out.append((bl, (xr - u0 - col_w, v, xr - u0, v + row_h[ri])))
            v += row_h[ri] + rgap
        return out
    def free(r):
        win = (r[0] - 0.5, r[1] - 0.5, r[2] + 0.5, r[3] + 0.5)
        loc = [o for o, w_ in zip(B.obs, B.why) if hit(o, win) and not (tented and w_.startswith('via '))]
        return B.free(r, loc, 'title')
    best = None
    if lay.get('at'):   # fixed grid origin [xr, yt] (xr: board x of the grid's left edge seen from below): checked, no search
        xr, yt = lay['at']
        if all(free(r) for _, r in cells(xr, yt)):
            best = (0.0, xr, yt)
        else:
            for bl_, r_ in cells(xr, yt):
                win = (r_[0] - 0.5, r_[1] - 0.5, r_[2] + 0.5, r_[3] + 0.5)
                bad = [(w_, tuple(round(v, 1) for v in o)) for o, w_ in zip(B.obs, B.why)
                       if hit(o, win) and not (tented and w_.startswith('via '))][:4]
                if not free(r_):
                    skipped.append(f"info_layout: cell {bl_.get('id')} {tuple(round(v, 1) for v in r_)} blocked by {bad}")
            skipped.append(f"info_layout: the grid at {lay['at']} is not free")
            return 0
    k0 = math.ceil((X0 + GW) / snap) if best is None else int(X1 / snap) + 1
    for ky in range(math.ceil(Y0 / snap), int((Y1 - GH) / snap) + 1):
        for kx in range(k0, int(X1 / snap) + 1):
            xr, yt = kx * snap, ky * snap
            d = math.hypot(xr - GW / 2 - near[0], yt + GH / 2 - near[1])
            if best is not None and d >= best[0]:
                continue
            if all(free(r) for _, r in cells(xr, yt)):
                best = (d, xr, yt)
    if best is None:
        skipped.append(f'info_layout: no free place for the {GW:.1f} x {GH:.1f} mm grid')
        return 0
    n = 0
    for bl, r in cells(best[1], best[2]):
        if info_panel(b, B, bl, group, tented, outline, rect=r):
            n += 1
    print(f'  info_layout: {len(rows)} rows x {ncol} columns, cell width {col_w:.1f} mm, grid {GW:.1f} x {GH:.1f} mm '
          f'at ({best[1] - GW:.2f}, {best[2]:.2f})')
    return n


if __name__ == '__main__':
    main()
