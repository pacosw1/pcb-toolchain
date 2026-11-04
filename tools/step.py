#!/usr/bin/env python3
"""step: snapshot a board before an agent step, check it after, roll it back on a failure.

  python3 tools/step.py begin    BOARD                 record HEAD, the board files (git blobs) and a DRC baseline
  python3 tools/step.py check    BOARD [--gate CMD]    DRC on a project copy (+ gate); exit 1 if worse than begin
  python3 tools/step.py rollback BOARD                 write the board files back to the begin state

BOARD is the .kicad_pcb or its project folder. The board files are the *.kicad_pcb, *.kicad_sch, *.kicad_pro
and *.kicad_dru files of that folder. begin stores each one as a git blob (git hash-object -w), so rollback
restores the begin state also when it was not committed. rollback writes only those files: it does not touch
other paths, the index or HEAD. The state is in <git dir>/pcbtool-step/.

check fails when: DRC has an error that the begin DRC did not have, the unconnected or the parity count is
higher than at begin, or the gate command exits non-zero. DRC: kicad-cli pcb drc --schematic-parity
--refill-zones on a temporary copy of the project folder (the board is not changed).
Idea from copperheadhq/copperhead (Apache-2.0), src/util/git.js snapshot/restore.
"""
import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile

KICAD_CLI = os.environ.get('STEP_KICAD_CLI', '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli')
PATTERNS = ('*.kicad_pcb', '*.kicad_sch', '*.kicad_pro', '*.kicad_dru')


def git(*args, cwd=None, data=None):
    r = subprocess.run(['git', *args], cwd=cwd, capture_output=True, input=data, check=False)
    if r.returncode:
        sys.exit(f"git {' '.join(args)}: {r.stderr.decode().strip()}")
    return r.stdout


def board_paths(board):
    """(project folder, .kicad_pcb path)."""
    board = os.path.abspath(board)
    if os.path.isdir(board):
        pcbs = glob.glob(os.path.join(board, '*.kicad_pcb'))
        if len(pcbs) != 1:
            sys.exit(f'{board}: expected one .kicad_pcb, found {len(pcbs)}')
        return board, pcbs[0]
    if not board.endswith('.kicad_pcb') or not os.path.exists(board):
        sys.exit(f'not a .kicad_pcb or a project folder: {board}')
    return os.path.dirname(board), board


def board_files(proj):
    return sorted(f for pat in PATTERNS for f in glob.glob(os.path.join(proj, pat)))


def state_path(proj):
    top = git('rev-parse', '--show-toplevel', cwd=proj).decode().strip()
    gdir = os.path.join(proj, git('rev-parse', '--git-dir', cwd=proj).decode().strip())
    name = os.path.relpath(proj, top).replace(os.sep, '__')
    return os.path.join(gdir, 'pcbtool-step', name + '.json')


def error_key(v):
    return f"{v['type']}: " + ' | '.join(i['description'] for i in v['items'])


def drc_state(d):
    """Error keys (sorted), unconnected count and parity count of a kicad-cli DRC JSON report."""
    errors = sorted(error_key(v) for v in d.get('violations', []) if v.get('severity') == 'error')
    return {'errors': errors, 'unconnected': len(d.get('unconnected_items', [])),
            'parity': len(d.get('schematic_parity', []))}


def verdict(base, now):
    """Reasons (lines) why now is worse than base. Empty = not worse."""
    out = [f'new DRC error {e}' for e in sorted(set(now['errors']) - set(base['errors']))]
    for k in ('unconnected', 'parity'):
        if now[k] > base[k]:
            out.append(f'{k} {base[k]} -> {now[k]}')
    return out


def run_drc(proj, pcb):
    with tempfile.TemporaryDirectory() as d:
        copy = os.path.join(d, os.path.basename(proj))
        shutil.copytree(proj, copy, ignore=shutil.ignore_patterns('*.lck', '*.step', '*.stp', '*.wrl', '*-backups'))
        out = os.path.join(d, 'drc.json')
        subprocess.run([KICAD_CLI, 'pcb', 'drc', '--schematic-parity', '--refill-zones', '--format', 'json', '-o', out,
                        os.path.join(copy, os.path.basename(pcb))],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        if not os.path.exists(out):
            sys.exit('kicad-cli pcb drc wrote no report')
        with open(out) as f:
            return drc_state(json.load(f))


def summary(s):
    return f"{len(s['errors'])} errors, {s['unconnected']} unconnected, {s['parity']} parity"


def cmd_begin(a):
    proj, pcb = board_paths(a.board)
    files = {os.path.basename(f): git('hash-object', '-w', f, cwd=proj).decode().strip() for f in board_files(proj)}
    head = git('rev-parse', 'HEAD', cwd=proj).decode().strip()
    drc = run_drc(proj, pcb)
    path = state_path(proj)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump({'proj': proj, 'head': head, 'files': files, 'drc': drc}, f, indent=1)
    print(f'begin: HEAD {head[:10]}, {len(files)} board files, DRC {summary(drc)}')


def load_state(proj):
    path = state_path(proj)
    if not os.path.exists(path):
        sys.exit(f'no begin state for {proj}: run step.py begin first')
    with open(path) as f:
        return json.load(f)


def cmd_check(a):
    proj, pcb = board_paths(a.board)
    st = load_state(proj)
    now = run_drc(proj, pcb)
    bad = verdict(st['drc'], now)
    gate = ''
    if a.gate:
        code = subprocess.run(a.gate, shell=True, cwd=proj, check=False).returncode
        gate = f'; gate exit {code}'
        if code:
            bad.append(f'gate exit {code}: {a.gate}')
    print(f"check: DRC {summary(now)} (begin {summary(st['drc'])}){gate} -> {'FAIL' if bad else 'PASS'}")
    for line in bad[:8]:
        print('  ' + line[:200])
    if len(bad) > 8:
        print(f'  ... {len(bad) - 8} more reasons, not shown')
    sys.exit(1 if bad else 0)


def cmd_rollback(a):
    proj, _ = board_paths(a.board)
    st = load_state(proj)
    changed = []
    for name, blob in sorted(st['files'].items()):
        path = os.path.join(proj, name)
        data = git('cat-file', 'blob', blob, cwd=proj)
        if not os.path.exists(path) or open(path, 'rb').read() != data:
            with open(path, 'wb') as f:
                f.write(data)
            changed.append(name)
    new = [os.path.basename(f) for f in board_files(proj) if os.path.basename(f) not in st['files']]
    head = git('rev-parse', 'HEAD', cwd=proj).decode().strip()
    print(f"restored {len(changed)} files{': ' + ', '.join(changed) if changed else ''}")
    if new:
        print('new since begin, kept: ' + ', '.join(new))
    if head != st['head']:
        print(f"note: HEAD moved {st['head'][:10]} -> {head[:10]} since begin; the files are at the begin state")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest='cmd', required=True)
    for name, f in (('begin', cmd_begin), ('check', cmd_check), ('rollback', cmd_rollback)):
        s = sp.add_parser(name)
        s.add_argument('board')
        s.set_defaults(f=f)
        if name == 'check':
            s.add_argument('--gate', help='shell command run in the project folder; non-zero exit = FAIL')
    a = ap.parse_args()
    a.f(a)


if __name__ == '__main__':
    main()
