"""The one kicad-cli wrapper. Every call of kicad-cli in the engine goes through this module.

Executable: env PCBSTUDIO_KICAD_CLI, then `kicad-cli` on PATH, then the macOS KiCad app. Each run has a timeout;
a failure raises KiCadCliError with the exit code and the end of the log.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

MAC_APP = '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'
DEFAULT_TIMEOUT_S = 600.0


class KiCadCliError(RuntimeError):
    def __init__(self, msg: str, returncode: int | None = None, log: str = ''):
        super().__init__(msg + (f':\n{log[-800:]}' if log else ''))
        self.returncode, self.log = returncode, log


@dataclass
class Result:
    args: list[str]
    returncode: int
    log: str                      # stdout and stderr, merged


def find() -> str | None:
    env = os.environ.get('PCBSTUDIO_KICAD_CLI')
    if env:
        return env if Path(env).is_file() else None
    return shutil.which('kicad-cli') or (MAC_APP if Path(MAC_APP).is_file() else None)


def executable() -> str:
    exe = find()
    if not exe:
        raise KiCadCliError('kicad-cli not found (set PCBSTUDIO_KICAD_CLI, add it to PATH or install KiCad)')
    return exe


@lru_cache(maxsize=4)
def _version(exe: str) -> str | None:
    try:
        r = subprocess.run([exe, 'version'], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout.strip() or None if r.returncode == 0 else None


def version() -> str | None:
    """kicad-cli version text (e.g. '10.0.6'), None when it is missing or does not answer."""
    exe = find()
    return _version(exe) if exe else None


def run(args: list[str], *, timeout_s: float = DEFAULT_TIMEOUT_S, cwd: str | Path | None = None,
        check: bool = True) -> Result:
    """kicad-cli ARGS. check=True raises KiCadCliError on a non-zero exit."""
    cmd = [executable(), *map(str, args)]
    try:
        p = subprocess.run(cmd, cwd=str(cwd) if cwd else None, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           timeout=timeout_s)
    except subprocess.TimeoutExpired as e:
        log = (e.stdout or b'').decode(errors='replace')
        raise KiCadCliError(f'kicad-cli {args[:3]} timed out after {timeout_s:g} s', None, log) from None
    except OSError as e:
        raise KiCadCliError(f'kicad-cli could not start: {e}') from None
    res = Result(cmd, p.returncode, p.stdout.decode(errors='replace'))
    if check and p.returncode != 0:
        raise KiCadCliError(f'kicad-cli {" ".join(map(str, args[:3]))} failed (exit {p.returncode})',
                            p.returncode, res.log)
    return res


def _defines(defines: dict[str, str] | None) -> list[str]:
    return [a for k, v in (defines or {}).items() for a in ('-D', f'{k}={v}')]


def _json_report(args: list[str], src: Path, timeout_s: float, defines: dict[str, str] | None) -> dict:
    with tempfile.TemporaryDirectory(prefix='pcbstudio-') as td:
        out = Path(td) / 'report.json'
        res = run([*args, *_defines(defines), '--format', 'json', '--severity-all', '-o', str(out), str(src)],
                  timeout_s=timeout_s, cwd=src.parent)
        if not out.is_file():
            raise KiCadCliError(f'kicad-cli {args[:2]} wrote no report', res.returncode, res.log)
        return json.loads(out.read_text(encoding='utf-8'))


def drc(pcb: str | Path, *, schematic_parity: bool = True, refill_zones: bool = False,
        defines: dict[str, str] | None = None, timeout_s: float = DEFAULT_TIMEOUT_S) -> dict:
    """`pcb drc` JSON report (all severities, mm). Parity on by default: DRC without parity is not evidence."""
    args = ['pcb', 'drc', '--units', 'mm']
    if schematic_parity:
        args.append('--schematic-parity')
    if refill_zones:
        args.append('--refill-zones')
    return _json_report(args, Path(pcb), timeout_s, defines)


def erc(sch: str | Path, *, defines: dict[str, str] | None = None, timeout_s: float = DEFAULT_TIMEOUT_S) -> dict:
    """`sch erc` JSON report (all severities)."""
    return _json_report(['sch', 'erc', '--units', 'mm'], Path(sch), timeout_s, defines)


def netlist(sch: str | Path, out: str | Path, *, fmt: str = 'kicadsexpr',
            timeout_s: float = DEFAULT_TIMEOUT_S) -> Path:
    """`sch export netlist` to OUT; returns OUT."""
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    run(['sch', 'export', 'netlist', '--format', fmt, '-o', str(out), str(sch)], timeout_s=timeout_s,
        cwd=Path(sch).parent)
    return out


def export_glb(pcb: str | Path, out: str | Path, *, defines: dict[str, str] | None = None,
               timeout_s: float = DEFAULT_TIMEOUT_S) -> dict:
    """Binary glTF of the board with part models, tracks, pads, zones, silk and mask. Written to a temp name and
    moved into place, so a failed run never leaves a partial OUT. Returns {path, size, warnings}."""
    pcb, out = Path(pcb), Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix('.tmp.glb')
    res = run(['pcb', 'export', 'glb', '--force', '--subst-models', '--include-tracks', '--include-pads',
               '--include-zones', '--include-silkscreen', '--include-soldermask', '--no-dnp',
               *_defines(defines), '-o', str(tmp), str(pcb)], timeout_s=timeout_s, cwd=pcb.parent, check=False)
    if res.returncode != 0 or not tmp.is_file():
        tmp.unlink(missing_ok=True)
        raise KiCadCliError(f'kicad-cli glb export failed (exit {res.returncode})', res.returncode, res.log)
    tmp.replace(out)
    warnings = [ln for ln in res.log.splitlines() if 'not found' in ln.lower() or 'could not' in ln.lower()]
    return {'path': str(out), 'size': out.stat().st_size, 'warnings': warnings[:30]}
