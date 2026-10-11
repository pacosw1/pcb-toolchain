#!/usr/bin/env python3
"""One status line of a routing job from OUTDIR/progress.jsonl (tools/route_progress.py); standard library only.

  python3 tools/route_status.py OUTDIR             "<stage> <elapsed>s open=<n> best=<n> vias=<n> eta=<s or ->"
  python3 tools/route_status.py OUTDIR --follow    print each new line as it arrives (Ctrl-C to stop)
  python3 tools/route_status.py OUTDIR --mark gate [--end]   append a stage start/end event (the shell stages:
                                                   gate, render, fab) with the job's elapsed clock
"""
import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import route_progress  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('outdir')
    ap.add_argument('--follow', action='store_true')
    ap.add_argument('--mark', default='', help='append a stage event (start, or end with --end)')
    ap.add_argument('--end', action='store_true')
    a = ap.parse_args()
    path = os.path.join(a.outdir, 'progress.jsonl')
    if a.mark:
        rows = [route_progress.json.loads(l) for l in open(path) if l.strip()] if os.path.isfile(path) else []
        p = route_progress.Progress(path, t0=rows[-1]['t0'] if rows else None)
        if rows:
            p.best = rows[-1].get('best_open')
            p.vias = rows[-1].get('vias')
        print(route_progress.line(p.write(a.mark + (' end' if a.end else ' start'))))
        return 0
    print(route_progress.line(route_progress.last(path)), flush=True)
    if not a.follow:
        return 0
    seen = len(open(path).read().splitlines()) if os.path.isfile(path) else 0
    try:
        while True:
            time.sleep(1)
            if not os.path.isfile(path):
                continue
            rows = [l for l in open(path).read().splitlines() if l.strip()]
            for l in rows[seen:]:
                print(route_progress.line(route_progress.json.loads(l)), flush=True)
            seen = len(rows)
    except KeyboardInterrupt:
        return 0


if __name__ == '__main__':
    sys.exit(main())
