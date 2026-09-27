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
