#!/usr/bin/env python3
"""tools/route_progress.py: the Fastroute pass-line parser and the eta. Run: python3 tools/test-route-progress.py"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import route_progress as rp  # noqa: E402

LINE = '   11.073 INFO  Auto-routing pass #1 was completed in 8.29 seconds with score 777.00 (84 unrouted and 20 violations) (routed 179, failed 38, ripped 112).'
fails = []
if rp.parse_pass(LINE) != (1, 84, 8.29):
    fails.append(f'parse_pass: {rp.parse_pass(LINE)}')
if rp.parse_pass('   11.075 INFO  checkpoint: best board so far (84 unrouted, 20 violations)') is not None:
    fails.append('parse_pass accepted a checkpoint line')
# 10 open at t 0, 8 at t 10, 6 at t 20: 2 open per 10 s, 6 open left -> 30 s.
if rp.eta([(0, 10), (10, 8), (20, 6)]) != 30.0:
    fails.append(f'eta slope: {rp.eta([(0, 10), (10, 8), (20, 6)])}')
if rp.eta([(0, 10), (10, 10), (20, 12)]) is not None:
    fails.append('eta with a non-decreasing count must be None')
if rp.eta([(0, 10)]) is not None:
    fails.append('eta with one point must be None')
if rp.eta([(0, 3), (10, 0)]) != 0.0:
    fails.append('eta at 0 open must be 0')
# Only the last WINDOW points count: an early fast drop does not shorten the estimate.
h = [(0, 100), (10, 50)] + [(20 + 10 * i, 40 - i) for i in range(5)]
if rp.eta(h) != 360.0:
    fails.append(f'eta window: {rp.eta(h)}')
d = tempfile.mkdtemp()
p = rp.Progress(os.path.join(d, 'progress.jsonl'), t0=0)
p.write('route start')
p.router_pass(1, 30)
p.router_pass(2, 20)
row = rp.last(os.path.join(d, 'progress.jsonl'))
if row['pass'] != 2 or row['open'] != 20 or row['best_open'] != 20 or row['eta_s'] is None:
    fails.append(f'progress file: {row}')
if not rp.line(row).startswith('route ') or 'open=20 best=20 vias=- eta=' not in rp.line(row):
    fails.append(f'status line: {rp.line(row)}')
for f in fails:
    print('  ' + f)
print('FAIL route_progress: %d' % len(fails) if fails else 'PASS route_progress: pass-line parser, eta slope/window, progress file, status line')
sys.exit(1 if fails else 0)
