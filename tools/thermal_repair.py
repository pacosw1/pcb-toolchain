"""Bounded plane-pad copper proposals, accepted only by independent native checks.

Never changes thermal policies, existing copper or parts. A successful proposal
is not qualification: remaining native errors must still pass the final gate.
"""
import collections
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

import lean_workflow as lean


def thermal_targets(drc, pads, zones, planes):
    """Pure detector: native UUID, pad/ref/net and owning zone must all agree."""
    todo = collections.defaultdict(set)
    for v in drc['violations']:
        if v.get('type') != 'starved_thermal' or v.get('severity') != 'error':
            continue
        if (not isinstance(v.get('items'), list) or len(v['items']) != 2 or
                any(not isinstance(i, dict) or not isinstance(i.get('uuid'), str) or
                    not isinstance(i.get('description'), str) for i in v['items'])):
            raise ValueError('malformed native thermal violation')
        found = []
        for item in v.get('items', []):
            row = pads.get(item.get('uuid'))
            if row is None:
                continue
            ref, number, net = row
            match = re.fullmatch(r'Pad (\S+) \[([^\]]*)\] of (\S+) on (.+)', item.get('description', ''))
            if not match or (match[3], match[1], match[2]) != row:
                raise ValueError('native thermal pad identity mismatch')
            if not any(zones.get(i.get('uuid')) == net for i in v.get('items', [])):
                raise ValueError('native thermal zone identity mismatch')
            found.append((net, ref+'.'+number))
        if len(found) != 1:
            raise ValueError('ambiguous native thermal pads')
        net, name = found[0]
        if net in planes:
            todo[net].add(name)
    return {net: sorted(names) for net, names in todo.items()}


def inventory(board):
    return ({p.m_Uuid.AsString(): (f.GetReference(), p.GetNumber(), p.GetNetname())
             for f in board.GetFootprints() for p in f.Pads()},
            {z.m_Uuid.AsString(): z.GetNetname() for z in board.Zones()})


def immutable_board(path, deadline=None):
    """Native save format: compare entire parts, setup, zones and existing tracks.

    Filled polygons are computed evidence, so their contents may change. Zone
    outlines, fill/thermal settings, all pad properties and all setup stay exact.
    """
    # Keep native string tokens intact, including escaping, for exact comparisons.
    text = Path(path).read_text()
    # A linear scanner avoids regex backtracking on large strings/polygon files.
    tokens, index, next_check = [], 0, 0
    def budget():
        nonlocal next_check
        if index >= next_check:
            if deadline is not None and time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired(['native-policy-snapshot', str(path)], 0)
            next_check = index+65536
    while index < len(text):
        budget()
        char = text[index]
        if char.isspace():
            index += 1; continue
        if char in '()':
            tokens.append(char); index += 1; continue
        start = index
        if char == '"':
            index += 1
            while index < len(text):
                budget()
                if text[index] == '\\':
                    index += 2; continue
                if text[index] == '"':
                    index += 1; break
                index += 1
            else:
                raise ValueError('unterminated native string')
        else:
            while index < len(text) and not text[index].isspace() and text[index] not in '()"':
                budget()
                index += 1
        tokens.append(text[start:index])
    stack, current = [], []
    for token in tokens:
        if token == '(':
            stack.append(current); current = []
        elif token == ')':
            node, current = current, stack.pop(); current.append(node)
        else:
            current.append(token)
    if stack or len(current) != 1:
        raise ValueError('malformed native board')
    tree = current[0]
    if not tree or tree[0] != 'kicad_pcb':
        raise ValueError('not a native PCB')
    def tag(x):
        return x[0] if isinstance(x, list) and x else None
    rows = {}
    for node in tree[1:]:
        name = tag(node)
        if name not in ('footprint', 'zone', 'segment', 'arc', 'via', 'setup', 'gr_line', 'gr_arc', 'gr_rect', 'gr_poly'):
            continue
        if name == 'zone':
            node = [x for x in node if tag(x) not in ('filled_polygon', 'fill_segments')]
        uuid = next((x[1] for x in node if tag(x) == 'uuid'), name)
        if (name, uuid) in rows:
            raise ValueError('duplicate native immutable item identity')
        rows[(name, uuid)] = node
    return rows


def copy_hierarchy(source, destination, deadline):
    root = source.parent.resolve()
    pending, seen = [source.with_suffix('.kicad_sch')], set()
    while pending:
        if time.monotonic() >= deadline:
            raise subprocess.TimeoutExpired(['copy-native-hierarchy'], 0)
        sheet = pending.pop().resolve()
        if sheet in seen:
            continue
        if not sheet.is_file() or root not in sheet.parents:
            raise ValueError('schematic hierarchy unavailable or outside source project')
        seen.add(sheet)
        target = destination/sheet.relative_to(root)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(sheet, target)
        for name in re.findall(r'\(property "Sheetfile" "([^"\n]+)"', sheet.read_text()):
            name = name.replace('${KIPRJMOD}', str(root))
            pending.append(sheet.parent/name)
    return sorted(str(p.relative_to(root)) for p in seen)


def errors(drc):
    return collections.Counter((v['type'], tuple(sorted(i.get('uuid', '') for i in v.get('items', []))))
                               for v in drc['violations'] if v.get('severity') == 'error')


def acceptable(before, after, old_board, new_board):
    if any(new_board.get(k) != v for k, v in old_board.items()):
        return False, 'existing copper, parts, setup or zone policies changed'
    additions = set(new_board)-set(old_board)
    if any(k[0] not in ('segment', 'via') for k in additions):
        return False, 'non-copper addition'
    old, new = errors(before), errors(after)
    if new-old:
        return False, 'new native errors'
    if sum(new.values()) >= sum(old.values()):
        return False, 'no native error improvement'
    if len(after.get('schematic_parity', [])) > len(before.get('schematic_parity', [])):
        return False, 'schematic parity regressed'
    if len(after['unconnected_items']) > len(before['unconnected_items']):
        return False, 'native opens regressed'
    return True, 'native errors reduced; policies and existing geometry preserved'


def repair(board_path, project_board, drc, planes, via_args, kicad_cli, event_file, label):
    """Single transaction, <=90 seconds. Retain proposal/evidence on rejection."""
    import pcbnew
    board_path = Path(board_path)
    targets = thermal_targets(drc, *inventory(pcbnew.LoadBoard(str(board_path))), set(planes))
    evidence = dict(targets=targets, accepted=False, qualified=False)
    if not targets:
        return drc, dict(evidence, reason='no plane thermal targets')
    if any(x.split('=', 1)[0] in ('--net', '--only', '--in-pad') for x in via_args):
        return drc, dict(evidence, reason='thermal repair prohibits identity overrides and in-pad vias')
    deadline = min(time.monotonic()+90, float(os.environ.get('IOT_LEAN_DEADLINE', 'inf')))
    directory = Path(tempfile.mkdtemp(prefix=label+'-', dir=board_path.parent))
    source = Path(project_board)
    if not source.with_suffix('.kicad_sch').is_file():
        evidence.update(reason='source schematic unavailable; parity cannot be proven', directory=str(directory))
        lean.atomic_json(directory/'decision.json', evidence)
        return drc, evidence
    candidate = directory/source.name
    # Keep the native project name and complete schematic hierarchy for parity.
    for item in source.parent.iterdir():
        if item.is_file() and item.suffix in ('.kicad_pro', '.kicad_dru', '.kicad_sch', '.kicad_sym'):
            shutil.copy(item, directory/item.name)
        elif item.name in ('blocks', 'BASE.pretty') and item.is_dir():
            shutil.copytree(item, directory/item.name)
    for filename in ('sym-lib-table', 'fp-lib-table'):
        if (source.parent/filename).is_file():
            shutil.copy(source.parent/filename, directory/filename)
    shutil.copy(board_path, candidate)
    def check(name):
        report = directory/(name+'.json')
        result = lean.run_stage([kicad_cli, 'pcb', 'drc', '--refill-zones', '--schematic-parity', '--severity-all',
                                 '--format', 'json', '--units', 'mm', '-o', str(report), str(candidate)],
                                stage=label+'-'+name, event_file=event_file, deadline=deadline,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        (directory/(name+'.log')).write_text(result.stdout+result.stderr)
        if result.returncode or not report.is_file():
            raise ValueError('independent native thermal validation failed')
        checked = lean.validate_drc(json.loads(report.read_text()))
        if not isinstance(checked.get('schematic_parity'), list):
            raise ValueError('native parity evidence unavailable')
        return checked
    try:
        evidence['schematic_files'] = copy_hierarchy(source, directory, deadline)
        sidecars = {str(p.relative_to(directory)): lean.digest(p) for p in directory.rglob('*')
                    if p.is_file() and p.suffix in ('.kicad_pro', '.kicad_dru', '.kicad_sch')}
        old_state = immutable_board(candidate, deadline)
        before = check('before')
        # Refill can change faults; detect against that current native evidence.
        targets = thermal_targets(before, *inventory(pcbnew.LoadBoard(str(candidate))), set(planes))
        evidence['targets'] = targets
        for net, names in targets.items():
            proposal = directory/'proposal.kicad_pcb'
            result = lean.run_stage([sys.executable, str(Path(__file__).with_name('gnd_pad_vias.py')),
                                     str(candidate), str(proposal), '--net', net, '--only', ','.join(names)]+list(via_args),
                                    stage=label+'-copper', event_file=event_file, deadline=deadline,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            with (directory/'repair.log').open('a') as log:
                log.write(result.stdout+result.stderr)
            if result.returncode or not proposal.is_file():
                raise ValueError('thermal copper proposal failed')
            os.replace(proposal, candidate)
        after = check('after')
        if any(lean.digest(directory/path) != digest for path, digest in sidecars.items()):
            raise ValueError('native project, rules or schematic changed during proposal')
        accepted, reason = acceptable(before, after, old_state, immutable_board(candidate, deadline))
        evidence.update(accepted=accepted, reason=reason, directory=str(directory),
                        errors_before=sum(errors(before).values()), errors_after=sum(errors(after).values()),
                        remaining_thermal=sum(v.get('type') == 'starved_thermal' and v.get('severity') == 'error'
                                              for v in after['violations']), board_sha256=lean.digest(candidate))
        if accepted:
            os.replace(candidate, board_path)
            drc = after
    except (ValueError, OSError, subprocess.TimeoutExpired) as error:
        evidence.update(reason=str(error), directory=str(directory))
    lean.atomic_json(directory/'decision.json', evidence)
    if event_file:
        with open(event_file, 'a') as log:
            log.write(json.dumps(dict(stage=label, status='complete', **evidence))+'\n')
    return drc, evidence
