#!/usr/bin/env python3
"""ripup: rip-up and re-route search for a net that `pcbtool.py suggest` cannot route because other nets block it.

  $PY tools/ripup.py BOARD NET [--width 4] [--depth 2] [--jobs 8] [--specs DIR] [--keep NET ...] [--out result.json]

1. Blockers: the nets whose tracks and vias `suggest` names at its closest reach, then the nets with the most
   track length in a band (--band mm half width) along pad A -> closest reach -> pad B.
2. Beam search: a state is a set of ripped nets (depth <= --depth). A state is evaluated on a temp copy of the
   project folder: unroute the ripped nets, route NET with suggest + connect + stitch, then re-route each ripped net.
   A suggest line is used only with <= --max-vias vias and room for a ground via near each via (pcbtool stitch).
   RP-001 is strict only for the fast nets of --specs/rp001-fast-nets.json (lead decision D6; no file = all strict):
   a slow net gets a best-effort stitch, and its new RP-001 finding is allowed and listed as an exemption to add.
   A state with a net left open is expanded with one more blocker (the blockers of that net first).
   The search stops at the first depth that has a clean state: fewer rip-ups first.
3. Gates on each routed state against the unchanged board (hard, all must hold):
   DRC --schematic-parity --refill-zones: no error type count rises, no net more unconnected, the routed nets
   fully connected, parity 0; and no new finding (numbers ignored) in si_planes, si_pairs, pcbtool paths,
   pcbtool viapads and kicad_happy_gate (each gate runs when its spec file is in --specs).
   Soft cost of a clean state: track length + 2 mm per via + mm in another net's GND pour.
4. Output: the rip list, the connect lines of all routed nets (apply in this order after `unroute` of the
   rip list, each followed by `stitch BOARD NET`) and the gate deltas. Ground domains: --specs/reference-planes.json.
   BOARD is never written; use a copy of a live board.
Fail closed: a gate crash rejects the state; a baseline gate crash or parity > 0 exits 2.
Nets with a zone (planes) and --keep nets are never ripped.
"""
import argparse
import collections
import concurrent.futures
import fnmatch
import importlib.util
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PCBTOOL = os.path.join(HERE, 'pcbtool.py')
VIA_MM = 2.0

# gate: (spec file in --specs or None, summary regex, finding line prefixes)
GATES = {
    'si_planes': ('reference-planes.json', r'reference-plane failures', ('FAIL',)),
    'si_pairs': ('diff-pairs.json', r'^si_pairs: \d+ PASS, \d+ FAIL', ('FAIL',)),
    'paths': ('current-paths.json', r'power-path pairs below the design current', ('LOW',)),
    'viapads': (None, r'vias in SMD pads', ('FAIL',)),
    'kicad_happy': ('kicad-happy-exempt.json', r'kicad-happy findings', ('FAIL', 'STALE exempt')),
}


# ---------------------------------------------------------------- pure core (tested)
def point_seg(q, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2))
    return math.dist(q, (a[0] + t * dx, a[1] + t * dy))


def rank_blockers(items, corridor, band, skip):
    """[(net, mm)] of track/via copper within `band` mm of the corridor polyline, most first.
    items: [(net, start, end, half width)]; a via is a zero-length item and counts its diameter."""
    near = lambda q: min(point_seg(q, a, b) for a, b in zip(corridor, corridor[1:])) <= band
    got = collections.Counter()
    for net, a, b, r in items:
        if net in skip:
            continue
        L = math.dist(a, b)
        if L == 0:
            if min(point_seg(a, u, v) for u, v in zip(corridor, corridor[1:])) <= band + r:
                got[net] += 2 * r
            continue
        n = max(1, math.ceil(L / 0.05))
        got[net] += sum(L / n for j in range(n) if near((a[0] + (b[0] - a[0]) * (j + 0.5) / n, a[1] + (b[1] - a[1]) * (j + 0.5) / n)))
    return sorted(((k, round(v, 3)) for k, v in got.items() if v > 0), key=lambda t: (-t[1], t[0]))


def parse_suggest(out, code):
    """{'done', 'lines': [(len, vias, pour, connect line)], 'reach', 'pads', 'blocked_by': [net]} of a suggest run.
    RuntimeError when the output is none of: no open pair, candidates, no path."""
    r = {'done': 'unconnected: none' in out, 'lines': [], 'reach': None, 'pads': None, 'blocked_by': []}
    m = re.search(r'^pair \d+ of \d+: (\S+) -> (\S+);', out, re.M)
    if m:
        r['pads'] = (m.group(1), m.group(2))
    rows = out.splitlines()
    for i, line in enumerate(rows):
        m = re.match(r'\d+\) (?:verified )?len ([\d.]+) vias (\d+) .* pour ([\d.]+)', line)
        if m and i + 1 < len(rows):
            r['lines'].append((float(m.group(1)), int(m.group(2)), float(m.group(3)), rows[i + 1].strip()))
    m = re.search(r'no path: closest reach \(([-\d.]+), ([-\d.]+)\).*?blocked there by (.*?)\. Try', out)
    if m:
        r['reach'] = (float(m.group(1)), float(m.group(2)))
        r['blocked_by'] = [lab.split(' ', 1)[1] for lab in m.group(3).split(', ') if lab.split(' ', 1)[0] in ('track', 'via')]
    if not r['done'] and not r['lines'] and not m:
        raise RuntimeError(f'suggest exit {code}: ' + ((out.strip().splitlines() or ['no output'])[-1])[:160])
    return r


def gate_findings(gate, out, code):
    """Counter of the gate's finding lines, decimal numbers as '#'. RuntimeError on a crash: exit > 1 or no summary."""
    _, summary, prefixes = GATES[gate]
    if code not in (0, 1) or not re.search(summary, out, re.M):
        raise RuntimeError(f'{gate} exit {code}: ' + ((out.strip().splitlines() or ['no output'])[-1])[:160])
    return collections.Counter(re.sub(r'(?<![A-Za-z\d.])-?\d+\.\d+', '#', l.strip())
                               for l in out.splitlines() if l.startswith(prefixes))


def state_result(d, gates):
    """Comparable summary of a DRC report dict and the gate finding Counters."""
    net_re = re.compile(r'\[([^\]]+)\]')
    unc = collections.Counter(n for x in d['unconnected_items']
                              for n in {m.group(1) for i in x['items'] for m in [net_re.search(i['description'])] if m})
    err = collections.Counter(x['type'] for x in d['violations'] if x.get('severity') == 'error')
    return {'err': err, 'unc': unc, 'parity': len(d.get('schematic_parity', [])), 'gates': gates}


def fast_nets(specs):
    """fast(net) -> bool from <specs>/rp001-fast-nets.json {"fast": [fnmatch patterns]}: RP-001 is strict for a fast
    net (lead decision D6); no file = every net is strict (fail closed). ValueError on a bad file."""
    path = os.path.join(specs, 'rp001-fast-nets.json')
    if not os.path.exists(path):
        return lambda net: True
    pats = json.load(open(path)).get('fast')
    if not isinstance(pats, list) or not all(isinstance(q, str) for q in pats):
        raise ValueError(f'{path}: "fast" must be a list of net patterns')
    return lambda net: any(fnmatch.fnmatchcase(net, q) for q in pats)


def judge(base, cand, nets, fast=lambda net: True):
    """(ok, reason, deltas) of a routed state against the baseline. nets: the target and the ripped nets.
    A new kicad-happy RP-001 finding on a slow net (not fast) is allowed and listed in deltas['rp001_exempt']."""
    delta = {'errors': sum(cand['err'].values()) - sum(base['err'].values()),
             'unconnected': sum(cand['unc'].values()) - sum(base['unc'].values()), 'parity': cand['parity']}
    for g in base['gates']:
        if g in cand['gates']:
            delta[g] = sum(cand['gates'][g].values()) - sum(base['gates'][g].values())
    if cand['parity']:
        return False, f'parity {cand["parity"]}', delta
    for t in sorted(cand['err']):
        if cand['err'][t] > base['err'][t]:
            return False, f'DRC +{cand["err"][t] - base["err"][t]} {t}', delta
    for n in nets:
        if cand['unc'][n]:
            return False, f'{n} still unconnected ({cand["unc"][n]})', delta
    for n in sorted(cand['unc']):
        if cand['unc'][n] > base['unc'][n]:
            return False, f'{n} unconnected {base["unc"][n]} -> {cand["unc"][n]}', delta
    for g in sorted(base['gates']):
        if g not in cand['gates']:
            return False, f'{g} did not run', delta
        new = cand['gates'][g] - base['gates'][g]
        if g == 'kicad_happy':
            slow = {k: m.group(1) for k in new for m in [re.match(r'FAIL RP-001 .*: (\S+)$', k)] if m and not fast(m.group(1))}
            delta['rp001_exempt'] = sorted(set(slow.values()))
            new = collections.Counter({k: v for k, v in new.items() if k not in slow})
        if new:
            return False, f'{g} new: {next(iter(new))[:120]}', delta
    return True, '', delta


def route_cost(routes):
    """Soft cost of [(len, vias, pour)]: mm of track + VIA_MM per via + mm in another net's GND pour."""
    return sum(L + VIA_MM * v + pour for L, v, pour in routes)


def beam_search(blockers, evaluate, width, depth, pmap):
    """Best (rips, result) with the fewest rip-ups, or None; plus the log [(rips, result)].
    evaluate(rips) -> {'status': 'ok', 'cost'} | {'status': 'open', 'open', 'blocked_by'} | {'status': 'reject'}.
    Level 1 rips each of the first `width` blockers. The best `width` open states each get up to `width` children:
    one more rip, the state's own blockers first, then the target blockers. pmap runs one level (parallel)."""
    level = [(b,) for b in blockers[:width]]
    seen = {frozenset(s) for s in level}
    log = []
    for d in range(1, depth + 1):
        res = list(pmap(evaluate, level))
        log += zip(level, res)
        ok = [(r['cost'], rips, r) for rips, r in zip(level, res) if r['status'] == 'ok']
        if ok:
            c, rips, r = min(ok, key=lambda t: (t[0], t[1]))
            return (rips, r), log
        opens = sorted(((r['open'], i, rips, r) for i, (rips, r) in enumerate(zip(level, res)) if r['status'] == 'open'),
                       key=lambda t: t[:2])[:width]
        level = []
        for _, _, rips, r in opens:
            kids = 0
            for n in list(r.get('blocked_by', [])) + list(blockers):
                s = frozenset(rips + (n,))
                if kids >= width or n in rips or s in seen:
                    continue
                seen.add(s)
                level.append(rips + (n,))
                kids += 1
        if not level:
            break
    return None, log


def progress(rips, r, out=sys.stdout):
    """Print one line for an evaluated state at once (live log) and return the result unchanged."""
    print(f'state rip {"+".join(rips)}: {r["status"]} {r.get("cost", "")} {r.get("why", "")} ({r["s"]} s)', file=out, flush=True)
    return r


# ---------------------------------------------------------------- edges (subprocess, pcbnew)
def load_pcbtool():
    spec = importlib.util.spec_from_file_location('pcbtool', PCBTOOL)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def run(cmd, timeout=900):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout + r.stderr


def run_gates(board, specs, gates):
    """state_result of a board, or RuntimeError (fail closed)."""
    pt = load_pcbtool()
    out = os.path.join(os.path.dirname(board), 'ripup-drc.json')
    code, _ = run([pt.KICAD_CLI, 'pcb', 'drc', '--schematic-parity', '--refill-zones', '--format', 'json', '-o', out, board])
    d = pt.check_drc_report(code, out)
    found = {}
    for g in gates:
        spec = os.path.join(specs, GATES[g][0]) if GATES[g][0] else None
        cmd = {'si_planes': [sys.executable, os.path.join(HERE, 'si_planes.py'), board, spec],
               'si_pairs': [sys.executable, os.path.join(HERE, 'si_pairs.py'), board, spec],
               'paths': [sys.executable, PCBTOOL, 'paths', board, spec, '--limit', '100000'],
               'viapads': [sys.executable, PCBTOOL, 'viapads', board],
               'kicad_happy': ['python3', os.path.join(HERE, 'kicad_happy_gate.py'), board] +
                              (['--exempt-file', spec] if spec and os.path.exists(spec) else [])}[g]
        found[g] = gate_findings(g, *reversed(run(cmd)))
    return state_result(d, found)


def active_gates(specs):
    return [g for g, (f, _, _) in GATES.items() if f is None or g == 'kicad_happy' or os.path.exists(os.path.join(specs, f))]


def suggest(board, net, planes, sh=run):
    code, out = sh([sys.executable, PCBTOOL, 'suggest', board, net, '--k', '3', *(['--planes', planes] if planes else [])])
    return parse_suggest(out, code)


def route_net(board, net, planes, max_vias=4, max_pairs=40, sh=run, fast=lambda net: True):
    """(routed [(len, vias, pour, line)], None) when the net is fully connected, else (routed, suggest result).
    Per open pair: the first suggest line with <= max_vias vias that connects and then gets a ground stitch via
    near each via (pcbtool stitch). A line whose stitch finds no room is undone (board file restored); a slow net
    (fast(net) False) gets a best-effort stitch."""
    done = []
    keep = board + '.ripup-keep'
    for _ in range(max_pairs):
        s = suggest(board, net, planes, sh)
        if s['done']:
            return done, None
        for L, v, pour, line in s['lines']:
            if v > max_vias:
                continue
            shutil.copyfile(board, keep)
            if sh([sys.executable, PCBTOOL, 'connect', board, line])[0] != 0:
                shutil.copyfile(keep, board)
                continue
            if sh([sys.executable, PCBTOOL, 'stitch', board, net, *(['--planes', planes] if planes else []),
                   *([] if fast(net) else ['--best-effort'])])[0] != 0:
                shutil.copyfile(keep, board)
                continue
            done.append((L, v, pour, line))
            break
        else:
            s['why'] = ('no path' if not s['lines'] else
                        f'no line with <= {max_vias} vias that connects and has stitch room')
            return done, s
    return done, {'why': f'more than {max_pairs} pairs', 'blocked_by': []}


def copy_project(board, d):
    src = os.path.dirname(os.path.abspath(board))
    proj = os.path.join(d, os.path.basename(src))
    shutil.copytree(src, proj, ignore=shutil.ignore_patterns('*.lck', '*.step', '*.stp', '*.wrl', '*-backups', '*.3dshapes'))
    return os.path.join(proj, os.path.basename(board))


def make_evaluator(board, net, base, specs, gates, skip, planes, max_vias, fast):
    def evaluate(rips):
        t0 = time.time()
        with tempfile.TemporaryDirectory() as d:
            try:
                bd = copy_project(board, d)
                code, out = run([sys.executable, PCBTOOL, 'unroute', bd, *rips])
                if code:
                    raise RuntimeError('unroute: ' + out.strip()[-160:])
                routes = {}
                order = (net,) + tuple(rips)
                for i, n in enumerate(order):
                    routes[n], fail = route_net(bd, n, planes, max_vias, fast=fast)
                    if fail:
                        return {'status': 'open', 'open': len(order) - i, 'why': f'{n}: {fail["why"]}',
                                'blocked_by': [b for b in fail['blocked_by'] if b not in skip and b not in order],
                                's': round(time.time() - t0, 1)}
                cand = run_gates(bd, specs, gates)
            except Exception as e:
                return {'status': 'reject', 'why': f'{type(e).__name__}: {e}'[:200], 's': round(time.time() - t0, 1)}
        ok, why, delta = judge(base, cand, list(order), fast)
        flat = [r for n in order for r in routes[n]]
        return {'status': 'ok' if ok else 'reject', 'why': why, 'delta': delta, 's': round(time.time() - t0, 1),
                'cost': round(route_cost([r[:3] for r in flat]), 2), 'lines': [r[3] for r in flat]}
    return evaluate


def target_blockers(board, net, band, skip, planes):
    """[net] ranked: suggest's blockers at its closest reach, then the corridor band ranking."""
    s = suggest(board, net, planes)
    if s['done'] or s['lines']:
        return None, s
    pt = load_pcbtool()
    p = pt.pcb()
    b = p.LoadBoard(board)
    mm = p.ToMM
    pads = {}
    for fp in b.GetFootprints():
        for pd in fp.Pads():
            pads[f'{fp.GetReference()}.{pd.GetNumber()}'] = (mm(pd.GetPosition().x), mm(pd.GetPosition().y))
    a, c = (pads[k] for k in s['pads'])
    corridor = [a, s['reach'], c] if s['reach'] else [a, c]
    items = []
    for t in b.GetTracks():
        if isinstance(t, p.PCB_VIA):
            q = (mm(t.GetPosition().x), mm(t.GetPosition().y))
            items.append((t.GetNetname(), q, q, mm(t.GetWidth(p.F_Cu)) / 2))
        else:
            items.append((t.GetNetname(), (mm(t.GetStart().x), mm(t.GetStart().y)), (mm(t.GetEnd().x), mm(t.GetEnd().y)), mm(t.GetWidth()) / 2))
    skip |= {z.GetNetname() for z in b.Zones() if not z.GetIsRuleArea()}
    ranked = rank_blockers(items, corridor, band, skip | {net})
    out = [n for n in s['blocked_by'] if n not in skip and n != net]
    return out + [n for n, _ in ranked if n not in out], s


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('board'); ap.add_argument('net')
    ap.add_argument('--width', type=int, default=4); ap.add_argument('--depth', type=int, default=2)
    ap.add_argument('--jobs', type=int, default=8); ap.add_argument('--band', type=float, default=1.5)
    ap.add_argument('--specs', help='folder with reference-planes.json, current-paths.json, ... (default: the folder above cad/)')
    ap.add_argument('--max-vias', type=int, default=4, help='suggest lines with more vias are not used')
    ap.add_argument('--keep', nargs='*', default=[], help='nets that are never ripped')
    ap.add_argument('--out', help='write the result JSON here')
    a = ap.parse_args(argv)
    t0 = time.time()
    board = os.path.abspath(a.board)
    specs = a.specs or os.path.dirname(os.path.dirname(os.path.dirname(board)))
    gates = active_gates(specs)
    print(f'gates: DRC --schematic-parity --refill-zones, {", ".join(gates)} (specs {specs})')
    with tempfile.TemporaryDirectory() as d:
        try:
            base = run_gates(copy_project(board, d), specs, gates)
        except Exception as e:
            print(f'baseline gate failed: {type(e).__name__}: {e}')
            return 2
    if base['parity']:
        print(f'baseline parity {base["parity"]}: fix the schematic parity first')
        return 2
    skip = set(a.keep)
    planes = os.path.join(specs, 'reference-planes.json')
    planes = planes if os.path.exists(planes) else None
    blockers, s = target_blockers(board, a.net, a.band, skip, planes)
    if blockers is None:
        print(f'{a.net}: suggest routes it without a rip-up (or it is connected); use suggest --verify')
        return 1
    print(f'{a.net} {s["pads"][0]} -> {s["pads"][1]}: reach {s["reach"]}; blockers {", ".join(blockers[:2 * a.width])}', flush=True)
    ev = make_evaluator(board, a.net, base, specs, gates, skip, planes, a.max_vias, fast_nets(specs))
    with concurrent.futures.ThreadPoolExecutor(max_workers=a.jobs) as ex:
        best, log = beam_search(blockers, lambda rips: progress(rips, ev(rips)), a.width, a.depth, pmap=ex.map)
    wall = round(time.time() - t0, 1)
    res = {'board': board, 'net': a.net, 'gates': gates, 'wall_s': wall, 'states': len(log),
           'best': best and {'rips': list(best[0]), **best[1]},
           'log': [{'rips': list(k), **v} for k, v in log]}
    if a.out:
        with open(a.out, 'w') as f:
            json.dump(res, f, indent=1)
    if not best:
        print(f'no clean state in {len(log)} states, {wall} s')
        return 1
    rips, r = best
    print(f'best: rip {" ".join(rips)}; cost {r["cost"]}; deltas {r["delta"]}; {len(log)} states, {wall} s')
    print(f'apply: pcbtool.py unroute BOARD {" ".join(rips)}, then in this order: connect LINE, stitch BOARD NET:')
    for line in r['lines']:
        print(line)
    return 0


if __name__ == '__main__':
    sys.exit(main())
