#!/usr/bin/env python3
"""Read-only KiCad renderer and file watcher for the native terminal workbench."""
import collections
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import time

import progress

ROOT = progress.ROOT
PYTHON = '/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3'


def stat_key(path):
    stat = path.stat()
    return (stat.st_mtime_ns, stat.st_size)


def project_key(path, mode):
    extensions = {'.kicad_pcb', '.kicad_pro', '.kicad_dru'} if mode != 'sch' else {'.kicad_sch', '.kicad_pro'}
    files = [p for p in path.parent.iterdir() if p.suffix in extensions]
    if mode in ('3d', 'model'):
        # Refresh local model edits too, without scanning the full global KiCad library.
        for subdir in ('3dshapes',):
            files += [p for p in (path.parent / subdir).glob('*') if p.is_file()]
    return [(str(p), stat_key(p)) for p in sorted(files)]


def alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


def tail(path):
    try:
        with Path(path).open('rb') as f:
            f.seek(max(0, f.seek(0, 2) - 3000))
            return f.read().decode(errors='replace').splitlines()[-12:]
    except OSError:
        return []


class Stage:
    def __init__(self):
        self.directory = progress.state_dir()
        self.cache = self.directory / 'stage'
        self.cache.mkdir(exist_ok=True)
        self.boards = {}
        for folder in sorted((ROOT / 'hardware-design/boards').iterdir()):
            candidates = sorted((folder / 'cad').glob(f'*/{folder.name}.kicad_pcb'))
            if candidates:
                self.boards[folder.name] = candidates[0]
        self.lock = threading.RLock()
        self.jobs = {}
        self.latest = {}
        self.queue = queue.Queue(maxsize=30)
        self.events = collections.deque(maxlen=50)
        self.seen = {}
        self.state = {'boards': [], 'events': []}
        self.stop = threading.Event()
        self.processes = set()

    def routes(self):
        routes = {}
        for path in (self.directory / 'routes').glob('*.json'):
            try:
                row = json.loads(path.read_text())
                source = Path(row['board']).resolve()
                board = next((b for b, p in self.boards.items() if p.resolve() == source), None)
                if not board:
                    continue
                row['active'] = row['status'] == 'routing' and alive(row['pid'])
                if row['status'] == 'routing' and not row['active']:
                    row['status'] = 'process ended'
                row['logLines'] = tail(row['log'])
                if board not in routes or row['started'] > routes[board]['started']:
                    routes[board] = row
            except (OSError, ValueError, KeyError, TypeError):
                continue
        return routes

    def scan(self):
        routes, histories = self.routes(), progress.history()
        rows = []
        processes = progress.command(['ps', '-axo', 'command=']).splitlines()
        for board, pcb in self.boards.items():
            sch = pcb.with_suffix('.kicad_sch')
            files = [p for p in pcb.parent.iterdir() if p.suffix in ('.kicad_pcb', '.kicad_sch')]
            latest = max(files, key=lambda p: p.stat().st_mtime)
            activity_time, view = latest.stat().st_mtime, 'sch' if latest.suffix == '.kicad_sch' else 'pcb'
            activity = 'Schematic saved' if view == 'sch' else 'PCB saved'
            for path in files:
                key = stat_key(path)
                if path in self.seen and self.seen[path] != key:
                    self.events.appendleft(dict(time=time.time(), board=board, text=path.name + ' saved', view='sch' if path.suffix == '.kicad_sch' else 'pcb'))
                self.seen[path] = key
            report = None
            try:
                report = json.loads((self.directory / f'{board}.json').read_text())
                if report['time'] > activity_time and time.time() - report['time'] < 300:
                    activity_time, activity = report['time'], report['agent'] + ': ' + report['task']
                    view = report.get('view') or view
            except (OSError, ValueError, KeyError, TypeError):
                report = None
            route = routes.get(board)
            if route and route.get('finished', route['started']) > activity_time:
                activity_time = route.get('finished', route['started'])
                activity = 'Freerouting candidate in progress' if route['active'] else 'Freerouting / ' + route['status']
                view = 'route'
            samples = histories.get(board, [])
            last = samples[-1] if samples else None
            changed = progress.command(['git', 'status', '--short', '--', str(pcb), str(sch)])
            rows.append(dict(id=board, activity=activity, activityTime=activity_time, view=view,
                             dirty=bool(changed), report=report, route=route, schematic=sch.exists(),
                             observed=progress.observed_activity(processes, board),
                             counts=last['counts'] if last else None, checked=last['time'] if last else None,
                             trend=[x['counts'][0] for x in samples[-12:]],
                             saved=pcb.stat().st_mtime))
        with self.lock:
            self.state = dict(boards=rows, events=list(self.events), time=time.time())

    def watcher(self):
        while not self.stop.is_set():
            try:
                self.scan()
            except (OSError, ValueError, subprocess.SubprocessError) as exc:
                with self.lock:
                    self.state['error'] = str(exc)
            self.stop.wait(1)

    def request(self, board, mode, layers='all', side='iso', rotation=45):
        if board not in self.boards or mode not in ('pcb', 'sch', '3d', 'model', 'route'):
            raise ValueError('Unknown board or view')
        if layers not in ('all', 'front', 'back', 'inner') or side not in ('iso', 'top', 'bottom'):
            raise ValueError('Unknown display option')
        if rotation not in range(0, 360, 45):
            raise ValueError('Rotation must be a multiple of 45 degrees')
        pcb = self.boards[board]
        route = self.routes().get(board) if mode == 'route' else None
        if mode == 'route' and (not route or not Path(route['preview']).exists()):
            return dict(status='waiting', message='Waiting for a live routing snapshot. Existing runs must finish; new freeroute.py runs publish previews automatically.')
        source_key = project_key(pcb, mode)
        if route:
            source_key += [(route['preview'], stat_key(Path(route['preview'])))]
        key = hashlib.sha256(json.dumps(['terminal-v1', board, mode, layers, side, rotation, source_key]).encode()).hexdigest()[:24]
        identity = (board, mode, layers, side, rotation)
        with self.lock:
            if key in self.jobs and self.jobs[key]['status'] == 'ready' and not all(Path(a).exists() for a in self.jobs[key]['assets']):
                del self.jobs[key]
            if key in self.jobs and self.jobs[key]['status'] == 'error' and time.time() - self.jobs[key].get('failed', 0) > 10:
                del self.jobs[key]
            if key not in self.jobs:
                job = dict(status='queued', key=key, board=board, mode=mode, layers=layers, side=side,
                           route=route, sourceKey=source_key, requested=time.time(), rotation=rotation)
                self.jobs[key] = job
                try:
                    self.queue.put_nowait(job)
                except queue.Full:
                    del self.jobs[key]
                    return dict(status='waiting', message='Render queue is busy; retrying shortly')
            job = self.jobs[key]
            response = {k: job[k] for k in ('status', 'key', 'message', 'assets', 'rendered', 'sourceTime') if k in job}
            previous = self.latest.get(identity)
            if previous and previous['key'] != key and all(Path(a).exists() for a in previous['assets']):
                response['previous'] = previous
            return response

    def render(self, job):
        board, mode = job['board'], job['mode']
        pcb = self.boards[board]
        out = self.cache / job['key']
        out.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='board-stage-') as tmp:
            project = Path(tmp) / board
            project.mkdir()
            # Snapshot source files only; model paths point back to original assets.
            for source in pcb.parent.iterdir():
                if source.suffix in ('.kicad_pcb', '.kicad_sch', '.kicad_pro', '.kicad_dru') or source.name in ('sym-lib-table', 'fp-lib-table'):
                    content = source.read_text()
                    content = content.replace('${KIPRJMOD}', str(pcb.parent))
                    (project / source.name).write_text(content)
            if project_key(pcb, mode) != job['sourceKey'][:len(project_key(pcb, mode))]:
                raise ValueError('Source changed before render; retrying latest save')
            source = project / pcb.name
            if mode == 'route':
                route = job['route']
                session = Path(tmp) / 'live.ses'
                session.write_bytes(Path(route['preview']).read_bytes())
                base = Path(route.get('base', str(pcb)))
                preview = project / 'preview.kicad_pcb'
                self.run([PYTHON, str(Path(__file__).with_name('import-route-preview.py')), str(base), str(session), str(preview)], 45)
                preview.write_text(preview.read_text().replace('${KIPRJMOD}', str(pcb.parent)))
                source = preview
            if mode in ('pcb', 'route'):
                layers = dict(all='F.Cu,B.Cu,F.Silkscreen,Edge.Cuts', front='F.Cu,F.Silkscreen,Edge.Cuts',
                              back='B.Cu,B.Silkscreen,Edge.Cuts', inner='In1.Cu,In2.Cu,Edge.Cuts')[job['layers']]
                output = out / 'pcb.svg'
                self.run([progress.CLI, 'pcb', 'export', 'svg', str(source), '-o', str(output), '--layers', layers,
                          '--mode-single', '--fit-page-to-board', '--exclude-drawing-sheet'], 45)
            elif mode == 'sch':
                source = project / pcb.with_suffix('.kicad_sch').name
                if not source.exists():
                    raise ValueError('No schematic saved for this board')
                self.run([progress.CLI, 'sch', 'export', 'svg', str(source), '-o', str(out) + '/', '--exclude-drawing-sheet'], 45)
            elif mode == 'model':
                self.run([progress.CLI, 'pcb', 'export', 'glb', str(source), '-o', str(out / 'board.glb'), '--force',
                          '--subst-models', '--include-tracks', '--include-pads', '--include-silkscreen', '--include-soldermask'], 180)
            else:
                options = ['--side', 'top' if job['side'] == 'iso' else job['side']]
                if job['side'] == 'iso':
                    options += ['--rotate', f'-45,0,{job["rotation"]}']
                self.run([progress.CLI, 'pcb', 'render', str(source), '-o', str(out / 'board.png'), '--width', '1600',
                          '--height', '1100', '--quality', 'basic', '--background', 'opaque', *options], 120)
            for svg in sorted(out.glob('*.svg')):
                png = svg.with_suffix('.png')
                if shutil.which('rsvg-convert'):
                    self.run(['rsvg-convert', '--width', '1800', '--background-color', '#faf8f2' if mode == 'sch' else '#12191d',
                              '-o', str(png), str(svg)], 30)
                else:
                    self.run(['qlmanage', '-t', '-s', '1800', '-o', str(out), str(svg)], 30)
                    (out / (svg.name + '.png')).replace(png)
            assets = [str(p) for p in sorted(out.glob('*.glb' if mode == 'model' else '*.png'))]
            if not assets:
                raise ValueError('KiCad produced no view')
            return dict(status='ready', key=job['key'], assets=assets, rendered=time.time(),
                        sourceTime=max(x[1][0] for x in job['sourceKey']) / 1e9)

    def run(self, args, timeout):
        if self.stop.is_set():
            raise ValueError('Renderer stopped')
        process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        with self.lock:
            self.processes.add(process)
        try:
            stdout, stderr = process.communicate(timeout=timeout)
            if process.returncode:
                raise ValueError((stderr or stdout or f'KiCad exited {process.returncode}')[-1000:])
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise
        finally:
            with self.lock:
                self.processes.discard(process)

    def close(self):
        self.stop.set()
        with self.lock:
            processes = list(self.processes)
        for process in processes:
            if process.poll() is None:
                process.terminate()
        for process in processes:
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

    def renderer(self):
        while not self.stop.is_set():
            try:
                job = self.queue.get(timeout=1)
            except queue.Empty:
                continue
            with self.lock:
                job['status'] = 'rendering'
            try:
                result = self.render(job)
                with self.lock:
                    job.update(result)
                    self.latest[(job['board'], job['mode'], job['layers'], job['side'], job['rotation'])] = result
            except (OSError, ValueError, subprocess.SubprocessError) as exc:
                with self.lock:
                    job.update(status='error', message=str(exc), failed=time.time())
            finally:
                self.queue.task_done()
                self.prune_cache()

    def prune_cache(self):
        # Generated images/models only; never touch CAD sources or routing work files.
        with self.lock:
            protected = {k for k, j in self.jobs.items() if j['status'] in ('queued', 'rendering')}
            folders = sorted((p for p in self.cache.iterdir() if p.is_dir() and re.fullmatch('[0-9a-f]{24}', p.name)),
                             key=lambda p: p.stat().st_mtime, reverse=True)
            for folder in folders[80:]:
                if folder.name not in protected:
                    shutil.rmtree(folder, ignore_errors=True)
                    self.jobs.pop(folder.name, None)
            for key in list(self.jobs):
                if len(self.jobs) <= 200:
                    break
                if key not in protected:
                    del self.jobs[key]
