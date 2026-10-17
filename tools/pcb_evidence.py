"""Bind terminal receipts to the original run inputs and evidence files."""
import json
from pathlib import Path
from pcb_workflow import sha


def evidence_files(folder):
    folder = Path(folder).resolve()
    paths = [folder / 'run.json']
    for name in ('operation', 'gate'):
        paths.extend(p for p in (folder / name).rglob('*') if p.is_file())
    result = folder / 'operation/result.json'
    if result.exists():
        operation = json.loads(result.read_text())
        candidate = operation.get('candidate')
        if candidate:
            p = Path(candidate).resolve()
            if not p.is_relative_to((folder / 'workspace').resolve()):
                raise ValueError('candidate escapes its isolated workspace')
            paths.append(p)
        directory = operation.get('artifact_directory')
        if directory and Path(directory).exists():
            directory = Path(directory).resolve()
            if directory != (folder / 'candidate').resolve():
                raise ValueError('release artifacts escape their run candidate')
            for p in directory.rglob('*'):
                if p.is_symlink():
                    raise ValueError('release artifact symlinks cannot be sealed')
                if p.is_file():
                    paths.append(p)
    return {str(p.relative_to(folder)): sha(p) for p in paths}


def verify(folder):
    folder = Path(folder).resolve()
    result = json.loads((folder / 'result.json').read_text())
    hashes = result.get('evidence_sha256')
    if not isinstance(hashes, dict) or 'run.json' not in hashes:
        raise ValueError('terminal receipt does not bind its evidence; create a new run')
    for name, digest in hashes.items():
        path = (folder / name).resolve()
        if not path.is_relative_to(folder) or not path.is_file() or sha(path) != digest:
            raise ValueError('verified run evidence changed: ' + name)
    if result.get('status') not in ('passed', 'failed') or not result.get('cleanup', {}).get('complete'):
        raise ValueError('run did not finish with confirmed process cleanup')
    return result
