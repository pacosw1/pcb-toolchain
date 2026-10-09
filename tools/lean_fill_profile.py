#!/usr/bin/env python3
"""Measure repeated native fill/DRC work on private copies; never skip gates."""
import argparse
import hashlib
import json
import os
import platform
from pathlib import Path
import shutil
import subprocess
import time

import pcbnew


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def findings(report):
    # KiCad report date/path are provenance, not findings. Preserve all violation,
    # parity and connectivity fields; list order can change after a refill.
    return {key: sorted((json.dumps(item, sort_keys=True) for item in report.get(key, [])))
            for key in ('violations', 'unconnected_items', 'schematic_parity')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('board', type=Path)
    parser.add_argument('out', type=Path)
    parser.add_argument('--repeats', type=int, default=3)
    args = parser.parse_args()
    if not 1 <= args.repeats <= 5:
        parser.error('repeats must be 1..5')
    args.out.mkdir(parents=True, exist_ok=False)
    source_hash = digest(args.board)
    board = args.out / args.board.name
    for suffix in ('.kicad_pcb', '.kicad_pro', '.kicad_dru', '.kicad_sch'):
        source = args.board.with_suffix(suffix)
        if source.exists():
            shutil.copy2(source, board.with_suffix(suffix))
    start = time.monotonic()
    b = pcbnew.LoadBoard(str(board))
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    pcbnew.SaveBoard(str(board), b)
    fill_seconds = time.monotonic() - start
    saved_hash = digest(board)
    cli = os.environ.get('KICAD_CLI', '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli')
    samples = []
    for repeat in range(args.repeats):
        for refill in ((False, True) if repeat % 2 == 0 else (True, False)):
            output = args.out / ('drc-%d-%s.json' % (repeat, refill))
            command = [cli, 'pcb', 'drc', '--severity-all', '--format', 'json', '--units', 'mm', '-o', str(output)]
            if refill:
                command.append('--refill-zones')
            command.append(str(board))
            start = time.monotonic()
            result = subprocess.run(command, capture_output=True, text=True, timeout=60)
            if result.returncode:
                raise RuntimeError(result.stderr)
            report = json.loads(output.read_text())
            if not isinstance(report.get('violations'), list) or not isinstance(report.get('unconnected_items'), list):
                raise RuntimeError('native DRC schema missing')
            samples.append({'repeat': repeat, 'refill': refill, 'seconds': time.monotonic() - start,
                            'findings': findings(report), 'report': output.name})
    equivalent = all(s['findings'] == samples[0]['findings'] for s in samples)
    result = {'input_sha256': source_hash, 'input_unchanged': digest(args.board) == source_hash,
              'python': platform.python_version(), 'machine': platform.machine(),
              'kicad_cli_sha256': digest(cli), 'script_sha256': digest(__file__),
              'kicad_version': subprocess.run([cli, 'version'], capture_output=True, text=True, check=True).stdout.strip(),
              'saved_board_sha256': saved_hash, 'saved_board_unchanged': digest(board) == saved_hash,
              'fill_seconds': fill_seconds, 'samples': samples, 'equivalent': equivalent,
              'qualified': False, 'adoption': False}
    (args.out / 'profile.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({k: v for k, v in result.items() if k != 'samples'}))
    print([(s['refill'], round(s['seconds'], 3)) for s in samples])


if __name__ == '__main__':
    main()
