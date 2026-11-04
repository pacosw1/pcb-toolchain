"""Optional live telemetry for freeroute.py. Routing remains independent of the viewer."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time


def atomic_json(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value))
    os.replace(temp, path)


def prepare(board, output, work, jar):
    root = Path(__file__).resolve().parent.parent
    git = subprocess.check_output(['git', '-C', str(root), 'rev-parse', '--absolute-git-dir'], text=True).strip()
    directory = Path(git) / 'board-progress' / 'routes'
    directory.mkdir(parents=True, exist_ok=True)
    source = Path(__file__).with_name('FreeroutingLive.java')
    key = hashlib.sha256(source.read_bytes() + str(Path(jar).stat().st_mtime_ns).encode()).hexdigest()[:16]
    classes = directory / ('classes-' + key)
    classes.mkdir(exist_ok=True)
    if not (classes / 'FreeroutingLive.class').exists():
        compiler = shutil.which('javac') or '/opt/homebrew/opt/openjdk/bin/javac'
        subprocess.run([compiler, '-cp', jar, '-d', str(classes), str(source)], check=True, capture_output=True, timeout=30)
    path = directory / (Path(work).name + '.json')
    data = dict(board=str(Path(board).resolve()), output=str(Path(output).resolve()), work=work,
                base=str(Path(work) / 'source.kicad_pcb'),
                preview=str(Path(work) / 'live.ses'), log=str(Path(work) / 'freerouting.log'),
                pid=os.getpid(), started=time.time(), status='routing')
    atomic_json(path, data)
    return ["java", "-cp", str(classes) + os.pathsep + jar, "FreeroutingLive", data['preview']], path, data


def finish(path, data, status):
    try:
        _finish(path, data, status)
    except OSError:
        # Optional monitoring must not turn a successful routing job into a failure.
        pass


def _finish(path, data, status):
    final = Path(data['work']) / 'board.ses'
    if status == 'candidate saved' and final.exists():
        target = Path(data['preview'])
        temp = target.with_suffix('.tmp')
        temp.write_bytes(final.read_bytes())
        os.replace(temp, target)
    data.update(status=status, finished=time.time())
    atomic_json(path, data)
