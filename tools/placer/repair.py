#!/usr/bin/env python3
"""Failure-driven placement repair: the in-house router is the judge (idea: TraceMaker src/place/routable.cpp at
c6fcb7b, tools/pcb_search/README.md "Repair locally").

  $PY tools/placer/repair.py prepare SRC.kicad_pcb PLACE.kicad_pcb --board BOARD [--keep lock-nets|locked]
  $PY tools/placer/repair.py run BOARD PLACE.kicad_pcb ROUTED.kicad_pcb --outdir DIR
        [--mode reuse|local|full] [--max-routes 8] [--per-round 4] [--iters 80] [--seed 1] [--no-rotate] [--read ARG ...]

prepare: a copy of SRC with all tracks and vias removed except the lock-net copper (diff pairs + DRU via_count 0
nets, as tools/router/run.py --lock-from), locked, and all footprints unlocked. --keep locked keeps all locked copper
of SRC instead (the hand geometry: pairs, crystals and the locked GND stubs of fixed pads). This is the placement board: the
problem is read from it (cli.py read; a unit with a pad on locked copper, a connector at the edge and a mounting
hole stay fixed).

run: ROUTED is a tools/router/run.py result of PLACE (FAIL, with ROUTED.iotroute/drc.json). One round:
  1. Failures = the KiCad DRC errors and unconnected items of ROUTED, with their locations (zone items have no
     location and are not used as points).
  2. Candidate units = movable units (not fixed, no connector) that own a failure pad or have a rect within
     legal_radius of a failure point. A unit is a whole block (User.1 border) or a decap-tie group: its internal
     layout stays rigid.
  3. Proposals = legal places on the legalizer grid (legal_step, out to legal_radius; anneal.SEARCH) and the 4
     turns: Evaluator.legal_penalty_at = 0 (courtyard, pad clearance, domain gaps, keepouts, board edge, top side).
     A proposal must decrease the failure term (unconnected: pad-to-pad distance; every located item: minus its
     free room = distance to the nearest other rect, capped at legal_radius). Ranked by (failure term decrease,
     placement cost delta, displacement); one per unit, direction octant and turn; then round-robin over the units.
     Decap slide: a decap that cli.py read ties to its IC (--decap-tie, default 3 mm) may move alone (problem read
     again with --decap-tie 0) when the tie stays true (pad-edge gap to its IC pin <= the tie distance).
     Deterministic (no random state; --seed is recorded).
  4. Each proposal is written (kicad_io.write_board) and routed with run.py:
     reuse (default): the moved placement (PLACE + the move) routed with run.py --reuse ROUTED --reuse-fallback
            none: the router keeps the copper of the nets that the move does not touch and routes the rest
            (tools/router/DESIGN.md 5c); ROUTED = the present candidate's routed board.
     local: on a copy of ROUTED; the writer rips the copper that the moved pads meet, and the unlocked copper
            clusters within legal_radius of a failure point or on a failed net are ripped too. run.py keeps and
            locks all other copper and routes only what is open.
     full:  on a copy of PLACE (lock-net copper only): a full route.
     The score is measured (placer/iotroute_step.py): DRC errors + unconnected + parity (kicad-cli on the saved
     board), then the board gate (only at DRC part 0), then track length, then vias. A proposal is accepted only
     when its key is strictly lower; the previous candidate stays until then.
  5. An accepted proposal starts the next round from its result. Stop: score 0 (DRC 0/0/0 + gate PASS), no
     proposal, a round without improvement, --max-routes, or only failures that no move can repair: a DRC item on
     a pad of a fixed unit that the router (route.json of the full start route) reports as "fixed copper alone
     walls it in (input)".
DIR/repair.json holds every attempt (move, key, paths) and the verdict. The result is a scratch candidate only.
"""
import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import anneal, cost, escape, iotroute_step  # noqa: E402

REPO = iotroute_step.REPO
NO_RESULT = iotroute_step.NO_RESULT
CONNECTOR = ('J', 'P', 'CN')        # kicad_io: connectors are board-specific, placed at the board edge
SIDECARS = ('.kicad_pro', '.kicad_dru', '.kicad_sch')
TABLES = ('fp-lib-table', 'sym-lib-table')
EPS = 1e-9


def load(path):
    with open(path) as fh:
        return json.load(fh)


def dump(obj, path):
    with open(path, 'w') as fh:
        json.dump(obj, fh, indent=1)

PAD_RE = re.compile(r'^Pad (\S+) \[([^\]]*)\] of (\S+) on')
NET_RE = re.compile(r'\[([^\]]*)\]')


# ---------- failures ----------

def parse_item(item):
    """KiCad DRC JSON item -> {point, ref, pad, net}. A zone has no useful position (point None)."""
    text = item.get('description', '')
    pos = item.get('pos') or {}
    point = (float(pos['x']), float(pos['y'])) if 'x' in pos and 'y' in pos else None
    out = dict(point=point, ref=None, pad=None, net=None, text=text)
    m = PAD_RE.match(text)
    if m:
        out.update(pad=m.group(1), net=m.group(2), ref=m.group(3))
    else:
        n = NET_RE.search(text)
        out['net'] = n.group(1) if n else None
    if text.startswith('Zone '):
        out['point'] = None
    return out


def parse_failures(drc):
    """KiCad DRC report (dict) -> failures [{kind, type, items}]; kind 'drc' (severity error) or 'unconnected'."""
    out = []
    for v in drc.get('violations', []):
        if v.get('severity') == 'error':
            out.append(dict(kind='drc', type=v.get('type', '?'), items=[parse_item(i) for i in v.get('items', [])]))
    for v in drc.get('unconnected_items', []):
        out.append(dict(kind='unconnected', type='unconnected', items=[parse_item(i) for i in v.get('items', [])]))
    for v in drc.get('schematic_parity', []):
        out.append(dict(kind='parity', type=v.get('type', '?'), items=[parse_item(i) for i in v.get('items', [])]))
    return out


WALL_RE = re.compile(r'^pour: (\S+)\.(\S+) on (\S+): .*fixed copper alone walls it in \(input\)')


def walled_pads(notes):
    """{(ref, pad)} that the router (route.json notes of a full route) reports as walled in by the fixed input
    copper alone: no move of another unit can open them."""
    return {(m.group(1), m.group(2)) for n in notes or [] for m in [WALL_RE.match(n)] if m}


def split_walled(fails, walled, pr):
    """(failures a move may repair, failures of a walled pad of a fixed unit)."""
    by_ref = ref_units(pr)
    keep, input_faults = [], []
    for f in fails:
        pads = [(it['ref'], it['pad']) for it in f['items'] if it['ref']]
        if (f['kind'] == 'drc' and pads and all(q in walled for q in pads)
                and all(pr['units'][by_ref[r]]['fixed'] for r, _ in pads if r in by_ref)):
            input_faults.append(f)
        else:
            keep.append(f)
    return keep, input_faults


def failure_points(fails):
    return [it['point'] for f in fails for it in f['items'] if it['point'] is not None]


def failure_nets(fails):
    """Nets of the unconnected items (their copper is ripped in local mode)."""
    return sorted({it['net'] for f in fails if f['kind'] == 'unconnected' for it in f['items'] if it['net']})


# ---------- geometry of the problem ----------

def ref_units(pr):
    return {r: i for i, u in enumerate(pr['units']) for r in u['refs']}


def pad_offset(u, ref, num):
    """Pad centre relative to the unit origin (unturned), from u['cu'] / u['cu_pads']; None if not found."""
    for box, meta in zip(u.get('cu', []), u.get('cu_pads', [])):
        if meta[0] == ref and str(meta[2]) == str(num):
            return ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)
    return None


def item_point(pr, units_by_ref, pose, it):
    """World point of a failure item: a pad moves with its unit; other items stay where they are."""
    if it['ref'] is not None and it['ref'] in units_by_ref:
        i = units_by_ref[it['ref']]
        off = pad_offset(pr['units'][i], it['ref'], it['pad'])
        if off is not None:
            x, y, r = pose[i]
            dx, dy = cost.rot_pt(off[0], off[1], r)
            return (x + dx, y + dy)
    return it['point']


def rect_dist(p, rect):
    dx = max(rect[0] - p[0], 0.0, p[0] - rect[2])
    dy = max(rect[1] - p[1], 0.0, p[1] - rect[3])
    return math.hypot(dx, dy)


def unit_dist(pr, pose, i, p):
    return min((rect_dist(p, w) for w in cost.world_rects(pr['units'][i], pose[i])), default=math.inf)


def unit_room(u, pose_u, p, cap):
    """Distance from p to the nearest rect of unit u that does not contain p (its own pad, courtyard or block
    border contains it), capped at cap."""
    best = cap
    for w in cost.world_rects(u, pose_u):
        if not (w[0] <= p[0] <= w[2] and w[1] <= p[1] <= w[3]):
            best = min(best, rect_dist(p, w))
    return best


class Term:
    """Failure term (lower is better) for single-unit trial moves. Unconnected: the endpoint distances (pads move
    with their units). Every located item (DRC, parity or unconnected endpoint): minus its free room = the
    distance to the nearest rect of another unit (not the unit of the item's part) that does not contain it,
    capped at `cap` (the move radius). The room of the
    units that do not move is computed once per moved unit."""

    def __init__(self, pr, pose, fails, cap):
        self.pr, self.pose, self.fails, self.cap = pr, [tuple(q) for q in pose], fails, cap
        self.by_ref = ref_units(pr)
        self.static = {}

    def _points(self, pose):
        return [[item_point(self.pr, self.by_ref, pose, it) for it in f['items']] for f in self.fails]

    def _room(self, p, pose, skip=()):
        return min([unit_room(u, pose[j], p, self.cap) for j, u in enumerate(self.pr['units']) if j not in skip]
                   + [self.cap])

    def value(self, i=None, q=None):
        pose = self.pose
        if i is not None:
            pose = list(self.pose)
            pose[i] = tuple(q)
        pts = self._points(pose)
        total = 0.0
        for f, row in zip(self.fails, pts):
            if f['kind'] == 'unconnected':
                ok = [p for p in row if p is not None]
                total += sum(math.hypot(a[0] - b[0], a[1] - b[1]) for a, b in zip(ok, ok[1:]))
        for fi, (f, row) in enumerate(zip(self.fails, pts)):
            for k, (it, p) in enumerate(zip(f['items'], row)):
                if p is None:
                    continue
                own = self.by_ref.get(it['ref'])
                if i is None or own == i:   # no move, or the point moves with unit i
                    total -= self._room(p, pose, {own})
                    continue
                key = (i, fi, k)
                if key not in self.static:
                    self.static[key] = self._room(p, pose, {i, own})
                total -= min(self.static[key], unit_room(self.pr['units'][i], pose[i], p, self.cap))
        return total


def failure_term(pr, pose, fails, cap):
    return Term(pr, pose, fails, cap).value()


def movable(pr, i):
    u = pr['units'][i]
    if u['fixed']:
        return False
    from placer.kicad_io import ref_prefix
    return not any(ref_prefix(r) in CONNECTOR for r in u['refs'])


def candidates(pr, pose, fails, radius):
    """Movable units that own a failure pad or have a rect within `radius` of a failure point; nearest first."""
    by_ref = ref_units(pr)
    owners = {by_ref[it['ref']] for f in fails for it in f['items'] if it['ref'] in by_ref}
    pts = [item_point(pr, by_ref, pose, it) for f in fails for it in f['items']]
    pts = [p for p in pts if p is not None]
    out = []
    for i in range(len(pr['units'])):
        if not movable(pr, i):
            continue
        d = min([unit_dist(pr, pose, i, p) for p in pts] + [math.inf])
        if i in owners or d <= radius:
            out.append((0.0 if i in owners else d, i))
    return [i for _, i in sorted(out)]


def octant(dx, dy):
    return int(((math.atan2(dy, dx) + math.pi) / (2 * math.pi) * 8 + 0.5)) % 8


def proposals(pr, pose, fails, params=None, rotate=True, units=None, ev=None, allowed=None, tag='main'):
    """Legal, failure-improving single-unit moves, best first: [dict(unit, x, y, r, term, dcost, disp)].
    allowed(i, x, y, r) is an extra legality rule (the decap tie of a decap slide)."""
    p = anneal.params_all(params or {})
    step, radius = float(p['legal_step']), float(p['legal_radius'])
    if ev is None:
        ev = cost.Evaluator(pr, p, pose=[tuple(q) for q in pose])
    tm = Term(pr, pose, fails, radius)
    f0 = tm.value()
    rings = int(radius / step + EPS)
    best = {}
    for i in (units if units is not None else candidates(pr, pose, fails, radius)):
        x0, y0, r0 = pose[i]
        turns = [r0] + ([r for r in range(4) if r != r0] if rotate and pr['units'][i].get('rotate', True) else [])
        sites = [(0, 0)] + [ab for k in range(1, rings + 1) for ab in anneal.ring(k)]
        for a, b in sites:
            x, y = x0 + a * step, y0 + b * step
            for r in turns:
                if a == 0 and b == 0 and r == r0:
                    continue
                if math.hypot(x - x0, y - y0) > radius + EPS:
                    continue
                if ev.legal_penalty_at(i, x, y, r) > EPS:
                    continue
                if allowed is not None and not allowed(i, x, y, r):
                    continue
                term = tm.value(i, (x, y, r))
                if term >= f0 - EPS:
                    continue
                dcost = ev.propose([(i, x, y, r)])
                ev.revert()
                disp = math.hypot(x - x0, y - y0)
                key = (i, octant(a, b) if (a or b) else -1, r)
                cand = dict(problem=tag, unit=i, name=pr['units'][i]['name'], x=round(x, 6), y=round(y, 6), r=r,
                            term=round(term, 6), term0=round(f0, 6), dcost=round(dcost, 6), disp=round(disp, 6))
                if key not in best or rank(cand) < rank(best[key]):
                    best[key] = cand
    return interleave(best.values())


def interleave(props):
    """Best first per unit, then round-robin over the units (the unit with the best proposal first)."""
    per_unit = {}
    for c in sorted(props, key=rank):
        per_unit.setdefault((c.get('problem', 'main'), c['unit']), []).append(c)
    order = sorted(per_unit, key=lambda k: rank(per_unit[k][0]))
    out = []
    for depth in range(max([len(v) for v in per_unit.values()] + [0])):
        out += [per_unit[k][depth] for k in order if depth < len(per_unit[k])]
    return out


def rank(c):
    """Largest failure-term decrease first (the main and the loose problem have different absolute terms)."""
    return (round(c['term'] - c['term0'], 6), c['dcost'], c['disp'], c.get('problem', 'main'), c['unit'],
            c['x'], c['y'], c['r'])


def hot_order(props, probs, routed):
    """Rank 'hot' (README "Repair rank by router congestion"): the proposals that take the most PathFinder history of the
    present route away from the unit's signal pins first (dhot = history at the pins after - before, congest.py), then
    the 'term' order. No congestion map next to the route: the 'term' order."""
    from placer import congest
    path = routed + '.iotroute/congestion.json'
    if not os.path.isfile(path):
        return props
    cmap = congest.from_route(path)
    models = {k: (congest.Model(q, cmap), cost.initial_pose(q)) for k, q in probs.items()}
    out = []
    for k, c in enumerate(props):
        m, pose = models[c.get('problem', 'main')]
        c = dict(c, dhot=round(m.value(c['unit'], c['x'], c['y'], c['r']) - m.value(c['unit'], *pose[c['unit']]), 6))
        out.append((c['dhot'], k, c))
    return [c for _, _, c in sorted(out, key=lambda t: (t[0], t[1]))]


# ---------- escape-aware proposals ----------

ESC_W = 20.0  # w_esc of the evaluator that ranks escape moves (the compaction runs use the same weight)


def failed_pins(pr, fails, model):
    """[(unit, pin index)] of the IC escape pins (escape.py) that an unconnected item names."""
    by_ref = ref_units(pr)
    out = set()
    for f in fails:
        if f['kind'] != 'unconnected':
            continue
        for it in f['items']:
            i = by_ref.get(it['ref'])
            if i is None or model.pins[i] is None:
                continue
            q, meta = model.pins[i], pr['units'][i].get('cu_pads') or []
            for a, row in enumerate(q['rows']):
                if q['names'][a][0] == it['ref'] and row < len(meta) and str(meta[row][2]) == str(it['pad']):
                    out.add((i, a))
    return sorted(out)


def corridor_blockers(pr, pose, model, pins, slack=None):
    """Movable units whose copper is within the corridor radius (+ slack, default the track radius) of a ray of
    one of the pins: the units that wall the pin in. Nearest first."""
    import numpy as np
    cu, cu_unit, cu_part = escape.world_cu(pr, pose, model)
    best = {}
    for i, a in pins:
        q = model.pins[i]
        x, y, r = pose[i]
        S = q['off'][r % 4][a] + q['toe'][r % 4][a] + (x, y)  # (3, k, 2)
        sl = q['rt'][a] if slack is None else slack
        dx = np.maximum(np.maximum(cu[:, 0] - S[..., 0, None], S[..., 0, None] - cu[:, 2]), 0.0)
        dy = np.maximum(np.maximum(cu[:, 1] - S[..., 1, None], S[..., 1, None] - cu[:, 3]), 0.0)
        m = (np.sqrt(dx * dx + dy * dy) - q['rad'][a][None, :, None]).min(axis=(0, 1))  # (Q,)
        skip = ((cu_unit == i) & (cu_part == q['part'][a])) | ((cu[:, 4] == q['net'][a]) & (q['net'][a] > 0))
        for k in np.nonzero((m < sl) & ~skip)[0]:
            j = int(cu_unit[k])
            if j != i and movable(pr, j):
                best[j] = min(best.get(j, math.inf), float(m[k]))
    return [j for j, _ in sorted(best.items(), key=lambda t: (t[1], t[0]))]


def escape_proposals(pr, pose, fails, params=None, rotate=True, tag='main', allowed=None):
    """Legal single-unit moves of the units that wall in a failed IC pin (an unconnected item at an escape pin),
    best first. term = sum of blocked(pin) over the failed pins (escape.py), it must decrease; dcost from an
    evaluator with the escape term (w_esc ESC_W), so a move that walls in another pin ranks lower."""
    p = anneal.params_all(dict(params or {}, w_esc=(params or {}).get('w_esc') or ESC_W))
    model = escape.Model(pr, p)
    pins = failed_pins(pr, fails, model)
    if not pins:
        return []
    step, radius = float(p['legal_step']), float(p['legal_radius'])
    pose = [tuple(q) for q in pose]
    ev = cost.Evaluator(pr, p, pose=pose)

    def term(ps):
        cu = escape.world_cu(pr, ps, model)
        return sum(float(model.blocked(i, ps[i], [a], *cu)[0]) for i, a in pins)
    f0 = term(pose)
    if f0 <= EPS:
        return []
    rings = int(radius / step + EPS)
    best = {}
    for j in corridor_blockers(pr, pose, model, pins):
        x0, y0, r0 = pose[j]
        turns = [r0] + ([r for r in range(4) if r != r0] if rotate and pr['units'][j].get('rotate', True) else [])
        for a, b in [(0, 0)] + [ab for k in range(1, rings + 1) for ab in anneal.ring(k)]:
            x, y = x0 + a * step, y0 + b * step
            if math.hypot(x - x0, y - y0) > radius + EPS:
                continue
            for r in turns:
                if a == 0 and b == 0 and r == r0:
                    continue
                trial = list(pose)
                trial[j] = (x, y, r)
                t = term(trial)
                if t >= f0 - EPS:
                    continue
                if ev.legal_penalty_at(j, x, y, r) > EPS:
                    continue
                if allowed is not None and not allowed(j, x, y, r):
                    continue
                dcost = ev.propose([(j, x, y, r)])
                ev.revert()
                disp = math.hypot(x - x0, y - y0)
                key = (j, octant(a, b) if (a or b) else -1, r)
                cand = dict(problem=tag, kind='escape', unit=j, name=pr['units'][j]['name'], x=round(x, 6),
                            y=round(y, 6), r=r, term=round(t, 6), term0=round(f0, 6), dcost=round(dcost, 6),
                            disp=round(disp, 6))
                if key not in best or rank(cand) < rank(best[key]):
                    best[key] = cand
    return interleave(best.values())


def escape_loose(pr, loose, fails, tie, rotate=True):
    """escape_proposals in the loose problem (read with --decap-tie 0): a tied decap that walls in the pin may move
    when its decap tie stays true (decap_slides rule); other units move as in the main problem."""
    ties = tied_decaps(pr, loose)
    pose = cost.initial_pose(loose)
    gnd = gnd_codes(loose)

    def allowed(i, x, y, r):
        if i not in ties:
            return True
        trial = list(pose)
        trial[i] = (x, y, r)
        return decap_gap(loose, trial, i, ties[i], gnd) <= tie + EPS
    return escape_proposals(loose, pose, fails, rotate=rotate, tag='loose', allowed=allowed)


def alternate(first, second):
    """first[0], second[0], first[1], second[1], ... (no duplicate unit pose)."""
    out, seen = [], set()
    for k in range(max(len(first), len(second))):
        for lst in (first, second):
            if k < len(lst):
                c = lst[k]
                key = (c.get('problem', 'main'), c['unit'], c['x'], c['y'], c['r'])
                if key not in seen:
                    seen.add(key)
                    out.append(c)
    return out


# ---------- decap slides ----------

def world_box(box, pose_u):
    x, y, r = pose_u
    a, b, c, d = cost.rot_rect(box, r)
    return (a + x, b + y, c + x, d + y)


def box_gap(a, b):
    return math.hypot(max(a[0] - b[2], 0.0, b[0] - a[2]), max(a[1] - b[3], 0.0, b[1] - a[3]))


def decap_gap(loose, pose, cap, ic, gnd):
    """Smallest gap from a non-GND pad of unit `cap` to a pad of the same net on unit `ic` (kicad_io._decaps uses
    the same pad-edge gap for the tie)."""
    uc, ui = loose['units'][cap], loose['units'][ic]
    gaps = [box_gap(world_box(a[:4], pose[cap]), world_box(b[:4], pose[ic]))
            for a in uc.get('cu', []) if a[4] > 0 and a[4] not in gnd
            for b in ui.get('cu', []) if b[4] == a[4]]
    return min(gaps, default=math.inf)


def tied_decaps(pr, loose):
    """{loose unit of a tied decap: loose unit of its IC} for the caps of pr['decaps'] that are a unit of their own
    in the loose problem (read with --decap-tie 0)."""
    lref = ref_units(loose)
    out = {}
    for cap, ic, _ in pr.get('decaps') or []:
        if cap in lref and ic in lref and loose['units'][lref[cap]]['refs'] == [cap]:
            out[lref[cap]] = lref[ic]
    return out


def gnd_codes(pr):
    return {int(c) for c, (name, _) in (pr.get('cu_nets') or {}).items() if name == 'GND'}


def decap_slides(pr, loose, fails, tie, params=None, rotate=True):
    """Moves of single tied decaps (rigid in pr) in the loose problem: legal there, failure term down, and the
    decap tie still true afterwards (gap to its IC pin <= tie, the cli.py read --decap-tie distance)."""
    ties = tied_decaps(pr, loose)
    if not ties or tie <= 0:
        return []
    p = anneal.params_all(params or {})
    pose = cost.initial_pose(loose)
    near = set(candidates(loose, pose, fails, float(p['legal_radius'])))
    units = [i for i in sorted(ties) if i in near]
    gnd = gnd_codes(loose)

    def allowed(i, x, y, r):
        trial = list(pose)
        trial[i] = (x, y, r)
        return decap_gap(loose, trial, i, ties[i], gnd) <= tie + EPS
    return proposals(loose, pose, fails, params, rotate, units=units, allowed=allowed, tag='loose')


def read_tie(read_args):
    """--decap-tie of the cli.py read arguments (cli.py default 3.0 mm)."""
    args = list(read_args)
    for k, a in enumerate(args):
        if a == '--decap-tie':
            return float(args[k + 1])
        if a.startswith('--decap-tie='):
            return float(a.split('=', 1)[1])
    return 3.0


# ---------- score ----------

def score_key(summary):
    """Lexicographic key of a route_step score.json: (DRC part, gate part, length, vias). Lower is better."""
    rec = summary.get('run') or {}
    if rec.get('status') not in ('PASS', 'FAIL'):
        return (NO_RESULT, NO_RESULT, math.inf, math.inf)
    drc = rec['drc_errors'] + rec['unconnected'] + rec['parity']
    gate = NO_RESULT
    if drc == 0 and summary.get('gate_metrics') is not None:
        total, complete = iotroute_step.gate_part(summary['gate_metrics'])
        gate = total if complete else NO_RESULT
    return (drc, gate, float(rec.get('track_length_mm') or math.inf), int(rec.get('vias') or 0))


def better(a, b):
    return tuple(a) < tuple(b)


def passed(key):
    return key[0] == 0 and key[1] == 0


# ---------- board files (pcbnew) ----------

def copy_sidecars(src_pcb, dst_pcb):
    """Project files of src next to dst, named after dst. Called after every pcbnew save (it rewrites the .kicad_pro)."""
    sd, ss = os.path.dirname(os.path.abspath(src_pcb)), os.path.splitext(os.path.basename(src_pcb))[0]
    dd, ds = os.path.dirname(os.path.abspath(dst_pcb)), os.path.splitext(os.path.basename(dst_pcb))[0]
    for ext in SIDECARS:
        if os.path.isfile(os.path.join(sd, ss + ext)):
            shutil.copyfile(os.path.join(sd, ss + ext), os.path.join(dd, ds + ext))
    for t in TABLES:
        if os.path.isfile(os.path.join(sd, t)):
            shutil.copyfile(os.path.join(sd, t), os.path.join(dd, t))


def rip_region(pcb, points, radius, nets):
    """Delete the unlocked copper clusters (kicad_io._clusters) with an end point within `radius` of a point or
    on one of `nets`; save in place. -> number of items removed."""
    import pcbnew
    from placer import kicad_io
    board = pcbnew.LoadBoard(pcb)
    free = [t for t in board.GetTracks() if not t.IsLocked()]
    find = kicad_io._clusters(free)
    hit = set()
    for k, t in enumerate(free):
        if t.GetNetname() in nets:
            hit.add(find(k))
            continue
        for e in kicad_io._ends(t):
            x, y = pcbnew.ToMM(e.x), pcbnew.ToMM(e.y)
            if any(math.hypot(x - px, y - py) <= radius for px, py in points):
                hit.add(find(k))
                break
    gone = [t for k, t in enumerate(free) if find(k) in hit]
    for t in gone:
        board.Delete(t)
    pcbnew.SaveBoard(pcb, board)
    return len(gone)


def read_problem(place, out, read_args=()):
    from placer import cli
    cli.main(['read', place, '-o', out] + list(read_args))
    return load(out)


def write_pose(src, pr, pose, out, sidecar_src):
    from placer import kicad_io
    os.makedirs(os.path.dirname(out), exist_ok=True)
    info = kicad_io.write_board(src, pr, [tuple(q) for q in pose], out)
    copy_sidecars(sidecar_src, out)
    return info


def prepare(src, out, board, keep='lock-nets'):
    """Placement board, all footprints unlocked, sidecars copied. keep lock-nets: only the lock-net copper
    (pairs + DRU via_count 0 nets, as run.py --lock-from), locked. keep locked: also every other locked track and
    via of SRC (the hand geometry, for example the GND stubs of fixed pads)."""
    import pcbnew
    if keep not in ('lock-nets', 'locked'):
        raise ValueError('keep must be lock-nets or locked')
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    sys.path.insert(0, os.path.join(REPO, 'tools', 'router'))
    import run as router_run
    bdir, _ = router_run.board_project(board)
    work = out + '.prepare'
    os.makedirs(work, exist_ok=True)
    model = os.path.join(work, 'lock-model.json')
    subprocess.run([sys.executable, os.path.join(REPO, 'tools', 'router', 'model.py'), bdir, '--pcb', src,
                    '--out', model], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    nets = router_run.lock_nets(load(model))
    info = router_run.make_locked_input(src, src, nets, out)
    b = pcbnew.LoadBoard(out)
    if keep == 'locked':
        s = pcbnew.LoadBoard(src)
        bn = b.GetNetsByName()
        extra = 0
        for t in s.GetTracks():
            if t.IsLocked() and t.GetNetname() not in nets:
                c = t.Duplicate()
                b.Add(c)
                c.SetNet(bn[t.GetNetname()])
                c.SetLocked(True)
                extra += 1
        info['kept_locked'] = extra
    for fp in b.GetFootprints():
        fp.SetLocked(False)
    pcbnew.SaveBoard(out, b)
    copy_sidecars(src, out)
    return info


# ---------- the loop ----------

def route(path, d, board, gate, iters, extra=()):
    os.makedirs(d, exist_ok=True)
    iotroute_step.route_step(path, d, board, gate, iters, extra)
    summary = load(os.path.join(d, 'route-0', 'score.json'))
    routed = os.path.join(d, 'route-0', os.path.basename(path))
    return summary, routed


def drc_of(routed):
    return load(routed + '.iotroute/drc.json')


def run(board, place, routed, outdir, mode='reuse', max_routes=8, per_round=4, iters=80, seed=1, rotate=True,
        read_args=(), gate=None, log=print, route_fn=None, read_fn=None, write_fn=None, rip_fn=None,
        start_summary=None, decaps=True, escape_moves=True, rank_mode='term'):
    """Repair loop (see the module text). The effects are injectable for tests. -> record dict."""
    outdir = os.path.abspath(outdir)   # the gate runs in its snapshot folder: evidence paths must be absolute
    os.makedirs(outdir, exist_ok=True)
    if rank_mode == 'hot':  # the next rounds rank on the map of the repair's own routes: run.py writes it (opt-in)
        os.environ['IOTROUTE_CONGESTION'] = '1'
    route_fn = route_fn or route
    read_fn = read_fn or read_problem
    write_fn = write_fn or write_pose
    rip_fn = rip_fn or rip_region
    gate = gate or iotroute_step.GateWorkspace(outdir, board)
    p = anneal.params_all({})
    radius = float(p['legal_radius'])
    name = os.path.basename(place)
    state = dict(place=os.path.abspath(place), routed=os.path.abspath(routed), moves=[])
    if start_summary is None:
        sp = os.path.join(os.path.dirname(os.path.abspath(routed)), 'score.json')
        start_summary = load(sp) if os.path.isfile(sp) else None
    if start_summary is None:   # no score of the start: measure it (DRC from run.py, gate when DRC part is 0)
        start_summary = dict(run=load(routed + '.iotroute/result.json'), gate_metrics=None)
        if score_key(start_summary)[0] == 0:
            start_summary['gate_metrics'] = gate.run(routed, os.path.join(outdir, 'start-gate'),
                                                     os.path.join(outdir, 'start-gate.log'))
    state['key'] = list(score_key(start_summary))
    notes = routed + '.iotroute/route.json'
    walled = walled_pads(load(notes).get('notes')) if os.path.isfile(notes) else set()
    rec = dict(schema='iot-lab.placer-repair.v1', board=board, mode=mode, seed=seed, rotate=rotate, rank=rank_mode,
               legal_step=p['legal_step'], legal_radius=radius, start=dict(state), attempts=[], rounds=[],
               qualified=False)
    routes, rnd = 0, 0

    def save(stop):
        rec.update(stop=stop, best=dict(state), passed=passed(state['key']))
        dump(rec, os.path.join(outdir, 'repair.json'))
        return rec

    log('REPAIR start key %s' % (state['key'],))
    while True:
        if passed(state['key']):
            return save('score 0: DRC 0/0/0 and gate at target')
        fails = parse_failures(drc_of(state['routed']))
        if not fails:
            return save('no located failure (DRC part 0, gate part %s): the gate findings have no location'
                        % state['key'][1])
        if routes >= max_routes:
            return save('route cap %d reached' % max_routes)
        pr = read_fn(state['place'], os.path.join(outdir, 'round-%d-prob.json' % rnd), read_args)
        fails, input_faults = split_walled(fails, walled, pr)
        if input_faults:
            rec.setdefault('input_faults', input_faults)
        if not fails:
            return save('the remaining failures are walled in by fixed input copper (router note on the full start '
                        'route; the pad unit is fixed): %s' % '; '.join(
                            '%s %s' % (f['type'], ','.join('%s.%s' % (it['ref'], it['pad']) for it in f['items']
                                                           if it['ref'])) for f in input_faults))
        pose = cost.initial_pose(pr)
        props = proposals(pr, pose, fails, rotate=rotate)
        probs = dict(main=pr)
        tie = read_tie(read_args)
        if decaps and pr.get('decaps') and tie > 0:
            probs['loose'] = read_fn(state['place'], os.path.join(outdir, 'round-%d-loose.json' % rnd),
                                     list(read_args) + ['--decap-tie', '0'])
            props = interleave(props + decap_slides(pr, probs['loose'], fails, tie, rotate=rotate))
        esc = []
        if escape_moves:
            esc = escape_proposals(pr, pose, fails, rotate=rotate)
            if 'loose' in probs:
                esc = interleave(esc + escape_loose(pr, probs['loose'], fails, tie, rotate=rotate))
        props = alternate(esc, props)
        if rank_mode == 'hot':
            props = hot_order(props, probs, state['routed'])
        rinfo = dict(round=rnd, failures=fails, candidates=[pr['units'][i]['name'] for i in
                     candidates(pr, pose, fails, radius)], proposals=len(props),
                     escape=[dict(name=c['name'], x=c['x'], y=c['y'], r=c['r'], term=c['term'], term0=c['term0'])
                             for c in esc[:per_round]])
        rec['rounds'].append(rinfo)
        log('REPAIR round %d failures %d candidates %s proposals %d' % (
            rnd, len(fails), ','.join(rinfo['candidates']), len(props)))
        if not props:
            return save('round %d: no legal move of a candidate unit decreases the failure term' % rnd)
        accepted = None
        for k, c in enumerate(props[:per_round]):
            if routes >= max_routes:
                break
            d = os.path.join(outdir, 'r%d-p%d' % (rnd, k))
            q = probs[c.get('problem', 'main')]
            trial = cost.initial_pose(q)
            trial[c['unit']] = (c['x'], c['y'], c['r'])
            new_place = os.path.join(d, 'place', name)
            write_fn(state['place'], q, trial, new_place, state['place'])
            if mode == 'local':
                route_in = os.path.join(d, 'in', name)
                write_fn(state['routed'], q, trial, route_in, state['place'])
                ripped = rip_fn(route_in, failure_points(fails), radius, set(failure_nets(fails)))
                copy_sidecars(state['place'], route_in)
            else:
                route_in, ripped = new_place, 0
            if mode == 'reuse':
                # partial re-route from the present candidate's route (run.py --reuse, no full-route fallback: a
                # proposal that the reuse route does not repair is rejected like any other)
                summary, out = route_fn(route_in, d, board, gate, iters,
                                        extra=('--reuse', state['routed'], '--reuse-fallback', 'none'))
            else:
                summary, out = route_fn(route_in, d, board, gate, iters)
            routes += 1
            key = list(score_key(summary))
            att = dict(round=rnd, index=k, move=c, ripped=ripped, key=key, routed=out, place=new_place,
                       accepted=better(key, state['key']))
            rec['attempts'].append(att)
            log('REPAIR r%d p%d %s%s -> (%.2f, %.2f, %d) key %s %s' % (
                rnd, k, c['name'], ' (decap slide)' if c.get('problem') == 'loose' else
                ' (escape)' if c.get('kind') == 'escape' else '', c['x'], c['y'], c['r'],
                key, 'ACCEPT' if att['accepted'] else 'reject'))
            if att['accepted']:
                accepted = att
                break
        if accepted is None:
            return save('round %d: no routed proposal is strictly better than key %s (%d routed)'
                        % (rnd, state['key'], len([a for a in rec['attempts'] if a['round'] == rnd])))
        state = dict(place=accepted['place'], routed=accepted['routed'], key=accepted['key'],
                     moves=state['moves'] + [accepted['move']])
        rnd += 1


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    a = sub.add_parser('prepare')
    a.add_argument('src')
    a.add_argument('out')
    a.add_argument('--board', required=True, help='board ID (hardware-design/boards/<ID>)')
    a.add_argument('--keep', choices=['lock-nets', 'locked'], default='lock-nets',
                   help='lock-nets: pair + crystal copper (run.py --lock-from); locked: all locked copper of SRC')
    r = sub.add_parser('run')
    r.add_argument('board', help='board ID (hardware-design/boards/<ID>)')
    r.add_argument('place', help='placement board (repair.py prepare)')
    r.add_argument('routed', help='run.py result of PLACE (with ROUTED.iotroute/)')
    r.add_argument('--outdir', required=True)
    r.add_argument('--mode', choices=['reuse', 'local', 'full'], default='reuse')
    r.add_argument('--max-routes', type=int, default=8)
    r.add_argument('--per-round', type=int, default=4)
    r.add_argument('--iters', type=int, default=80)
    r.add_argument('--seed', type=int, default=1)
    r.add_argument('--no-rotate', action='store_true')
    r.add_argument('--no-decap-slide', action='store_true', help='do not move single tied decaps')
    r.add_argument('--rank', choices=['term', 'hot'], default='term',
                   help='hot: proposals that take the most router history away from the unit pins first (congest.py)')
    r.add_argument('--read', nargs='*', default=[], help='more cli.py read arguments (use --read=--x=y form)')
    args = ap.parse_args(argv)
    if args.cmd == 'prepare':
        print(json.dumps(dict(prepare(args.src, args.out, args.board, args.keep), nets=None)))
        return 0
    if os.path.isdir(args.outdir) and os.listdir(args.outdir):
        raise SystemExit('outdir must be new or empty')
    res = run(args.board, args.place, args.routed, args.outdir, args.mode, args.max_routes, args.per_round,
              args.iters, args.seed, not args.no_rotate, args.read, decaps=not args.no_decap_slide, rank_mode=args.rank)
    print('REPAIR %s key %s moves %d stop: %s' % ('PASS' if res['passed'] else 'FAIL', res['best']['key'],
                                                  len(res['best']['moves']), res['stop']), flush=True)
    return 0 if res['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
