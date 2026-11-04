import os
import re
import stat
from pathlib import Path

import pytest

from pcbstudio.kicad import cli

SRC = Path(__file__).resolve().parents[1] / 'src'
CORPUS = Path(os.environ.get('PCBSTUDIO_CORPUS', '/Users/pacosw/code/iot-lab'))
SMALL = CORPUS / 'hardware-design/boards/CHECKIN-FRONT/cad/CHECKIN-FRONT/CHECKIN-FRONT.kicad_pcb'


def test_only_cli_module_calls_kicad_cli():
    hits = [f'{p.relative_to(SRC)}:{i}' for p in SRC.rglob('*.py') if p.name != 'cli.py'
            for i, ln in enumerate(p.read_text().splitlines(), 1) if 'kicad-cli' in ln]
    assert not hits


def _fake(tmp_path, body: str) -> str:
    exe = tmp_path / 'kicad-cli'
    exe.write_text('#!/bin/sh\n' + body + '\n')
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    return str(exe)


def test_env_override_timeout_and_failure(tmp_path, monkeypatch):
    monkeypatch.setenv('PCBSTUDIO_KICAD_CLI', _fake(tmp_path, 'if [ "$1" = version ]; then echo 9.9.9; exit 0; fi\n'
                                                             'if [ "$1" = sleep ]; then sleep 5; fi\necho boom; exit 2'))
    assert cli.find() == str(tmp_path / 'kicad-cli')
    assert cli.version() == '9.9.9'
    with pytest.raises(cli.KiCadCliError, match='timed out'):
        cli.run(['sleep'], timeout_s=0.5)
    with pytest.raises(cli.KiCadCliError, match='exit 2') as e:
        cli.run(['pcb', 'drc'])
    assert e.value.returncode == 2 and 'boom' in e.value.log
    assert cli.run(['x'], check=False).returncode == 2


def test_missing_executable(monkeypatch, tmp_path):
    monkeypatch.setenv('PCBSTUDIO_KICAD_CLI', str(tmp_path / 'nope'))
    assert cli.find() is None and cli.version() is None
    with pytest.raises(cli.KiCadCliError, match='not found'):
        cli.run(['version'])


@pytest.mark.skipif(not cli.find() or not SMALL.is_file(), reason='kicad-cli or corpus board missing')
def test_real_version_and_drc_json():
    assert re.match(r'\d+\.\d+', cli.version() or '')
    rep = cli.drc(SMALL, schematic_parity=False, timeout_s=120)
    assert 'violations' in rep and 'unconnected_items' in rep
