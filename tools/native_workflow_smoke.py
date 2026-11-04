#!/usr/bin/env python3
"""Mandatory pinned native integration corpus. Missing runtimes FAIL, never skip.

All geometry and rules are synthetic fixtures, not board release evidence.
Run native children in fresh processes; preserve every original native report.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid

import lean_owned
import lean_workflow as lean

ROOT = Path(__file__).resolve().parent.parent
PINNED_KICAD = '10.0.6'
CASES = ('baseline_erc_drc_parity_refill', 'placement_transaction', 'routing_import',
         'reject_short', 'reject_clearance', 'reject_pad_net_parity')


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False) + '\n')


def uid(name):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'iot-lab-native-smoke:' + name))


def schematic():
    """Embedded one-pin passive symbols with explicit native instance identities."""
    symbol = '''(symbol "Smoke:TP" (in_bom yes) (on_board yes)
      (property "Reference" "J" (at 0 2.54 0) (effects (font (size 1.27 1.27))))
      (property "Value" "TP" (at 0 -2.54 0) (effects (font (size 1.27 1.27))))
      (property "Footprint" "Smoke:TP" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (symbol "TP_0_1" (rectangle (start 0 -1) (end 2 1)
       (stroke (width 0) (type default)) (fill (type background))))
      (symbol "TP_1_1" (pin passive line (at 0 0 0) (length 2.54)
       (name "P" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))))'''
    rows = [f'(kicad_sch (version 20250114) (generator "eeschema") (uuid "{uid("root")}") (paper "A4")',
            '(lib_symbols ' + symbol + ')']
    for index in range(4):
        ref, net = 'J' + str(index + 1), 'A' if index < 2 else 'B'
        x, y = 50.8 + (index % 2) * 25.4, 50.8 + (index // 2) * 25.4
        rows += [f'''(symbol (lib_id "Smoke:TP") (at {x} {y} 0) (unit 1)
          (in_bom yes) (on_board yes) (dnp no) (uuid "{uid(ref)}")
          (property "Reference" "{ref}" (at {x} {y-3} 0) (effects (font (size 1.27 1.27))))
          (property "Value" "TP" (at {x} {y+3} 0) (effects (font (size 1.27 1.27))))
          (property "Footprint" "Smoke:TP" (at {x} {y} 0) (effects (font (size 1.27 1.27)) (hide yes)))
          (pin "1" (uuid "{uid(ref+"-pin")}"))
          (instances (project "fixture" (path "/{uid('root')}" (reference "{ref}") (unit 1)))))''',
          f'''(label "{net}" (at {x} {y} 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "{uid(ref+'-label')}"))''']
    rows += ['(embedded_fonts no))']
    return '\n'.join(rows)


def generate(folder):
    import pcbnew as p
    if p.Version() != '10.0.6':
        raise ValueError('synthetic native policy defaults require admitted KiCad 10.0.6')
    folder.mkdir(parents=True)
    board = p.BOARD()
    board.SetCopperLayerCount(2)
    point = lambda x, y: p.VECTOR2I(p.FromMM(x), p.FromMM(y))
    nets = {}
    for name in ('/A', '/B'):
        nets[name] = p.NETINFO_ITEM(board, name)
        board.Add(nets[name])
    retained = []
    for index in range(4):
        ref, name = 'J' + str(index + 1), '/A' if index < 2 else '/B'
        x, y = 5 + (index % 2) * 10, 5 + (index // 2) * 10
        footprint = p.FOOTPRINT(board)
        footprint.SetReference(ref)
        footprint.SetValue('TP')
        footprint.SetFPID(p.LIB_ID('Smoke', 'TP'))
        footprint.SetPosition(point(x, y))
        footprint.SetPath(p.KIID_PATH('/' + uid(ref)))
        board.Add(footprint)
        pad = p.PAD(footprint)
        pad.SetNumber('1')
        pad.SetAttribute(p.PAD_ATTRIB_SMD)
        pad.SetShape(p.PAD_SHAPE_RECT)
        pad.SetSize(point(.8, .8))
        pad.SetPosition(point(x, y))
        layers = p.LSET()
        for layer in (p.F_Cu, p.F_Paste, p.F_Mask):
            layers.AddLayer(layer)
        pad.SetLayerSet(layers)
        pad.SetNet(nets[name])
        footprint.Add(pad)
        retained.extend((footprint, pad))
    for name, y in (('/A', 5), ('/B', 15)):
        track = p.PCB_TRACK(board)
        track.SetStart(point(5, y))
        track.SetEnd(point(15, y))
        track.SetWidth(p.FromMM(.25))
        track.SetLayer(p.F_Cu)
        track.SetNet(nets[name])
        board.Add(track)
        retained.append(track)
    edge = p.PCB_SHAPE(board)
    edge.SetShape(p.SHAPE_T_RECT)
    edge.SetStart(point(0, 0))
    edge.SetEnd(point(20, 20))
    edge.SetLayer(p.Edge_Cuts)
    edge.SetWidth(p.FromMM(.05))
    board.Add(edge)
    zone = p.ZONE(board)
    zone.SetLayer(p.F_Cu)
    zone.SetNet(nets['/B'])
    zone.SetLocalClearance(p.FromMM(.2))
    zone.SetPadConnection(p.ZONE_CONNECTION_FULL)
    zone.Outline().NewOutline()
    for x, y in ((3, 12), (17, 12), (17, 18), (3, 18)):
        zone.Outline().Append(int(p.FromMM(x)), int(p.FromMM(y)))
    board.Add(zone)
    p.SaveBoard(str(folder / 'fixture.kicad_pcb'), board)
    (folder / 'fixture.kicad_sch').write_text(schematic())
    # Fixture policy is explicit in native project data; it is not a threshold
    # for any production board or manufacturing process.
    rules = dict(min_clearance=.2, min_track_width=.2, min_via_diameter=.6,
                 min_via_annular_width=.15, min_hole_clearance=.25,
                 min_hole_to_hole=.25, min_copper_edge_clearance=.2)
    # Project-rule admission must not infer absent fields as zero. Read the
    # actual pinned native defaults and emit them explicitly, with attribution.
    settings = board.GetDesignSettings()
    defaults = {}
    for name, member in (('min_connection', 'm_MinConn'),
                         ('solder_mask_to_copper_clearance', 'm_SolderMaskToCopperClearance')):
        value = getattr(settings, member)
        if type(value) is not int or value < 0:
            raise ValueError('native fixture default is unresolved: ' + member)
        defaults[name] = dict(member=member, raw_iu=value, mm=p.ToMM(value))
        rules[name] = defaults[name]['mm']
    write(folder / 'fixture-native-defaults.json', dict(
        schema='iot-lab.synthetic-native-project-defaults.v1', native_version=p.Version(),
        fields=defaults, source='actual new BOARD design settings; explicit fixture policy, not a production requirement',
        primary_sources=[dict(
            url='https://gitlab.com/kicad/code/kicad/-/raw/10.0.6/include/board_design_settings.h',
            sha256='c48d122eee792289e3e677713c824ea229a9c6adb4091b57787e5987a05902b6'), dict(
            url='https://gitlab.com/kicad/code/kicad/-/raw/10.0.6/pcbnew/board_design_settings.cpp',
            sha256='d21742c98036a6b64b4fff48d15f02a724f85efc337b78f26ff7f9558aedd217')] ))
    write(folder / 'fixture.kicad_pro', dict(meta=dict(filename='fixture.kicad_pro', version=1),
          board=dict(design_settings=dict(rules=rules)), net_settings=dict(classes=[dict(name='Default',
          clearance=.2, track_width=.25, via_diameter=.6, via_drill=.3)], meta=dict(version=4))))
    (folder / 'fixture.kicad_dru').write_text('(version 1)\n')


def worker(mode, source, target=None):
    import pcbnew as p
    from pcb_search.native_srj import source_set
    if mode == 'generate':
        generate(source)
        return
    board = p.LoadBoard(str(source))
    if mode == 'filled':
        counts = [z.GetFilledPolysList(p.F_Cu).OutlineCount() for z in board.Zones()]
        if not counts or not all(count > 0 for count in counts):
            raise ValueError('native refill did not save filled zone polygons')
        write(target, dict(filled_outline_counts=counts, board_sha256=sha(source)))
        return
    before = source_set(source)
    target.mkdir(parents=True)
    out = target / 'candidate.kicad_pcb'
    if mode == 'move':
        fp = next(fp for fp in board.GetFootprints() if fp.GetReference() == 'J2')
        fp.Move(p.VECTOR2I(-p.FromMM(1), 0))
    elif mode == 'parity':
        fp = next(fp for fp in board.GetFootprints() if fp.GetReference() == 'J1')
        next(iter(fp.Pads())).SetNet(board.GetNetsByName()['/B'])
    elif mode in ('short', 'clearance'):
        track = p.PCB_TRACK(board)
        a, b = ((10, 5), (10, 15)) if mode == 'short' else ((7, 14.7), (13, 14.7))
        track.SetStart(p.VECTOR2I(p.FromMM(a[0]), p.FromMM(a[1])))
        track.SetEnd(p.VECTOR2I(p.FromMM(b[0]), p.FromMM(b[1])))
        track.SetWidth(p.FromMM(.25))
        track.SetLayer(p.F_Cu)
        track.SetNet(board.GetNetsByName()['/A'])
        board.Add(track)
    else:
        raise ValueError('unknown native worker operation')
    p.SaveBoard(str(out), board)
    for extension in ('.kicad_sch', '.kicad_pro', '.kicad_dru'):
        shutil.copy2(source.with_suffix(extension), out.with_suffix(extension))
    if source_set(source) != before:
        raise ValueError('native transaction mutated its source')
    if mode == 'move':
        from pcb_search.native_placement import verify_preserved
        units = [dict(name='J'+str(i+1), refs=['J'+str(i+1)], x=5+(i%2)*10,
                      y=5+(i//2)*10, fixed=i != 1) for i in range(4)]
        pose = [[unit['x']-(1 if i == 1 else 0), unit['y'], 0] for i, unit in enumerate(units)]
        changed, protected = verify_preserved(source, out, dict(units=units), pose)
        if changed != ['J2']:
            raise ValueError('placement transaction did not move exactly J2')
        from pcb_operations import pcb_identity
        if pcb_identity(source) != pcb_identity(out):
            raise ValueError('production transaction identity rejects the legal native placement')
        write(target / 'transaction.json', dict(moved_refs=changed, protected_sha256=protected,
              production_identity_preserved=True, source_inputs=before, output_inputs=source_set(out)))


def drc_counts(path):
    value = json.loads(Path(path).read_text())
    for key in ('violations', 'schematic_parity', 'unconnected_items'):
        if not isinstance(value.get(key), list):
            raise ValueError('incomplete native report: ' + key)
    return dict(errors=sum(v['severity'] == 'error' for v in value['violations']),
                warnings=sum(v['severity'] == 'warning' for v in value['violations']),
                parity=len(value['schematic_parity']), unconnected=len(value['unconnected_items']),
                error_types=sorted({v['type'] for v in value['violations'] if v['severity'] == 'error'}))


def require_case(case, counts):
    if case == 'reject_pad_net_parity':
        passed = counts['parity'] > 0
    elif case == 'reject_clearance':
        passed = counts['errors'] > 0 and 'clearance' in counts['error_types']
    elif case == 'reject_short':
        # KiCad 10.0.6 reports the fixture's /A and /B F.Cu intersection as
        # tracks_crossing. Original native report items identify both nets.
        passed = counts['errors'] > 0 and any('short' in name or name == 'tracks_crossing' for name in counts['error_types'])
    else:
        passed = not any(counts[key] for key in ('errors', 'parity', 'unconnected'))
    if not passed:
        raise ValueError(case + ': native report does not prove expected outcome: ' + json.dumps(counts))


def run(args):
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    deadline = lean.deadline_after(args.timeout, {})
    summary = dict(schema='iot-lab.native-workflow-smoke.v1', status='failed', expected_cases=list(CASES),
                   cases=[], skipped=0, scope='synthetic native workflow integration; no board qualification',
                   source_inputs={str(path.relative_to(ROOT)): sha(path) for path in
                       [Path(__file__).resolve(), *sorted(p for p in (ROOT / 'tools/pcb_search').glob('*.py') if not p.name.startswith('.')),
                        ROOT / 'tools/placer/dru.py', ROOT / 'tools/placer/__init__.py', ROOT / 'tools/lean_owned.py',
                        ROOT / 'tools/lean_owned_exec.py', ROOT / 'tools/lean_workflow.py', ROOT / 'tools/blocks.py',
                        ROOT / 'tools/block_reuse.py', ROOT / 'tools/block_extract.py',
                        ROOT / 'tools/pcb_operations.py', ROOT / 'tools/pcb_workflow.py']})
    counter = 0

    def invoke(label, command):
        nonlocal counter
        counter += 1
        print('START: ' + label, file=sys.stderr, flush=True)
        log = output / f'{counter:02d}-{label}.log'
        proc, cleanup = None, None
        try:
            with log.open('wb') as stream:
                proc = lean_owned.prepare(command, dict(cwd=ROOT / 'tools', env=dict(os.environ),
                                          stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT))
                proc.start()
                proc.activate()
                heartbeat = time.monotonic()
                while True:
                    if lean.remaining(deadline) <= 0:
                        raise TimeoutError('native corpus total deadline reached')
                    try:
                        proc.communicate(timeout=min(.1, lean.remaining(deadline)))
                        cleanup = proc.last_cleanup
                        break
                    except subprocess.TimeoutExpired:
                        if time.monotonic() - heartbeat >= 5:
                            print('ALIVE: ' + label + '; progress unknown', file=sys.stderr, flush=True)
                            heartbeat = time.monotonic()
        finally:
            if proc:
                cleanup = cleanup if cleanup is not None else proc.cleanup()
                if not proc.close() or not cleanup.get('complete'):
                    raise ValueError(label + ': owned cleanup unconfirmed')
        if proc.returncode:
            raise ValueError(f'{label}: invocation exited {proc.returncode}; evidence={log}')
        return log

    def check(case, board):
        report = output / (case + '.json')
        command = [args.cli, 'pcb', 'drc', '--schematic-parity', '--refill-zones', '--severity-all',
                   '--format', 'json', '--units', 'mm', '-o', str(report), str(board)]
        if case == CASES[0]:
            command.insert(5, '--save-board')
        invoke(case, command)
        counts = drc_counts(report)
        require_case(case, counts)
        if case == CASES[0]:
            invoke('verify-refill', [args.python, script, '_worker', 'filled', str(board), str(output / 'zone-fill.json')])
        summary['cases'].append(dict(case=case, status='passed', command=command, report=str(report),
                                     report_sha256=sha(report), counts=counts))
        print('PASS: ' + case, file=sys.stderr, flush=True)

    try:
        for key, binary in (('cli', args.cli), ('python', args.python)):
            resolved = shutil.which(binary)
            if not resolved:
                raise ValueError('required native runtime missing: ' + binary)
            setattr(args, key, str(Path(resolved).resolve()))
        version_log = invoke('cli-version', [args.cli, '--version'])
        version = version_log.read_text().strip()
        python_log = invoke('pcbnew-version', [args.python, '-c',
            'import pcbnew,sys,json; native=sys.modules.get("_pcbnew"); '
            'print(json.dumps(dict(version=pcbnew.Version(),wrapper=pcbnew.__file__,native=getattr(native,"__file__",None))))'])
        pcb_runtime = json.loads(python_log.read_text())
        pcb_version = pcb_runtime['version']
        if version != args.expected_version or pcb_version != args.expected_version:
            raise ValueError(f'pinned native runtime mismatch: CLI={version}, pcbnew={pcb_version}, expected={args.expected_version}')
        summary['tools'] = dict(kicad_cli=dict(path=args.cli, version=version, sha256=sha(args.cli)),
                                kicad_python=dict(path=args.python, pcbnew_version=pcb_version, sha256=sha(args.python),
                                    modules={key: dict(path=pcb_runtime[key], sha256=sha(pcb_runtime[key])) for key in ('wrapper', 'native')}))
        script = str(Path(__file__).resolve())
        fixture = output / 'fixture'
        invoke('generate-fixture', [args.python, script, '_worker', 'generate', str(fixture)])
        board = fixture / 'fixture.kicad_pcb'
        erc = output / 'erc.json'
        invoke('erc', [args.cli, 'sch', 'erc', '--format', 'json', '--severity-all', '-o', str(erc), str(board.with_suffix('.kicad_sch'))])
        sheets = json.loads(erc.read_text()).get('sheets', [])
        if not sheets or any(v['severity'] == 'error' for sheet in sheets for v in sheet['violations']):
            raise ValueError('baseline native ERC not clean; inspect original erc.json')
        check(CASES[0], board)
        from pcb_search.native_srj import source_set
        baseline = source_set(board)
        invoke('placement-import', [args.python, script, '_worker', 'move', str(board), str(output / 'placement')])
        check('placement_transaction', output / 'placement/candidate.kicad_pcb')
        export = output / 'route-export'
        invoke('route-export', [args.python, '-m', 'pcb_search.native_srj', 'export', str(board), str(export), '--net', '/A'])
        from pcb_search.contracts import fingerprint
        srj = json.loads((export / 'srj.json').read_text())
        trace = dict(type='pcb_trace', pcb_trace_id='smoke-restored-A', connection_name='/A',
                     route=[dict(route_type='wire', x=x, y=5, layer='top', width=.25) for x in (5, 15)])
        proposal = dict(status='candidate', qualified=False, input_sha256=fingerprint(srj), output=dict(srj, traces=srj['traces']+[trace]))
        write(output / 'route-proposal.json', proposal)
        invoke('route-import', [args.python, '-m', 'pcb_search.native_srj', 'import', str(export), str(output / 'route-proposal.json'), str(output / 'routing')])
        record = json.loads((output / 'routing/record.json').read_text())
        if record.get('added') != 1:
            raise ValueError('routing import did not add the requested native segment')
        check('routing_import', output / 'routing/candidate.kicad_pcb')
        for mode, case in (('short', 'reject_short'), ('clearance', 'reject_clearance'), ('parity', 'reject_pad_net_parity')):
            invoke('inject-' + mode, [args.python, script, '_worker', mode, str(board), str(output / mode)])
            check(case, output / mode / 'candidate.kicad_pcb')
        if source_set(board) != baseline or {r['case'] for r in summary['cases']} != set(CASES):
            raise ValueError('source mutated or mandatory native cases did not all run')
        if any(sha(ROOT / name) != expected for name, expected in summary['source_inputs'].items()):
            raise ValueError('workflow implementation changed during native corpus')
        summary.update(status='passed', cause='all mandatory native cases executed and proved; zero skips', baseline_inputs=baseline)
    except (ValueError, OSError, RuntimeError, subprocess.SubprocessError, KeyError, TypeError) as error:
        summary['cause'] = str(error)
    finally:
        summary['elapsed_s'] = round(time.monotonic() - started, 3)
        summary['artifacts'] = {str(path.relative_to(output)): sha(path) for path in sorted(output.rglob('*')) if path.is_file()}
        write(output / 'summary.json', summary)
    return summary


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    if argv and argv[0] == '_worker':
        worker(argv[1], Path(argv[2]).resolve(), Path(argv[3]).resolve() if len(argv) > 3 else None)
        return 0
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--cli', default=os.environ.get('KICAD_CLI', 'kicad-cli'))
    parser.add_argument('--python', default=os.environ.get('KICAD_PYTHON', sys.executable))
    parser.add_argument('--expected-version', default=PINNED_KICAD)
    parser.add_argument('--timeout', type=float, default=180)
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error('--timeout must be finite and positive')
    try:
        result = run(args)
    except OSError as error:
        print('FAIL: ' + str(error), file=sys.stderr)
        return 2
    print(json.dumps(result) if args.json else ('PASS: ' if result['status'] == 'passed' else 'FAIL: ') + result['cause'])
    return 0 if result['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
