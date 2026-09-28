"""Proof benchmarks (pure parts): Spearman rank correlation and seeded scrambled placements.

A. Proxy correlation: proxy cost vs median Freerouting unrouted over many placements.
B. Known-good recovery: original vs scrambled vs placer-from-scrambled on boards that route fully.
The Hetzner jobs are run by cli.py (scramble, run) and fr_job.sh; this module holds the logic only.
"""
import math
import random


def _ranks(v):
    order = sorted(range(len(v)), key=lambda i: v[i])
    r = [0.0] * len(v)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
            j += 1
        for k in range(i, j + 1):
            r[order[k]] = (i + j) / 2 + 1
        i = j + 1
    return r


def spearman(xs, ys):
    """Pearson correlation of the ranks (ties get the average rank)."""
    a, b = _ranks(xs), _ranks(ys)
    ma, mb = sum(a) / len(a), sum(b) / len(b)
    cov = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    sa = math.sqrt(sum((x - ma) ** 2 for x in a))
    sb = math.sqrt(sum((y - mb) ** 2 for y in b))
    return cov / (sa * sb)


def scramble(pr, seed, sigma=None):
    """Seeded pose: fixed units stay; movable units move by a normal step of `sigma` mm from their place
    (sigma None: uniform over the board), clipped so the unit stays inside the edge clearance; random turn
    when sigma is None. The result is not legal: legalize it before writing."""
    rng = random.Random(seed)
    xs = [p[0] for p in pr['board']['outline']]
    ys = [p[1] for p in pr['board']['outline']]
    e = pr['board'].get('edge_clearance', 0.0)
    box = pr.get('move_box') or [min(xs), min(ys), max(xs), max(ys)]
    pose = []
    for u in pr['units']:
        if u['fixed']:
            pose.append((u['x'], u['y'], 0))
            continue
        rad = max(max(abs(v) for v in r[:4]) for r in u['rects']) if u['rects'] else 0.0
        lo_x, hi_x = max(box[0], min(xs) + e + rad), min(box[2], max(xs) - e - rad)
        lo_y, hi_y = max(box[1], min(ys) + e + rad), min(box[3], max(ys) - e - rad)
        if sigma is None:
            x, y, r = rng.uniform(lo_x, hi_x), rng.uniform(lo_y, hi_y), rng.randrange(4)
        else:
            x, y, r = u['x'] + rng.gauss(0, sigma), u['y'] + rng.gauss(0, sigma), 0
        pose.append((min(max(x, lo_x), hi_x), min(max(y, lo_y), hi_y), r))
    return pose



def scatter(pr, seed):
    """Copy of the problem whose movable units start at seeded uniform places inside the board (a search start
    for parts staged outside the outline). Write the result against the original problem."""
    import copy
    q = copy.deepcopy(pr)
    for u, (x, y, _) in zip(q['units'], scramble(pr, seed)):
        u['x'], u['y'] = x, y
    return q


def table(rows):
    """rows: [(tag, proxy cost, [unrouted per router run])] -> (markdown table, Spearman of proxy vs median).
    A row without router results is shown but not in the correlation."""
    out = ['| Placement | Proxy cost | Unrouted min / median / max |', '|---|---|---|']
    xs, ys = [], []
    for tag, c, runs in rows:
        if not runs:
            out.append('| %s | %.1f | no result |' % (tag, c))
            continue
        v = sorted(runs)
        med = v[len(v) // 2] if len(v) % 2 else (v[len(v) // 2 - 1] + v[len(v) // 2]) / 2
        out.append('| %s | %.1f | %s / %s / %s |' % (tag, c, v[0], med, v[-1]))
        xs.append(c)
        ys.append(med)
    rho = spearman(xs, ys)
    out.append('')
    out.append('Spearman (proxy cost vs median unrouted, n = %d): %.2f' % (len(xs), rho))
    return '\n'.join(out), rho


def portfolio_pick(runs):
    """Seed portfolio: runs [{'name', 'unrouted', 'errors' (one route; None = no result), 'cost' (search cost)}]
    -> the run with the fewest DRC errors (a hard fault), then the fewest unrouted, then the lower cost; None when
    no run has a route result."""
    ok = [r for r in runs if r['unrouted'] is not None]
    return min(ok, key=lambda r: (r['errors'], r['unrouted'], r['cost'])) if ok else None


def main(argv=None):
    """bench.py collect PROB OUT TAG...: proxy cost (default params) of OUT/TAG-search/res.json cand0 (TAG 'base':
    the problem pose) against the UNROUTED lines of OUT/TAG-r*.log; prints the table.
    bench.py pick NAME:RES_JSON:ROUTE_LOG...: prints (and returns) the portfolio_pick winner name, or NONE; the cost
    is cand0 of RES_JSON, the unrouted and DRC error counts the last UNROUTED line of ROUTE_LOG."""
    import argparse
    import glob
    import json
    import os
    import re
    import sys
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ['pick']:
        runs = []
        for e in argv[1:]:
            name, res, log = e.split(':')
            m = re.findall(r'^UNROUTED (\d+) SUBSET \d+ ERRORS (\d+)', open(log).read(), re.M) if os.path.exists(log) else []
            runs.append({'name': name, 'cost': json.load(open(res))['candidates'][0]['cost'],
                         'unrouted': int(m[-1][0]) if m else None, 'errors': int(m[-1][1]) if m else None})
        w = portfolio_pick(runs)
        print(w['name'] if w else 'NONE')
        return w['name'] if w else None
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from placer import cost
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['collect'])
    ap.add_argument('prob')
    ap.add_argument('out')
    ap.add_argument('tags', nargs='+')
    a = ap.parse_args(argv)
    pr = json.load(open(a.prob))
    rows = []
    for t in a.tags:
        if t == 'base':
            pose = cost.initial_pose(pr)
        else:
            pose = [tuple(p) for p in json.load(open(os.path.join(a.out, t + '-search', 'res.json')))['candidates'][0]['pose']]
        runs = []
        for log in sorted(glob.glob(os.path.join(a.out, t + '-r*.log'))):
            m = re.findall(r'^UNROUTED (\d+)', open(log).read(), re.M)
            if m:
                runs.append(int(m[-1]))
        rows.append((t, cost.total(pr, pose, {}), runs))
    print(table(rows)[0])


if __name__ == '__main__':
    main()
