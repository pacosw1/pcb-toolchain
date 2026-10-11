#!/usr/bin/env python3
"""Checkpoint snapshots of a routing job (W12): OUTDIR/snapshots/NNNN.ses + NNNN.json + NNNN.png; standard library
plus tools/board_frame.py (PIL) for the frame.

Fastroute writes "checkpoint: best board so far" to its -do SES file whenever a pass lowers the open count. A Watcher
thread looks at that file every interval_s seconds (fastroute_job --snapshot-interval-s, default 5; 0 = off) and,
when its size or mtime changed, copies it to snapshots/NNNN.ses with a sidecar NNNN.json {t, elapsed_s, pass, open,
stage} (pass and open from the last "Auto-routing pass #N ... (K unrouted" line of the router log) and renders
NNNN.png and latest.png (the live page shows latest.png). A frame that fails to render is reported once and skipped;
the job never stops for a snapshot. At the end `python3 tools/board_frame.py --mp4 OUTDIR` makes the timelapse.
"""
import datetime as dt
import json
import os
import re
import shutil
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

PASS = re.compile(r'Auto-routing pass #(\d+) was completed in [\d.]+ seconds .*?\((\d+) unrouted')


def last_pass(log_path):
    """(pass, open) of the last pass line of the router log, else (None, None)."""
    try:
        text = open(log_path, errors='replace').read()
    except OSError:
        return None, None
    m = None
    for m in PASS.finditer(text):
        pass
    return (int(m.group(1)), int(m.group(2))) if m else (None, None)


class Watcher:
    def __init__(self, ses, outdir, log_path=None, interval_s=5.0, stage='route', t0=None, dsn=None):
        self.ses, self.outdir, self.log_path = ses, outdir, log_path
        self.interval_s, self.stage, self.dsn = float(interval_s), stage, dsn
        self.t0 = t0 if t0 is not None else time.time()
        self.dir = os.path.join(outdir, 'snapshots')
        self.stop_event = threading.Event()
        self.thread = None
        self.count = 0
        self.errors = []
        self._seen = None

    def _next_index(self):
        try:
            names = [n for n in os.listdir(self.dir) if n[:4].isdigit() and n.endswith('.ses')]
        except OSError:
            names = []
        return max((int(n[:4]) for n in names), default=-1) + 1

    def take(self, force=False):
        """One snapshot if the SES changed (or force); returns the index or None."""
        try:
            st = os.stat(self.ses)
        except OSError:
            return None
        sig = (st.st_size, st.st_mtime_ns)
        if sig == self._seen and not force:
            return None
        self._seen = sig
        os.makedirs(self.dir, exist_ok=True)
        i = self._next_index()
        base = os.path.join(self.dir, f'{i:04d}')
        shutil.copy(self.ses, base + '.ses.tmp')
        os.replace(base + '.ses.tmp', base + '.ses')
        p, o = last_pass(self.log_path) if self.log_path else (None, None)
        elapsed = round(time.time() - self.t0, 1)
        side = dict(t=dt.datetime.now().isoformat(timespec='seconds'), elapsed_s=elapsed, **{'pass': p}, open=o, stage=self.stage)
        with open(base + '.json', 'w') as f:
            json.dump(side, f)
        try:
            import board_frame
            stamp = f"{self.stage}  {elapsed:.0f} s  pass {p if p is not None else '-'}  open {o if o is not None else '-'}"
            board_frame.frame(self.outdir, ses_path=base + '.ses', out=base + '.png', stamp=stamp, dsn_path=self.dsn)
            shutil.copy(base + '.png', os.path.join(self.dir, 'latest.png.tmp'))
            os.replace(os.path.join(self.dir, 'latest.png.tmp'), os.path.join(self.dir, 'latest.png'))
        except Exception as e:   # the frame is a view; the snapshot and the job go on
            if not self.errors:
                print(f'route_snapshots: frame {i:04d} not rendered: {type(e).__name__}: {e}', flush=True)
            self.errors.append(str(e))
        self.count += 1
        return i

    def _run(self):
        while not self.stop_event.wait(self.interval_s):
            try:
                self.take()
            except Exception as e:
                self.errors.append(str(e))

    def start(self):
        if self.interval_s > 0:
            self.thread = threading.Thread(target=self._run, daemon=True)
            self.thread.start()
        return self

    def stop(self):
        """Stop the thread and take the final snapshot of the SES (if it changed)."""
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=max(2.0, self.interval_s + 1))
        if self.interval_s > 0:
            try:
                self.take()
            except Exception as e:
                self.errors.append(str(e))
        return self.count
