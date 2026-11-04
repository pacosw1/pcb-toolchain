#!/usr/bin/env python3
"""Live progress of a routing job (D-126, user direction 2026-10-11): OUTDIR/progress.jsonl, standard library only.

One line per event: {"t": ISO time, "elapsed_s": since the job start, "stage": name, "pass": autorouter pass or null,
"open": open connections of that pass or null, "vias": null until the board is imported, "best_open": lowest open count
so far, "eta_s": seconds to 0 open from the slope of the recent passes (null when not estimable)}.
Writers: tools/fastroute_job.py (stage start/end: preflight, plane-vias, route, import, drc, triage; one line per
Fastroute "Auto-routing pass #N ... (K unrouted" log line), tools/route_status.py --mark for the shell stages (gate,
render, fab). Reader: tools/route_status.py OUTDIR [--follow].
"""
import datetime as dt
import json
import os
import re
import time

PASS = re.compile(r'Auto-routing pass #(\d+) was completed in ([\d.]+) seconds .*?\((\d+) unrouted')
WINDOW = 5


def parse_pass(line):
    """(pass_no, open, seconds) of a Fastroute pass line, else None."""
    m = PASS.search(line)
    return (int(m.group(1)), int(m.group(3)), float(m.group(2))) if m else None


def eta(history, window=WINDOW):
    """Seconds to 0 open from the least-squares slope of the last `window` (elapsed_s, open) points; None when fewer
    than 2 points, the slope is not negative, or the open count is 0."""
    pts = [(t, n) for t, n in history][-window:]
    if len(pts) < 2 or pts[-1][1] == 0:
        return None if pts and pts[-1][1] != 0 else (0.0 if pts else None)
    mt = sum(t for t, _ in pts) / len(pts)
    mn = sum(n for _, n in pts) / len(pts)
    den = sum((t - mt) ** 2 for t, _ in pts)
    if den <= 0:
        return None
    slope = sum((t - mt) * (n - mn) for t, n in pts) / den
    if slope >= 0:
        return None
    return round(pts[-1][1] / -slope, 1)


class Progress:
    def __init__(self, path, t0=None):
        self.path = path
        self.t0 = t0 if t0 is not None else time.time()
        self.best = None
        self.vias = None
        self.history = []

    def write(self, stage, pass_no=None, open_=None, vias=None, eta_s=None):
        if vias is not None:
            self.vias = vias
        if open_ is not None:
            self.best = open_ if self.best is None else min(self.best, open_)
        row = dict(t=dt.datetime.now().isoformat(timespec='seconds'), t0=round(self.t0, 1), elapsed_s=round(time.time() - self.t0, 1),
                   stage=stage, **{'pass': pass_no}, open=open_, vias=self.vias, best_open=self.best, eta_s=eta_s)
        with open(self.path, 'a') as f:
            f.write(json.dumps(row) + '\n')
        return row

    def router_pass(self, pass_no, open_, stage='route'):
        self.history.append((time.time() - self.t0, open_))
        return self.write(stage, pass_no, open_, eta_s=eta(self.history))


def last(path):
    try:
        rows = [l for l in open(path).read().splitlines() if l.strip()]
    except OSError:
        return None
    for i, r in enumerate(reversed(rows)):
        try:
            return json.loads(r)
        except ValueError:
            if i:          # only the last line may be an append in progress; an earlier bad line is corruption
                raise
    return None


def line(row):
    if not row:
        return 'no progress yet'
    f = lambda v: '-' if v is None else v
    return f"{row['stage']} {row['elapsed_s']}s open={f(row['open'])} best={f(row['best_open'])} vias={f(row['vias'])} eta={f(row['eta_s'])}"
