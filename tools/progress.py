#!/usr/bin/env python3
"""Live board dashboard; standard library only."""
import argparse
import csv
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time

import project_root  # noqa: E402  (project root: --root/IOT_LAB/cwd; tools/project_root.py)
ROOT = project_root.root().resolve()
BOARDS = ('BACKUP-POWER', 'BASE-PWR', 'INPUT-4D2A')
LOG = ROOT / 'hardware-design/reports/progress-log.csv'
CLI = shutil.which('kicad-cli') or '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'


def command(args):
    return subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=10).stdout.strip()


def state_dir():
    path = Path(command(['git', 'rev-parse', '--absolute-git-dir'])) / 'board-progress'
    path.mkdir(exist_ok=True)
    return path


def age(seconds):
    n = max(0, int(seconds))
    return f'{n}s' if n < 60 else f'{n // 60}m' if n < 3600 else f'{n // 3600}h'


def fingerprint(pcb):
    digest = hashlib.sha256()
    for p in sorted(pcb.parent.iterdir()):
        if p.suffix in ('.kicad_pcb', '.kicad_sch', '.kicad_pro', '.kicad_dru'):
            digest.update(p.name.encode())
            digest.update(p.read_bytes())
    return digest.hexdigest()


def history():
    rows = {b: [] for b in BOARDS}
    try:
        with LOG.open() as f:
            for row in csv.DictReader(f):
                try:
                    item = dict(time=dt.datetime.strptime(row['time'], '%Y-%m-%d %H:%M:%S').timestamp(),
                                counts=tuple(int(row[k]) for k in ('unconnected', 'errors', 'parity')))
                    if row['board'] in rows:
                        rows[row['board']].append(item)
                except (ValueError, KeyError, TypeError):
                    continue
    except FileNotFoundError:
        pass
    return rows


def append_result(board, counts):
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open('a+') as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.seek(0, 2)
        writer = csv.writer(f)
        if f.tell() == 0:
            writer.writerow(('time', 'board', 'unconnected', 'errors', 'parity'))
        writer.writerow((dt.datetime.now().strftime('%Y-%m-%d %H:%M:%S'), board, *counts))


def check_board(pcb):
    before = fingerprint(pcb)
    with tempfile.TemporaryDirectory(prefix='board-progress-') as tmp:
        project = Path(tmp) / pcb.parent.name
        shutil.copytree(pcb.parent, project, ignore=shutil.ignore_patterns('*.lck', '*-backups', '.claude', '*.step', '*.wrl'))
        if fingerprint(project / pcb.name) != before:
            raise ValueError('Files changed while copying; retry next check')
        report = Path(tmp) / 'drc.json'
        run = subprocess.run([CLI, 'pcb', 'drc', '--schematic-parity', '--refill-zones', '--format', 'json',
                              '-o', str(report), str(project / pcb.name)], capture_output=True, text=True, timeout=90)
        if run.returncode not in (0, 5) or not report.exists():
            raise ValueError(f'DRC failed (exit {run.returncode}); check kicad-cli')
        data = json.loads(report.read_text())
        counts = (len(data['unconnected_items']), sum(v['severity'] == 'error' for v in data['violations']), len(data['schematic_parity']))
        return dict(counts=counts, time=time.time(), fingerprint=before)


def observed_activity(processes, board):
    found = []
    for line in processes:
        if board.lower() not in line.lower():
            continue
        if 'freeroute.py' in line or ('java' in line and 'freerouting' in line):
            found.append('Routing process observed')
        elif 'kicad-cli' in line and ' pcb drc ' in line and 'board-progress-' not in line:
            found.append('DRC process observed')
        elif 'pcbtool.py' in line:
            found.append('PCB tool process observed')
    return ', '.join(dict.fromkeys(found))


class Dashboard:
    def __init__(self, interval, cached=False):
        self.interval, self.cached = interval, cached
        self.directory = state_dir()
        self.results, self.errors = {}, {}
        self.checking = None
        self.next_check = time.time()
        self.stop, self.refresh = threading.Event(), threading.Event()
        self.lock = threading.Lock()
        self.pcbs = {b: next(iter(sorted((ROOT / 'hardware-design/boards' / b / 'cad').glob(f'*/{b}.kicad_pcb'))), None) for b in BOARDS}

    def sweep(self):
        for b, pcb in self.pcbs.items():
            if self.stop.is_set():
                break
            with self.lock:
                self.checking = b
            try:
                if pcb is None:
                    raise ValueError('Board file not found')
                result = check_board(pcb)
                append_result(b, result['counts'])
                with self.lock:
                    self.results[b] = result
                    self.errors.pop(b, None)
            except (OSError, ValueError, KeyError, subprocess.SubprocessError) as e:
                with self.lock:
                    self.errors[b] = str(e)
        with self.lock:
            self.checking = None
            self.next_check = time.time() + self.interval

    def worker(self):
        while not self.stop.is_set():
            self.sweep()
            self.refresh.wait(self.interval)
            self.refresh.clear()

    def model(self):
        now, hist = time.time(), history()
        processes = command(['ps', '-axo', 'command=']).splitlines()
        with self.lock:
            results, errors = dict(self.results), dict(self.errors)
        rows = []
        for b, pcb in self.pcbs.items():
            folder = ROOT / 'hardware-design/boards' / b
            changed = command(['git', 'status', '--short', '--', str(folder)]).splitlines()
            dirty = bool(command(['git', 'status', '--porcelain', '--', str(pcb)])) if pcb else False
            commits = command(['git', 'log', '-3', '--format=%ct|%h %s', '--', str(folder)]).splitlines()
            commits = [f'{age(now - int(x.split("|", 1)[0]))} ago / {x.split("|", 1)[1]}' for x in commits]
            latest = results.get(b) or (hist[b][-1] if hist[b] else None)
            freshness = 'No DRC result yet'
            if latest:
                freshness = f"DRC {age(now - latest['time'])} ago"
                if 'fingerprint' not in latest:
                    freshness += ' / historical; file version unknown'
                elif pcb and fingerprint(pcb) != latest['fingerprint']:
                    freshness += ' / FILE CHANGED since check'
            observed = observed_activity(processes, b)
            saved = age(now - pcb.stat().st_mtime) if pcb else '?'
            activity = 'No current agent report'
            try:
                note = json.loads((self.directory / f'{b}.json').read_text())
                elapsed = now - note['time']
                activity = f"{note['agent']}: {note['task']} / {age(elapsed)} ago"
                if elapsed > 300:
                    activity = 'STALE report: ' + activity
            except (OSError, ValueError, KeyError, TypeError):
                pass
            values = [x['counts'][0] for x in hist[b][-8:]]
            trend = ' -> '.join(map(str, values)) or 'Waiting for first check'
            if len(values) > 1:
                trend += f' ({values[-1] - values[0]:+d})'
            rows.append(dict(board=b, counts=latest['counts'] if latest else ('?', '?', '?'), dirty=dirty,
                             freshness=freshness, activity=activity, observed=observed or 'No board process observed',
                             saved=saved, trend=trend, commits=commits, changed=changed, error=errors.get(b)))
        return rows

    def lines(self, rows, selected=0, detail=False):
        with self.lock:
            checking, due = self.checking, self.next_check
        status = 'History view / no DRC runs' if self.cached else ('Checking ' + checking if checking else 'Next DRC in ' + age(due - time.time()))
        lines = [('I O T   L A B   /   BOARD ACTIVITY', 1),
                 (f"{time.strftime('%H:%M:%S')}   Activity every 2s   DRC every {self.interval}s   {status}", 4), ('', 0)]
        for i, row in enumerate(rows):
            if detail and i != selected:
                continue
            u, e, p = row['counts']
            lines += [(f"{'>' if i == selected else ' '} +-- {row['board']}  [{'PCB modified' if row['dirty'] else 'PCB clean'}]", 1 if i == selected else 4),
                      (f'  |  OPEN {str(u):>4}     DRC ERRORS {str(e):>3}     PARITY {str(p):>3}', 2 if (u, e, p) == (0, 0, 0) else 3),
                      ('  |  ' + row['activity'], 0), ('  |  ' + row['observed'] + f" / PCB saved {row['saved']} ago", 4),
                      ('  |  Open connections: ' + row['trend'], 4), ('  |  ' + row['freshness'], 4)]
            if row['error']:
                lines.append(('  |  CHECK FAILED: ' + row['error'], 5))
            if detail:
                lines += [('', 0), ('RECENT COMMITS', 1)] + [(x, 0) for x in row['commits']]
                lines += [('', 0), ('CHANGED FILES', 1)] + [(x, 4) for x in row['changed'][:12]]
                lines += [('', 0), ('Report a task from the agent terminal:', 1),
                          (f"tools/progress.sh --report {row['board']} --agent NAME --task 'Routing ...'", 4)]
            lines.append(('', 0))
        lines += [('Observed activity is not agent intent. Reports become stale after 5 minutes.', 4)]
        return lines



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--watch', action='store_true')
    parser.add_argument('--interval', type=int, default=120)
    parser.add_argument('--cached', action='store_true', help='Read history without running DRC')
    parser.add_argument('--report', choices=sorted(p.name for p in (ROOT / 'hardware-design/boards').iterdir() if p.is_dir()))
    parser.add_argument('--agent', default='agent')
    parser.add_argument('--task')
    parser.add_argument('--view', choices=('pcb', 'sch', '3d', 'route'), help='Focus this view in the live visual stage')
    parser.add_argument('--stage', action='store_true', help='Open the native terminal visual stage (alias for --watch)')
    parser.add_argument('--image-protocol', choices=('auto', 'tgp', 'sixel', 'halfcell'), default='auto')
    parser.add_argument('--color', action='store_true', help='Use color even when NO_COLOR is set')
    args = parser.parse_args()
    if args.stage:
        args.watch = True
    if args.color:
        os.environ.pop('NO_COLOR', None)
    if args.interval < 10:
        parser.error('--interval must be at least 10 seconds')
    if args.report:
        if not args.task:
            parser.error('--report requires --task')
        target = state_dir() / f'{args.report}.json'
        with tempfile.NamedTemporaryFile(mode='w', dir=target.parent, delete=False) as f:
            json.dump(dict(time=time.time(), agent=args.agent[:60], task=args.task[:240], view=args.view), f)
        os.replace(f.name, target)
        print(f'Activity updated for {args.report}')
        return
    dashboard = Dashboard(args.interval, args.cached)
    with (dashboard.directory / 'sampler.lock').open('w') as lock:
        if not args.cached:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                parser.exit(1, 'A dashboard is already checking. Use --cached --watch for another view.\n')
        worker = None
        try:
            if args.watch:
                if not args.cached:
                    worker = threading.Thread(target=dashboard.worker, daemon=True)
                    worker.start()
                from progress_tui import Workbench
                Workbench(dashboard, image_protocol=args.image_protocol).run()
            else:
                if not args.cached:
                    dashboard.sweep()
                print('\n'.join(line for line, _ in dashboard.lines(dashboard.model())))
        except KeyboardInterrupt:
            pass
        finally:
            dashboard.stop.set()
            dashboard.refresh.set()
            if worker and worker.is_alive():
                print('Finishing the current DRC check before exiting...', flush=True)
                worker.join()


if __name__ == '__main__':
    main()
